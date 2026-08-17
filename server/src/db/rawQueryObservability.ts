/**
 * DEF-085 / Self-Healing rung 1 — make a failing raw query say who it is.
 *
 * THE PROBLEM THIS EXISTS FOR, measured rather than supposed. A raw query has
 * been failing on this box every ~90 seconds since at least 2026-08-07:
 * `Raw query failed. Code: 22021 — invalid byte sequence for encoding "UTF8"`.
 * 77,123 occurrences between 2026-07-16 and 2026-08-17, 45 of them in the ten
 * minutes after the D-27 restart. DEF-085 has been OPEN that whole time with
 * "cause unknown", and the reason is not that nobody looked — it is that the
 * log line carries NO attribution:
 *
 *     prisma:error
 *     Invalid `prisma.$queryRawUnsafe()` invocation:
 *     Raw query failed. Code: `22021`. Message: `ERROR: invalid byte sequence …`
 *
 * No call site. No SQL. No tenant. No stack. Prisma writes it straight to
 * stderr, and Postgres discards the statement text here because
 * `logging_collector` is off with no journal unit. So the one fact needed to fix
 * it — WHICH of the 450 raw call sites in this tree is failing — is absent from
 * every surface a diagnosing agent can read. Ten days of that is what an
 * unattributable error costs.
 *
 * WHY IT BELONGS AT THE CLIENT, NOT AT THE CALL SITES. There are 450
 * raw call sites across the four operations (query/execute, safe and Unsafe).
 * NOTE for future editors: do not write those operation names in prose
 * immediately followed by a backtick or an open paren. `operatorScriptParity`
 * detects writes by regex over file TEXT, so such a comment reads as a real
 * write and makes every write-free operator script look write-reachable — it
 * cost one debugging cycle here. Wrapping the call sites by hand
 * would be the `protection-with-two-implementations` shape this codebase has
 * recorded eight times: the ones nobody remembered to wrap stay silent, and the
 * guard reads as complete. A Prisma client extension is ONE implementation that
 * a new call site cannot be added around — verified interceptable on
 * @prisma/client 6.19.2 for all four raw operations.
 *
 * WHAT IT DOES NOT DO, deliberately:
 *   • it does not swallow. The error is always rethrown, unchanged. A monitor
 *     that alters the behaviour it monitors is a defect generator; DEF-085's own
 *     row names swallowing as "the DEF-085 laundering".
 *   • it does not log parameter values. Raw parameters here carry WhatsApp
 *     bodies, e-mail addresses and contact names. Only the SQL SHAPE is
 *     recorded — the statement with its literals stripped — because the shape
 *     is what identifies the call site and the values are what would leak.
 *   • it does not fabricate a repair. This is rung 1 (detect) of the
 *     capability_contract.md ladder. It reports; it does not pretend to heal.
 */
import createLogger from '../utils/logger';

const log = createLogger('raw-query');

/** Emitted as the finding `kind`. Named in healthFindingService's own interface
 *  docs since that service was written; this module is the missing producer. */
export const RAW_QUERY_FAILED_KIND = 'raw_query_failed';

/**
 * How many times one signature must fail before it becomes a finding.
 *
 * Not 1. A single raw failure is often a legitimate constraint violation the
 * caller handles, and a findings table that fills with those is a table nobody
 * reads — which is the state that let DEF-085 hide. Three occurrences of the
 * SAME signature is a pattern: it is failing structurally, not situationally.
 */
export const FINDING_THRESHOLD = 3;

/** One finding per signature per window, so a 90-second failure produces one
 *  row an hour rather than forty. `recordFinding` also collapses on
 *  (clientNumber, kind, subjectId), so this is the second of two guards. */
export const FINDING_WINDOW_MS = 60 * 60 * 1000;

interface Counter { count: number; windowStartedAt: number; reportedThisWindow: boolean }
const counters = new Map<string, Counter>();

/**
 * Re-entrancy guard, and it is load-bearing rather than defensive.
 *
 * `recordFinding` writes its upsert with `prisma.$queryRaw` — so if the
 * findings INSERT is itself what fails, reporting it would fail, which would
 * report it, forever. The flag makes the reporting path unobservable to itself:
 * a failure raised while we are already reporting is logged once and dropped.
 */
