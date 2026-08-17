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

import { isSystemMarker } from './systemMarker';

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
  // DEF-212 — this rejects a BARE bracket, and a provenance-stamped marker is
  // not one: `systemMarker()` prefixes the sentinel, so a stamped marker does
  // not start with `[` and already passes. I added an `isSystemMarker` branch
  // here and a mutation test proved it changed nothing — the rule was already
  // correct — so it is gone rather than left as decoration. What stays rejected
  // is exactly what DEF-169 meant to reject: `[see attached]`, shape without
  // provenance.
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


// ── DEF-147 (2026-08-12): the flag claimed more than it checked ─────────
//
// DEF-146 shipped `proseGrounded?: boolean` on the action result, and the type
// contract said it meant the branch "COMPARED the visible prose against the
// structured outcome and found the prose entailed by it". It did not. It
// checked two things: whether a requested priority failed to normalise, and
// whether one deadline regex was compatible with the list of written field
// NAMES. It never looked at a single field VALUE, or at which item was
// updated.
//
// Codex's iteration-9 HIGH, and it is exact:
//
//     Prisma updates Project Beta to `high`. The model says "I've set Project
//     Alpha to critical. It still needs a due date." Priority normalised, no
//     deadline claim → the flag went true → WhatsApp hid the correct Beta/high
//     receipt and shipped the false Alpha/critical statement.
//
// Two separate defects in one field, and the second is the worse one:
//
//   1. The checks were too weak for what the name promised.
//   2. **A plain boolean can be asserted by anybody.** Any future branch could
//      write `proseGrounded: true` to get friendlier prose, with no comparison
//      at all, and every existing test would stay green. A capability that can
//      be claimed without evidence is not a capability.
//
// So the boolean is gone. `verifyUpdateProse` is the only thing that can mint a
// `VerifiedProse`, the token is held in a module-private WeakSet, and
// `receiptWins` accepts nothing else. A forged `{}`, a `true`, or a token that
// survived a JSON round-trip all fail — correctly, because this decision has to
// be made in the process that did the write, with the outcome in hand.

/** Opaque proof that prose was checked against a real outcome. Only
 *  `verifyUpdateProse` can produce one; there is no public constructor and the
 *  brand is not satisfiable from outside this module. */
declare const VERIFIED_PROSE: unique symbol;
export type VerifiedProse = { readonly [VERIFIED_PROSE]: 'update_open_item' };

/**
 * Runtime half of the guarantee. A brand stops a *type* error; this stops a
 * cast, a hand-built object, and anything deserialised.
 *
 * A WeakMap rather than a WeakSet (DEF-154) because membership alone attests
 * nothing. Codex's iteration-10 HIGH: a genuine token minted for harmless prose
 * could be attached to DIFFERENT fabricated prose and `receiptWins` would accept
 * it, because it only asked "was this object issued?" and never "issued for
 * WHAT?". The record below is what makes the token a proof about one sentence,
 * artifact and receipt rather than a bearer credential.
 */
interface TokenRecord {
  /** The exact prose that was checked. */
  prose: string;
  /** The artifact the check was about. */
  artifactId: string | null;
  /** The receipt the check accompanied — applied values are rendered into this
   *  string, so comparing it catches a post-mint change to any of them. */
  receipt: string;
}
const tokenRecords = new WeakMap<object, TokenRecord>();

/** The result of an `update_open_item` as the writing branch knows it.
 *
 *  ACCURACY NOTE, because the previous wording overstated this and Codex was
 *  right to say so: these are the values SUBMITTED to `prisma.openItem.update`
 *  after it returned successfully — structured attempted-write input, not a
 *  re-read of the row. Strictly better than the model's request (what DEF-146
 *  compared against) and strictly weaker than observed state: a hook, a
 *  coercion or a trigger could still leave the row different. */
export interface UpdateOutcome {
  /** Title of the row actually updated. */
  artifactTitle: string;
  /** Id of the row actually updated. Bound into the token (DEF-154) so a token
   *  cannot be carried to a result about a different artifact. */
  artifactId?: string | null;
  /** The deterministic receipt this verification accompanies. Bound into the
   *  token so mutating the applied values — which are rendered INTO the receipt
   *  string — after minting fails closed. */
  receipt?: string;
  /** Priority actually written, or null when none was. */
  appliedPriority: string | null;
  /** Whether a due date was actually written. */
  appliedDueDate: boolean;
  /** Status actually written, or null when unchanged. */
  appliedStatus: string | null;
  /** Fields the model asked for that the server did not apply. */
  requestedButNotApplied: readonly string[];
}

