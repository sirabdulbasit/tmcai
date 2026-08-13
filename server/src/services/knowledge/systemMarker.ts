/**
 * DEF-169 — a system marker says so, instead of being guessed at from brackets.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Several code paths emit an internal signal in place of an answer — the
 * validator when it blocks a reply, the expired-preview handler, dispatch
 * errors, the malformed-output guard. They have always been written as
 * `[lowercase words — explanation]`, and every consumer downstream has had to
 * RECOGNISE them by that shape or by name.
 *
 * Both ways of recognising them have now failed, in opposite directions:
 *
 *   BY NAME (DEF-168, iteration 21). `answerSanitizer` matched an enumerated
 *   list of prefixes, so two markers nobody had added to the list reached the
 *   owner verbatim — the exact failure that file was created to prevent.
 *
 *   BY SHAPE (DEF-169, iteration 22 — mine). I replaced the list with
 *   `/^\s*\[[^\]]{8,400}\]\s*$/`, which cannot tell an internal marker from a
 *   person writing `[see attached]` or `[Approved by Basit]`. Codex's
 *   iteration-22 HIGH #1: a legitimate whole-bracket reply becomes a fabricated
 *   failure message. My build entry claimed `[see attached]` was asserted safe;
 *   the test I wrote conspicuously omitted it, and it would have been destroyed.
 *
 * A bracket is ordinary punctuation. It cannot carry provenance, and no
 * cleverer pattern over brackets will fix that — the information about whether
 * this string is an internal signal exists only at the PRODUCER, and was being
 * thrown away and then guessed at.
 *
 * ── THE ENVELOPE ────────────────────────────────────────────────────────────
 *
 * `U+2063 INVISIBLE SEPARATOR` prefixes every marker this codebase emits. It is
 * a format character with no width and no meaning in prose: a person does not
 * type it, an LLM does not emit it, and if one ever leaks to a screen it renders
 * as nothing rather than as noise. So `isSystemMarker` is a fact about origin,
 * not an inference about wording.
 *
 * The bracketed body is kept exactly as it was, because it is what appears in
 * logs and in `brain_change_log` rows, and because the enumerated curated
 * meanings in `answerSanitizer` still match on it. Nothing that recognised a
 * marker before stops recognising it now.
 *
 * ── WHAT THIS DOES NOT CLOSE ────────────────────────────────────────────────
 *
 * Producers that still build a bracketed string by hand are unchanged and are
 * still recognised only by the enumerated list. This module makes the envelope
 * AVAILABLE and moves the validator onto it; it does not, by existing, migrate
 * anyone else. That is stated rather than implied because DEF-168 was caused by
 * exactly this kind of half-migration being described as complete.
 */

/** U+2063 INVISIBLE SEPARATOR. Zero width, no meaning in prose, never typed. */
export const SYSTEM_MARKER_SENTINEL = '⁣';

/**
 * Build an internal marker. `body` is the human-readable text WITHOUT brackets.
 *
 * Bracketed form is preserved so logs, curated-meaning rules and the existing
 * `[system marker]` convention in AGENTS.md all keep working.
 */
export function systemMarker(body: string): string {
  const inner = body.trim().replace(/^\[|\]$/g, '').trim();
  return `${SYSTEM_MARKER_SENTINEL}[${inner}]`;
}

/**
 * True when this string was produced by `systemMarker`.
 *
 * A fact about where the string came from. `[see attached]` is not a marker and
 * never was; only the absence of provenance ever made it look like one.
 */
export function isSystemMarker(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trimStart().startsWith(SYSTEM_MARKER_SENTINEL);
}

/** The marker without its envelope, for logging and for curated-meaning lookup. */
export function stripMarkerEnvelope(text: string): string {
  return (text ?? '').split(SYSTEM_MARKER_SENTINEL).join('');
}

/**
 * A marker from a producer that has NOT been migrated to `systemMarker()`.
 *
 * Caught by an existing DEF-102 guard while building this: markers like
 * `[update_open_item: id not found — reference may be stale, retry by title]` are
 * emitted by handlers all over the codebase, and provenance protects only the
 * producers that opt in. Removing the shape catch-all without migrating them
 * would have shipped those raw — losing protection iteration 22 had.
 *
 * So this recognises MACHINE GRAMMAR rather than "has brackets": a snake_case
 * identifier followed by a colon. `[update_open_item: …]` matches; `[see
 * attached]`, `[CONFIDENTIAL]`, `[Approved by Basit]` cannot, because none of
 * them is an identifier-colon pair. It is narrower than iteration 22's
 * `/^\[...\]$/` by construction, not by tuning.
 *
 * A COMPATIBILITY BRIDGE, and named as one. The exit is migrating those
 * producers to `systemMarker()`; until then this keeps them covered without
 * pretending brackets carry provenance.
 */
export function isLegacyActionMarker(text: string | null | undefined): boolean {
  return /^\s*\[[a-z][a-z0-9_]*:\s/.test(text ?? '');
}

/**
 * What the owner reads when a marker has no curated meaning.
 *
 * Codex's iteration-22 MEDIUM #3: my previous fallback said *"let me look again.
 * Could you ask me once more?"* — a promise of internal follow-up that is
 * neither scheduled nor evidenced, plus a demand that the owner repeat himself.
 * That is the empty-promise class reappearing inside the safety net, which is
 * the one place it must not be.
 *
 * So this states the situation and stops. No promise, no cause, no request to
 * try again, and nothing that could be read as an action having been taken.
 */
export const NEUTRAL_MARKER_FALLBACK =
  "I couldn't put together an answer I trust for that one.";
