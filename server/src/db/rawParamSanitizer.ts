/**
 * DEF-252 / DEF-289 / DEF-085 — text Postgres cannot represent, stopped before
 * it becomes a query parameter.
 *
 * WHAT WAS ACTUALLY WRONG, measured this session rather than supposed. SQLSTATE
 * `22021` has been raised on this box roughly every 90 seconds since at least
 * 2026-08-07 — 77,123 occurrences by 08-17, then 96,869 on 08-26, 137,382 on
 * 08-27, ~200k/day and rising. It was filed three times (DEF-085 "cause
 * unknown", DEF-252 "not diagnosed", DEF-289 "not diagnosed from code") and
 * never closed, because each round added attribution instead of a cause.
 *
 * The cause is one character. Reproduced against the live database:
 *
 *     'Sat' + U+0000 + 'ori'  ->  22021, invalid byte sequence for encoding UTF8: 0x00
 *     'Satori'                ->  OK
 *     'Satori' + an emoji     ->  OK        (emoji were never the problem)
 *
 * Both attributed call sites — `conceptSynthesizerService.ts:97` and `:385` —
 * run clean against live data with clean parameters, so it was never the SQL,
 * the stored rows, or the jsonb (a U+0000 escape inside jsonb raises 22P05, a
 * different code). It is a NUL arriving in a bind parameter, from text extracted
 * out in the world: e-mail bodies, PDFs, transcripts.
 *
 * WHY REMOVING IT IS NOT DATA LOSS. Postgres `text` cannot store U+0000 at all —
 * there is no encoding of it the server will accept. So a NUL in a parameter has
 * exactly two possible fates: dropped here, or the whole query fails. Today it
 * takes the second, which loses the entire result rather than one unstorable
 * character. Lone surrogates are the same case: unpaired UTF-16 halves have no
 * valid UTF-8 encoding, and they failed the same live probe.
 *
 * WHY IT IS A SEPARATE MODULE FROM THE OBSERVER. `rawQueryObservability` states
 * as its own contract that it never alters the behaviour it watches — "a monitor
 * that alters the behaviour it monitors is a defect generator". That is right,
 * and this changes parameters, so it does not belong inside it. Same chokepoint,
 * declared separately, so reading `db/prisma.ts` shows both and confuses neither.
 *
 * WHY THE CHOKEPOINT AND NOT THE TWO CALL SITES. ~450 raw call sites exist and
 * any of them can be handed extracted text. Fixing the two that happen to be
 * attributed today is the `protection-with-two-implementations` shape recorded
 * ten times in this codebase: the sites nobody remembered stay broken while the
 * guard reads as complete.
 *
 * PARAMETER VALUES ARE NEVER LOGGED. They carry WhatsApp bodies, addresses and
 * contact names. Only a count is reported, which is what says whether upstream
 * is still producing them.
 */
import createLogger from '../utils/logger';

const log = createLogger('raw-param-sanitizer');

/**
 * U+0000, which `text` has no representation for, and unpaired UTF-16 halves,
 * which have no valid UTF-8 encoding.
 *
 * The NUL pattern is BUILT from its code point rather than written as a literal.
 * A literal NUL in source is invisible — it looks like nothing at all in every
 * editor and diff — so the next reader would see `/ /g` and reasonably conclude
 * this strips spaces.
 */
const NUL = new RegExp(String.fromCharCode(0), 'g');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replaces a lone surrogate rather than dropping it: it stood for a real
 *  character that arrived truncated, and U+FFFD is what that means. A NUL stood
 *  for nothing, so it is simply gone. */
const REPLACEMENT = '�';

export interface SanitizeOutcome<T> { value: T; stripped: number; }

/** Sanitize one value. Non-strings are returned by identity — no cloning, no
 *  coercion, nothing that could change how the driver binds them. */
export function sanitizeRawParam<T>(value: T): SanitizeOutcome<T> {
  if (typeof value !== 'string') return { value, stripped: 0 };
  const nuls = (value.match(NUL) ?? []).length;
  const lone = (value.match(LONE_SURROGATE) ?? []).length;
  if (nuls === 0 && lone === 0) return { value, stripped: 0 };
  const cleaned = value.replace(NUL, '').replace(LONE_SURROGATE, REPLACEMENT);
  return { value: cleaned as unknown as T, stripped: nuls + lone };
}

/**
 * Sanitize a raw call's argument list, in every shape the four operations use.
 *
 * The `Unsafe` variants pass the statement first and its parameters after, so
 * index 0 is left alone: a NUL in the statement TEXT would be a different bug,
 * and silently editing SQL is not a thing this should do. The tagged-template
 * variants pass one object carrying its bind values in `values`.
 *
 * Returns the original array by identity when nothing needed changing, so the
 * overwhelmingly common case adds no allocation and cannot perturb anything.
 */
export function sanitizeRawArgs(args: unknown[]): SanitizeOutcome<unknown[]> {
  let stripped = 0;
  let out: unknown[] | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (i === 0 && typeof arg === 'string') continue;   // the statement itself

    if (typeof arg === 'string') {
      const r = sanitizeRawParam(arg);
      if (r.stripped > 0) {
        out = out ?? [...args];
        out[i] = r.value;
        stripped += r.stripped;
      }
      continue;
    }

    // A tagged-template `Sql` object: its bind values live in `values`.
    const values = (arg as any)?.values;
    if (Array.isArray(values)) {
      let touched = false;
      const nextValues = values.map((v) => {
        const r = sanitizeRawParam(v);
        if (r.stripped > 0) { touched = true; stripped += r.stripped; }
        return r.value;
      });
      if (touched) {
        out = out ?? [...args];
        // Mutating in place is deliberate: Prisma reads `values` off this same
        // object when it builds the statement, so a sanitized copy of the
        // wrapper would be ignored and the NUL would reach the server anyway.
        (arg as any).values = nextValues;
        out[i] = arg;
      }
    }
  }

  if (stripped === 0) return { value: args, stripped: 0 };
  return { value: out ?? args, stripped };
}

/**
 * Install at the same place the observers go, and AFTER them, so a failure that
 * is not about unrepresentable text still reaches the observer unchanged.
 *
 * Returns how many operations were actually wrapped, and the read-back check is
 * there for the same reason the observer's is: an extended client is a Proxy,
 * and an assignment that silently does not take would leave this installed in
 * name only.
 */
export function installRawParamSanitizers(
  client: Record<string, any>,
  operations: readonly string[],
): number {
  let wrapped = 0;
  for (const op of operations) {
    const original = client[op];
    if (typeof original !== 'function') continue;
    const bound = original.bind(client);
    try {
      client[op] = (...args: unknown[]) => {
        const r = sanitizeRawArgs(args);
        if (r.stripped > 0) {
          // Count only. Never the values.
          log.warn('stripped text Postgres cannot represent from a raw parameter', {
            operation: op, characters: r.stripped,
          });
        }
        return bound(...(r.value as unknown[]));
      };
      if (client[op] !== bound && client[op].length === 0) wrapped += 1;
    } catch {
      /* counted as not wrapped */
    }
  }
  return wrapped;
}