const PRIORITY_WORDS = ['critical', 'high', 'medium', 'low', 'urgent', 'normal'] as const;

/** A first-person claim that a PRIORITY was set to a named level. Same
 *  claim-versus-question discipline as the deadline pattern: a set-verb is
 *  required, so "what priority do you want?" is not a claim. */
const PRIORITY_CLAIM_RE = new RegExp(
  "\\b(?:set|marked|made|changed|moved|bumped|updated|flagged)\\b[^.!?\\n]{0,40}?"
  + `\\b(${PRIORITY_WORDS.join('|')})\\b`
  + `|\\b(?:priority|it)\\s+(?:is\\s+now|to)\\s+(${PRIORITY_WORDS.join('|')})\\b`,
  'i',
);

/** A claim that the item is finished. `update_open_item` never closes anything,
 *  so any such claim is false by construction on this path. */
const DONE_CLAIM_RE =
  /\b(?:marked|set|moved)\b[^.!?\n]{0,30}?\b(?:done|complete[d]?|closed|finished)\b|\b(?:it|that|this)\s+is\s+now\s+(?:done|complete[d]?|closed)\b/i;

/** Any title the prose puts in DOUBLE quotes. Unquoted item names are NOT
 *  detected — see the honesty note in `verifyUpdateProse`.
 *
 *  Single quotes are deliberately excluded, and a test caught why: an
 *  apostrophe is not a quote mark. With `'` in the class, *"I've set the
 *  priority to high. It's still missing a due date"* parsed as a quoted title
 *  running from `I've` to `It's`, which matched no item and sent every
 *  contraction-bearing sentence to the receipt. Item titles here do contain
 *  apostrophes ("Brain's responsiveness"), so this had to be right. */
