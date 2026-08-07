/**
 * Deterministic date resolver — chrono-node + the user's timezone.
 *
 * Why this exists: Gemini 2.5 Pro is unreliable at relative-date
 * arithmetic, even with today's date in its prompt. Observed
 * 2026-05-22: reasoning emitted dueDate=2024-08-05 when asked for
 * "next Monday" on a Friday in May 2026. That's 21 months off.
 *
 * Design principle (per Basit 2026-05-23): the LLM is the brain;
 * date math is a calculator. The brain should EXTRACT the raw text
 * ("next Monday", "tomorrow 6pm", "in 3 days"); the calculator (this
 * module) resolves to ISO. The LLM never emits ISO datetimes directly.
 *
 * Public API:
 *   resolveDate(rawText, userId)        → "2026-05-25" (YYYY-MM-DD) | null
 *   resolveDateTime(rawText, userId)    → "2026-05-25T18:00:00+05:00" | null
 *
 * Both return null when chrono can't parse the input. Callers should
 * surface a bracketed marker, NOT try to parse themselves — keep the
 * brain-vs-calculator split clean.
 */
import * as chrono from 'chrono-node';
import { getUserTimezoneOffset, getTimezoneOffset, systemDefaultTimezone } from '../userTimezoneService';


/**
 * Urgency phrases chrono cannot parse, mapped to the anchor they mean.
 *
 * DEF-094 — 2026-08-07 21:14 the owner set a deadline of **"immediate"** and got
 * back `[update_open_item: couldn't parse dueDate "immediate" — try a specific
 * date]`. He then said "High immediate" and hit it again. "Immediate" is not an
 * edge case; it is how people actually give deadlines, and being told to
 * "try a specific date" is the assistant arguing with its user.
 *
 * This belongs in the calculator, not the brain. The module's own principle
 * (Basit, 2026-05-23) is that the LLM extracts the raw phrase and the calculator
 * resolves it — so the calculator needs the vocabulary. This is date lexicon,
 * not judgement: it decides no priority and infers no intent, it only knows that
 * "asap" anchors to today the same way "tomorrow" anchors to +1.
 *
 * Deliberately narrow. Only phrases that unambiguously mean "as soon as
 * possible" are listed. "Soon" and "shortly" are NOT here — they are genuinely
 * vague, and silently turning them into today's date would be the fabrication
 * this codebase keeps fighting.
 */
const URGENCY_TO_TODAY = [
  /^\s*immediate(ly)?\s*$/i,
  /^\s*a\.?s\.?a\.?p\.?\s*$/i,
  /^\s*as\s+soon\s+as\s+possible\s*$/i,
  /^\s*right\s+(away|now)\s*$/i,
  /^\s*now\s*$/i,
  /^\s*urgent(ly)?\s*$/i,
  /^\s*today\s+itself\s*$/i,
  // Roman Urdu / Urdu — the owner and his counterparts mix languages freely,
  // and an English-only lexicon fails exactly the users this product has.
  /^\s*(abhi|abhee)\s*$/i,
  /^\s*(foran|fauran|fawran)\s*$/i,
  /^\s*aaj\s*(hi)?\s*$/i,
  /^\s*فوراً?\s*$/,
  /^\s*ابھی\s*$/,
  /^\s*آج\s*$/,
];

/**
 * Rewrite an urgency phrase into something chrono understands.
 * Anything not recognised passes through untouched.
 */
function normaliseUrgencyPhrase(raw: string): string {
  return URGENCY_TO_TODAY.some((re) => re.test(raw)) ? 'today' : raw;
}

interface ResolveOpts {
  /** Anchor for relative dates. Defaults to now(). */
  referenceDate?: Date;
  /** If false, accept past dates (default: reject dates > 1 year in past,
   *  catches "the LLM emitted a 2024 date" hallucinations). */
  allowFarPast?: boolean;
}

/** Parse a date-or-date-phrase into a YYYY-MM-DD string using the user's
 *  timezone. Returns null if chrono can't extract a date. */
export async function resolveDate(
  rawText: string,
  userId: number,
  opts: ResolveOpts = {},
): Promise<string | null> {
  if (!rawText || typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return null;

  const ref = opts.referenceDate ?? new Date();
  const offset = await getUserTimezoneOffset(userId).catch(() => getTimezoneOffset(systemDefaultTimezone()));
  // chrono ignores TZ offset in the input string; we resolve in the
  // user's local frame by parsing with `ref` as a local-time anchor.

  const parsed = chrono.parseDate(normaliseUrgencyPhrase(trimmed), ref, { forwardDate: true });
  if (!parsed || Number.isNaN(parsed.getTime())) return null;

  // Hallucination guard: reject dates > 1 year before today (catches the
  // 2024-08-05-for-next-Monday-in-2026 class).
  if (!opts.allowFarPast) {
    const yearAgo = new Date(ref.getTime() - 365 * 24 * 60 * 60 * 1000);
    if (parsed < yearAgo) return null;
  }

  // Format as YYYY-MM-DD in the user's TZ. Build by offset manually to
  // avoid `toISOString()` returning UTC date for a late-evening local
  // time.
  return formatLocalDate(parsed, offset);
}

/** Parse a date+time phrase into an ISO 8601 datetime with the user's
 *  timezone offset. e.g. "tomorrow 6pm" → "2026-05-24T18:00:00+05:00". */
export async function resolveDateTime(
  rawText: string,
  userId: number,
  opts: ResolveOpts = {},
): Promise<string | null> {
  if (!rawText || typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return null;

  const ref = opts.referenceDate ?? new Date();
  const offset = await getUserTimezoneOffset(userId).catch(() => getTimezoneOffset(systemDefaultTimezone()));

  const parsed = chrono.parseDate(normaliseUrgencyPhrase(trimmed), ref, { forwardDate: true });
  if (!parsed || Number.isNaN(parsed.getTime())) return null;

  if (!opts.allowFarPast) {
    const yearAgo = new Date(ref.getTime() - 365 * 24 * 60 * 60 * 1000);
    if (parsed < yearAgo) return null;
  }

  // Build ISO with the user's offset, not Z. If chrono didn't extract a
  // time component (e.g. "monday" alone), default to 09:00 local — same
  // convention the calendar UI uses for all-day-but-need-a-time.
  const hasTime = /\d{1,2}\s*[:hap]/i.test(trimmed) || /\b(am|pm|noon|midnight|morning|evening|afternoon)\b/i.test(trimmed);
  if (!hasTime) {
    parsed.setHours(9, 0, 0, 0);
  }

  const local = formatLocalDateTime(parsed, offset);
  return `${local}${offset}`;
}

// ─── Internal ─────────────────────────────────────────────────────
//
// Fix 2026-05-25: previous formatters added the offset hours TO the
// parsed time, producing "11am + 5h = 4pm labeled as PKT". Wrong.
//
// The right behavior: read d's LOCAL clock components (Y/M/D/H/M/S)
// — these are what chrono parsed as ("11am" → getHours()===11
// regardless of server TZ — chrono parses in the server's local frame
// but the value the USER said is captured in the LOCAL fields). Then
// stamp the user's TZ offset on the end. Result: "11am" → 11:00+05:00.

function formatLocalDate(d: Date, _offsetStr: string): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatLocalDateTime(d: Date, _offsetStr: string): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}:${mi}:${s}`;
}