let reporting = false;

/** Test seam. Module state is process-global, so a test asserting the
 *  threshold must be able to start from a known point. */
export function __resetRawQueryObservability(): void {
  counters.clear();
  reporting = false;
}

/**
 * The Postgres SQLSTATE, when the driver put one in the message.
 * `22021` is the character-encoding class this was built for, but the
 * extraction is generic — a `42P01` (undefined table) is just as unattributable
 * and just as worth naming.
 */
export function extractSqlState(message: string): string | null {
  return /Code:\s*`([0-9A-Z]{5})`/.exec(message)?.[1]
      ?? /\b(?:SQLSTATE|code)\D{0,3}\b([0-9A-Z]{5})\b/.exec(message)?.[1]
      ?? null;
}

/**
 * The SQL reduced to its SHAPE: collapsed whitespace, and every literal
 * replaced by a placeholder.
 *
 * This is the field that makes a failure groupable, and the reason it strips
 * literals is not tidiness — a raw statement in this codebase can carry a
 * WhatsApp message body or an e-mail address, and this string goes to a log and
 * to a findings row. Shape identifies the query; values would leak the owner's
 * data into both.
 */
export function sqlShape(sql: string, maxLen = 200): string {
  const shaped = String(sql ?? '')
    .replace(/'(?:[^']|'')*'/g, "'?'")        // string literals, incl. '' escapes
    .replace(/\$\d+/g, '$?')                   // bind placeholders
    .replace(/\b\d+\b/g, '?')                  // bare numbers
    .replace(/--[^\n]*/g, ' ')                 // line comments
    .replace(/\s+/g, ' ')
    .trim();
  return shaped.length > maxLen ? `${shaped.slice(0, maxLen)}…` : shaped;
}

/**
 * The first stack frame that is NOT this file, the Prisma client, or
 * node_modules — i.e. the application code that issued the query.
 *
 * This single string is what ten days of DEF-085 was missing.
 */
export function callSiteFrom(stack: string | undefined): string {
  if (!stack) return 'unknown';
  for (const raw of stack.split('\n').slice(1)) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;
    if (line.includes('node_modules')) continue;
    if (line.includes('node:internal')) continue;
    if (/[\\/]db[\\/](rawQueryObservability|prisma)\./.test(line)) continue;
    const m = /\(?([^()\s]+\.(?:ts|js)):(\d+):\d+\)?$/.exec(line);
    if (m) {
      const file = m[1].replace(/^.*?[\\/](src[\\/].*)$/, '$1').replace(/^.*?[\\/](dist[\\/].*)$/, '$1');
      return `${file}:${m[2]}`;
    }
  }
  return 'unknown';
}

/** Stable grouping key. Deliberately excludes the message tail, so the same
 *  broken query does not split into many signatures on a varying detail. */
export function signatureOf(sqlState: string | null, callSite: string, shape: string): string {
  return `${sqlState ?? 'none'}|${callSite}|${shape}`;
}

export interface RawFailureReport {
  signature: string;
  sqlState: string | null;
  callSite: string;
  shape: string;
  count: number;
  crossedThreshold: boolean;
}

/**
 * Record one raw-query failure. Returns what was observed, for the tests and
 * for the caller's log line. NEVER throws: an observability path that can
 * break the query path is worse than none.
 */
export function noteRawQueryFailure(args: {
  operation: string;
  sql: string;
  error: unknown;
  stack?: string;
  now?: number;
}): RawFailureReport | null {
  try {
    const message = args.error instanceof Error ? args.error.message : String(args.error);
    const sqlState = extractSqlState(message);
    const callSite = callSiteFrom(args.stack ?? (args.error instanceof Error ? args.error.stack : undefined));
    const shape = sqlShape(args.sql);
    const signature = signatureOf(sqlState, callSite, shape);
    const now = args.now ?? Date.now();

    let c = counters.get(signature);
    if (!c || now - c.windowStartedAt > FINDING_WINDOW_MS) {
      c = { count: 0, windowStartedAt: now, reportedThisWindow: false };
      counters.set(signature, c);
    }
    c.count += 1;

    const crossedThreshold = c.count >= FINDING_THRESHOLD && !c.reportedThisWindow;
    if (crossedThreshold) c.reportedThisWindow = true;

    // ONE structured line carrying the four facts the bare `prisma:error` did
    // not: which SQLSTATE, which call site, which query shape, how often.
    log.warn('raw query failed', {
      operation: args.operation,
      sqlState,
      callSite,
      sqlShape: shape,
      occurrences: c.count,
      signature,
    });

    return { signature, sqlState, callSite, shape, count: c.count, crossedThreshold };
  } catch {
    return null;
  }
}

