/**
 * answerReceiptPolicy — when may Brain's own words stand in for the
 * deterministic action receipt? (DEF-145, 2026-08-12)
 *
 * ONE definition, because this policy had FOUR implementations and the one
 * that decided what the owner actually read was not the one DEF-144 fixed:
 *
 *   1. `brainComposer`'s inline success branches — `answer = actionResult.message`
 *   2. `applyOpenItemUpdate` — returns the same receipt, used by pending confirms
 *   3. `dispatchPendingDirect` — passes that receipt straight out as the answer
 *   4. `channelRenderer.renderForChannel` — on WhatsApp, prefers
 *      `actionResult.message` over the composed answer whenever an action
 *      succeeded
 *
 * DEF-144 fixed (1) for `update_open_item` and the benchmark did not move a
 * character: B04's reply was byte-identical across iterations 06 and 07, 94
 * chars of `Updated "…": priority=high.`, while the composer log for the same
 * turn shows the model had said *"Got it. I've marked that as high priority.
 * Still needs a due date if you have one."* (4) had put the receipt back.
 * The benchmark calls `answerAsBrain` with `channel: 'whatsapp'`, which is also
 * the surface the owner uses, so (4) is the implementation that matters and the
 * other three were arguing among themselves.
 *
 * That is `protection-with-two-implementations` again — 8 recorded occurrences —
 * and the tell is exact: a fix verified by tests and by reading the code, with
 * no observable effect, because a later layer re-decides the same question.
 *
 * WHY A POLICY AND NOT JUST "KEEP THE PROSE". The receipt was defending two
 * real things, and both survive here:
 *
 *   - A failed action's `message` is an internal sentinel (`empty_promise_blocked`,
 *     bracketed markers). `channelRenderer`'s `ok === true` gate exists because
 *     one leaked to the owner verbatim on 2026-05-20. Untouched.
 *   - The receipt reported only what was actually written. Prose can overstate.
 *     `update_open_item` silently drops a priority word it cannot normalise, and
 *     a model that says "I've set the deadline to Friday" when no due date was
 *     applied is making a false completion claim — invariant #5. So prose only
 *     stands when the outcome ENTAILS it.
 *
 * This module is deliberately dependency-free so both the composer and the
 * channel renderer can import it without either pulling the other in. Codex
 * raised that as a MEDIUM risk against DEF-140, where a cosmetic rule imported
 * the whole 7k-line composer and could silently skip on a module-init failure.
 */

/** Below this, a "reply" is a fragment rather than an answer, and the
 *  deterministic receipt is more use to the owner than three words. */
export const MIN_ANSWER_CHARS_OVER_RECEIPT = 12;

/**
 * Is this string Brain's prose at all, as opposed to a bracketed system
 * marker or a stub? Markers belong to `answerSanitizer`, which renders them
 * downstream; they must never suppress a receipt by looking like an answer.
 */
export function isUsableBrainProse(answer: string): boolean {
  const trimmed = (answer || '').trim();
  if (trimmed.length < MIN_ANSWER_CHARS_OVER_RECEIPT) return false;
  if (trimmed.startsWith('[')) return false;
  return true;
}

/**
 * A first-person claim that a DEADLINE was actually set, as opposed to a
 * question about one or a statement that none exists.
 *
 * The distinction is the whole difficulty, and it is the same trap
 * `EMPTY_PROMISE_RE` lives in: *"Still needs a due date if you have one"* is
 * the sentence DEF-144 exists to preserve, while *"I've set the deadline to
 * Friday"* on an update that applied no due date is a fabricated completion.
 * So a set-verb is required, and the gap to the deadline noun cannot cross a
 * sentence boundary (`[^.!?\n]`), which is what keeps B04's real answer out.
 */
const DUE_DATE_CLAIM_RE = new RegExp(
  "\\bi(?:['’]?(?:ve|ll))?\\s+(?:have\\s+)?(?:set|added|put|updated|marked|scheduled|changed)\\b"
  + '[^.!?\\n]{0,40}?\\b(?:deadline|due\\s?date|due\\s+by)\\b'
  + '|\\b(?:deadline|due\\s?date)\\s+(?:is\\s+now|has\\s+been\\s+set|was\\s+set|set\\s+to)\\b',
  'i',
);

export interface ActionOutcome {
  /** Fields the model asked for that the server did NOT apply. Any entry means
   *  the receipt is the honest record. */
  requestedButNotApplied?: readonly string[];
  /** Fields actually written, e.g. ['priority', 'dueDate']. Used to test
   *  whether the prose's completion claims are entailed by the outcome. */
  appliedFields?: readonly string[];
}

/**
 * May Brain's answer stand instead of the receipt for a SUCCESSFUL action?
 *
 * Fail-closed: anything this function cannot positively justify falls back to
 * the deterministic receipt, which is always true by construction.
 */
export function brainAnswerSurvivesReceipt(answer: string, outcome: ActionOutcome = {}): boolean {
  if (!isUsableBrainProse(answer)) return false;
  if ((outcome.requestedButNotApplied ?? []).length > 0) return false;
  // Claim-versus-outcome: a stated deadline that was never written is a false
  // completion claim, and shipping it would trade DEF-144's tone win for a
  // truthfulness regression (Codex, iteration-7 review, risk #1).
  const applied = outcome.appliedFields ?? [];
  if (!applied.includes('dueDate') && DUE_DATE_CLAIM_RE.test(answer)) return false;
  return true;
}

/** Exported for tests so they drive the REAL pattern rather than a copy — a
 *  second copy is how `protection-with-two-implementations` reaches nine. */
export const __DUE_DATE_CLAIM_RE = DUE_DATE_CLAIM_RE;
