/**
 * DEF-334 (2) — a windowed gate for high-frequency failure logs.
 *
 * The owner's report, verbatim: "tmcai-server writes 51MB error logs every
 * ~6 hours … ~200MB/day. That's an application fault running continuously."
 * The mechanism: a failure inside a hot loop (the LLM fallback paths ran
 * ~2,500 times/hour for DAYS during the billing outage) logs one line per
 * occurrence, and every line past the first few carries no new information —
 * only volume. A monitor whose output grows with the failure rate eventually
 * IS the failure.
 *
 * This gate bounds emission without losing the count: the first
 * `capPerWindow` occurrences per key per window log normally, the rest are
 * counted, and the first line of the NEXT window carries the suppressed
 * total — the volume stays on the record as a number instead of megabytes.
 * Pure, synchronous, in-process; it decides nothing about behaviour, only
 * about repetition (EXECUTES, not DECIDES).
 */

export interface WindowedGateResult {
  /** Emit this occurrence? */
  log: boolean;
  /** Occurrences of this key in the current window, this one included. */
  occurrences: number;
  /** Lines the cap swallowed in the PREVIOUS window — non-zero only on the
   *  first occurrence of a new window; attach it to that line. */
  suppressedLastWindow: number;
}

export function windowedLogGate(
  capPerWindow: number,
  windowMs: number,
): (key: string, now?: number) => WindowedGateResult {
  const slots = new Map<string, { windowStart: number; count: number; suppressed: number }>();
  return (key, now = Date.now()) => {
    let s = slots.get(key);
    let suppressedLastWindow = 0;
    if (!s || now - s.windowStart > windowMs) {
      suppressedLastWindow = s?.suppressed ?? 0;
      s = { windowStart: now, count: 0, suppressed: 0 };
      slots.set(key, s);
    }
    s.count += 1;
    if (s.count <= capPerWindow) return { log: true, occurrences: s.count, suppressedLastWindow };
    s.suppressed += 1;
    return { log: false, occurrences: s.count, suppressedLastWindow: 0 };
  };
}