/**
 * Who turns a repeated failure into a durable finding.
 *
 * INJECTED rather than imported, and the reason is a real constraint rather
 * than taste. `db/prisma.ts` is in the import closure of every operator script,
 * including the ones `operatorScriptParity.test.ts` declares WRITE-FREE
 * (Tier 5). Importing `healthFindingService` here would put
 * that service's typed finding-row update into that closure, so a read-only script
 * like `smokeTenantIsolation` would become able to write a findings row — the
 * parity guard caught exactly that, correctly.
 *
 * So the edge is inverted: this module stays pure and only ever LOGS, which is
 * the attribution DEF-085 actually lacked. The long-running server injects the
 * writer at boot (`services/selfheal/rawQueryFindingReporter`). A one-shot
 * script therefore gets the call site in its output and writes nothing, which
 * is what its tier declares.
 */
export type RawQueryFindingReporter = (report: RawFailureReport) => Promise<void>;

let findingReporter: RawQueryFindingReporter | null = null;

/** Called once at server boot. Absent in scripts and tests, by design. */
export function setRawQueryFindingReporter(fn: RawQueryFindingReporter | null): void {
  findingReporter = fn;
}

/**
 * Raise the finding, once per signature per window. Separated from
 * `noteRawQueryFailure` so the counting is synchronous and testable while the
 * database write stays fire-and-forget — the query path must not wait on the
 * monitor, and must not fail because of it.
 */
export async function reportRawQueryFinding(report: RawFailureReport): Promise<void> {
  if (!findingReporter) return;              // log-only mode: scripts, tests
  if (reporting) return;                     // see `reporting` — this is the recursion stop
  reporting = true;
  try {
    await findingReporter(report);
  } catch (err) {
    log.warn('could not raise raw-query finding', {
      err: err instanceof Error ? err.message : String(err),
    });
  } finally {
    reporting = false;
  }
}

/** The raw operations wrapped in `db/prisma.ts`. ONE list, read by both the
 *  wiring and its guard test, so a fifth raw operation on the client cannot be
 *  left unobserved without the test going red. */
export const OBSERVED_RAW_OPERATIONS = [
  '$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe',
] as const;

/** Node's default is 10 frames, and Prisma's own runtime consumes several. Too
 *  small a limit truncates exactly the application frame we are after. */
export const CALLER_STACK_FRAMES = 40;

/** Capture the caller's stack. MUST be called synchronously by the wrapper,
 *  on the caller's own stack — see `observeRawQuery`. */
export function captureCallerStack(): string | undefined {
  const previous = Error.stackTraceLimit;
  Error.stackTraceLimit = CALLER_STACK_FRAMES;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = previous;
  }
}

/**
 * The single interception point, applied in `db/prisma.ts`.
 *
 * `callerStack` is passed IN rather than captured here, and that is the whole
 * design rather than a style choice. Measured against the real client on
 * @prisma/client 6.19.2: a `query`-component extension hook runs from
 * `PrismaPromise.then` — a microtask — so a stack taken inside it holds only
 * Prisma's runtime frames and the application caller is already gone. The first
 * version of this module did exactly that and produced `callSite: "unknown"`
 * against the live database, which would have shipped the ONE field DEF-085
 * needed as a constant. The wrapper therefore captures synchronously at the
 * call, before any await, and hands the stack here.
 *
 * Kept dependency-free (plain functions in, promise out) so it is unit-testable
 * without a live database or a generated client.
 */
export async function observeRawQuery<T>(
  operation: string,
  sql: string,
  callerStack: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const report = noteRawQueryFailure({ operation, sql, error: err, stack: callerStack });
    if (report?.crossedThreshold) {
      // Fire-and-forget: the caller gets its error now, not after a write.
      void reportRawQueryFinding(report);
    }
    throw err;                                // ALWAYS. Never swallow.
  }
}
