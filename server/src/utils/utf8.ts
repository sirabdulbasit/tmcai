/**
 * utf8.ts — string hygiene for DB writes (prod fix 2026-07-10).
 *
 * Prod logs showed bursts of Postgres error 22021:
 *   `invalid byte sequence for encoding "UTF8": 0xe2`
 * during the triage/cognitive sweep. A JS string can only produce
 * invalid UTF-8 on the wire when it contains LONE SURROGATES —
 * unpaired halves of a UTF-16 surrogate pair. Two sources exist here:
 *
 *   1. `.slice(0, N)` on text containing astral characters (emoji —
 *      ubiquitous in WhatsApp content). Astral chars occupy TWO
 *      UTF-16 code units; slicing between them leaves a lone high
 *      surrogate at the cut point. The triage path slices LLM output
 *      and message text in dozens of places.
 *   2. LLM responses truncated at maxTokens can end mid-character;
 *      depending on the SDK's decode path this can also surface as a
 *      lone surrogate at the tail.
 *
 * Both are data-dependent (need an emoji near the cut) which is why
 * the errors appear in bursts on real traffic and never in dev.
 *
 * Two primitives:
 *   sanitizeUtf8(s) — round-trips through a UTF-8 Buffer, which
 *     replaces any lone surrogate with U+FFFD (the replacement char).
 *     The result is ALWAYS valid UTF-8; PG never rejects it.
 *   safeSlice(s, n) — slice that never cuts a surrogate pair in half:
 *     if the last kept unit is a lone high surrogate, drop it.
 *
 * Use safeSlice for truncation; use sanitizeUtf8 at trust boundaries
 * (LLM output, third-party payloads) before any DB write.
 */

/** Replace lone surrogates so the string is guaranteed valid UTF-8. */
export function sanitizeUtf8(s: string): string {
  if (!s) return s;
  // Fast path: no surrogate code units at all → already safe.
  // (Astral chars USE surrogates, so this only skips pure-BMP text,
  // but that's the overwhelmingly common case for LLM prose.)
  if (!/[\uD800-\uDFFF]/.test(s)) return s;
  // Buffer round-trip: Node's UTF-8 encoder emits U+FFFD for any
  // unpaired surrogate; properly paired ones re-decode unchanged.
  return Buffer.from(s, 'utf8').toString('utf8');
}

/** Slice that never leaves a dangling half of a surrogate pair. */
export function safeSlice(s: string, end: number): string {
  if (!s) return s;
  let out = s.slice(0, end);
  const last = out.charCodeAt(out.length - 1);
  // High surrogate at the tail = we cut an astral char in half.
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}