const QUOTED_TITLE_RE = /["“”]([^"“”\n]{6,})["“”]/;

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Check Brain's prose against what was actually persisted, and mint a token
 * only if every claim it makes is borne out.
 *
 * Returns `null` — meaning "show the receipt" — for anything it cannot
 * positively justify. That direction is the whole design: the receipt is true
 * by construction, so an unproveable sentence costs the owner nothing but
 * warmth, while a wrong one costs them the truth.
 *
 * WHAT IS CHECKED, exactly, so the next reader does not have to trust an
 * adjective the way DEF-146's did:
 *
 *   - a requested field the server dropped        → receipt
 *   - a quoted title that is not the updated row  → receipt   (wrong item)
 *   - a named priority that is not what was written, or any named priority
 *     when none was written                       → receipt   (wrong value)
 *   - a deadline stated as set with no due date written        → receipt
 *   - any claim the item is done/closed           → receipt   (this path
 *     never closes an item, so the claim is false by construction)
 *   - prose that is a marker or a stub            → receipt
 *
 * WHAT IS **NOT** CHECKED, stated plainly rather than implied away:
 *
 *   - **An UNQUOTED wrong item name.** "I've set Project Alpha to high" while
 *     Beta was updated still passes, because detecting an arbitrary item name
 *     needs the user's full title list, which this function does not have.
 *     Codex's exact scenario is therefore only half-closed: the wrong-VALUE
 *     half is caught, the unquoted wrong-NAME half is not.
 *   - The specific date behind a deadline claim. Presence of a written due date
 *     is checked; "Friday" versus "Monday" is not.
 *   - Note and title text.
 */
export function verifyUpdateProse(prose: string, outcome: UpdateOutcome): VerifiedProse | null {
  if (!isUsableBrainProse(prose)) return null;
  if (outcome.requestedButNotApplied.length > 0) return null;

  // Wrong item — only catchable when the model quotes the title.
  const quoted = QUOTED_TITLE_RE.exec(prose);
  if (quoted && norm(quoted[1]) !== norm(outcome.artifactTitle)) return null;

  // Wrong priority value, or a priority claimed when none was written.
  const priorityClaim = PRIORITY_CLAIM_RE.exec(prose);
  if (priorityClaim) {
    const claimed = norm(priorityClaim[1] ?? priorityClaim[2] ?? '');
    if (!outcome.appliedPriority) return null;
    // 'urgent'/'normal' are the words the model reaches for; the server stores
    // 'critical'/'medium'. Treat them as the same claim rather than punishing
    // vocabulary — but a claim of 'low' against a written 'high' still fails.
    const synonyms: Record<string, string> = { urgent: 'critical', normal: 'medium' };
    const canonical = synonyms[claimed] ?? claimed;
    if (canonical !== norm(outcome.appliedPriority)) return null;
  }

  // Deadline stated as set, with nothing written.
  if (!outcome.appliedDueDate && DUE_DATE_CLAIM_RE.test(prose)) return null;

  // "Done" is never true on this path.
  if (DONE_CLAIM_RE.test(prose)) return null;

  const token = Object.freeze({}) as unknown as VerifiedProse;
  tokenRecords.set(token as unknown as object, {
    prose,
    artifactId: outcome.artifactId ?? null,
    receipt: outcome.receipt ?? '',
  });
  return token;
}

/**
 * DEF-212 — mint a token for the APPLIED-receipt marker.
 *
 * This is not a second opinion about prose; it carries no claim of its own. The
 * marker's payload IS the receipt, verbatim, built in the process that did the
 * write — which is exactly the provenance `verifyUpdateProse` demands and the
 * reason a bare boolean was removed in DEF-147. Binding it to (marker, receipt,
 * artifact) means a replay onto different prose, a changed set of applied
 * values, or a different artifact all fail closed to the receipt, unchanged.
 */
export function verifyAppliedMarker(
  marker: string,
  outcome: { receipt: string; artifactId?: string | null },
): VerifiedProse | null {
  if (!isSystemMarker(marker)) return null;
  if (!outcome.receipt?.trim()) return null;
  // The receipt must actually be inside the marker it claims to carry — a
  // marker built from some other outcome is not this one's record.
  if (!marker.includes(JSON.stringify(outcome.receipt.replace(/\s+/g, ' ').trim().slice(0, 400)).slice(1, -1))) {
    return null;
  }
  const token = Object.freeze({}) as unknown as VerifiedProse;
  tokenRecords.set(token as unknown as object, {
    prose: marker,
    artifactId: outcome.artifactId ?? null,
    receipt: outcome.receipt,
  });
  return token;
}

/**
 * The ONE decision: for a completed action, does the owner see the receipt or
 * Brain's prose?
 *
 *   - No successful, non-empty receipt → prose. The `ok === true` gate that
 *     stopped the 2026-05-20 sentinel leak is part of this and is unchanged.
 *   - No genuine `VerifiedProse` token → **receipt.** Not "unchecked so
 *     probably fine": unchecked means the owner gets the text that is true by
 *     construction. This is the DEF-146 containment, kept.
 *   - A genuine token → prose, provided it is still usable prose.
 */
export function receiptWins(
  actionResult:
    | { ok?: boolean; message?: string; artifactId?: string; verifiedProse?: unknown }
    | null
    | undefined,
  prose: string,
): boolean {
  const receipt = actionResult?.ok === true && actionResult.message?.trim() ? actionResult.message : null;
  if (!receipt) return false;

  const token = actionResult?.verifiedProse;
  const record = token && typeof token === 'object' ? tokenRecords.get(token as object) : undefined;

  // No token, a forged one, or one that did not survive deserialisation.
  if (!record) return true;
  // DEF-154 — the token proves something about a specific sentence, it is not a
  // pass. Each check below is a way the verified thing could differ from the
  // thing about to be shown, and each fails closed to the receipt.
  if (record.prose !== prose) return true;                                   // replayed onto other prose
  if (record.receipt !== receipt) return true;                               // applied values changed
  if (record.artifactId !== (actionResult?.artifactId ?? null)) return true; // different artifact

  return !isUsableBrainProse(prose);
}

/** Test-only: proves a hand-built or cast token is rejected at runtime. */
export function __isIssuedToken(token: unknown): boolean {
  return !!token && typeof token === 'object' && tokenRecords.has(token as object);
}
