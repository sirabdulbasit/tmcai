/**
 * DEF-209 — the action receipt, and the part of Brain's own question that was
 * never answered.
 *
 * `B04-outstanding-question-ignored` regressed hard (mean 94.4 -> 73.8) and the
 * reply was three words of template:
 *
 *     "Proceeding with update open item."
 *
 * That string is `reasoningCompose.applyDispatch.ts`'s fallback, fired whenever
 * the decider returns an action without prose. Two separate defects sit in it,
 * and both are the recurrence classes in the chart:
 *
 * 1. `guard-destroys-the-answer` — a deterministic receipt IS the owner's reply.
 *    The other site says so out loud: "replace whatever confused prose the main
 *    compose produced with a neutral descriptive line" (brainComposer.ts). Codex
 *    named this exact member: "DEF-144 showed the equivalent success-renderer
 *    failure, where a deterministic receipt replaced useful model prose." It is
 *    also hardcoded English pretending to be Brain, which the standing memory
 *    rule (feedback_no_hardcoded_brain_replies) forbids outright — every reply is
 *    LLM-generated or a bracketed marker, and this was neither.
 *
 * 2. THE OUTSTANDING QUESTION. Brain asked for a priority AND a deadline; the
 *    owner supplied the priority; Brain dispatched and never mentioned the
 *    deadline again. The judge, on four criteria: "Brain only handled the
 *    'priority' part of its original question, completely ignoring the
 *    'deadline'." The owner-visible requirement in Codex's analysis is verbatim
 *    this: "Removing a false clause must preserve valid sentences AND UNANSWERED
 *    QUESTIONS."
 *
 * The structural point, and why this is not another string edit: neither receipt
 * site could have got this right, because neither was ever told what the previous
 * turn asked for. The information exists — Brain's own last message is in the
 * history and the filled slots are in the action payload — and nothing compared
 * them. This module does the comparison ONCE and emits a structured marker; the
 * curated meaning in `answerSanitizer` turns it into the fact, and
 * `sanitizeAnswerInBrainVoice` chooses the words. Same discipline as DEF-206's
 * `[declined: …]`, and the same reason: the framing is decided in one place
 * instead of by whichever renderer happened to run.
 */

import { systemMarker } from './systemMarker';

/**
 * The slots Brain can ask for and then fail to chase. Deliberately SHORT: each
 * entry has to be defensible from a real question, because a false positive
 * invents an outstanding question the owner was never asked, which is a
 * fabricated-status defect pointing the other way.
 *
 * `payloadKeys` are the field names the action layer already uses
 * (`renderMissingSlotPrompt`'s SLOT_PROMPTS keys), so "was it filled?" is read
 * from the action rather than guessed from prose.
 */
interface SlotSpec {
  key: string;
  /** How Brain words the request when it asks for this slot. */
  asked: RegExp;
  /** Action-payload fields that mean the slot IS filled. */
  payloadKeys: string[];
  /** How the fact names it to the owner. */
  label: string;
}

export const RECEIPT_SLOTS: SlotSpec[] = [
  {
    key: 'priority',
    asked: /\bpriorit(?:y|ies)\b/i,
    payloadKeys: ['priority'],
    label: 'the priority',
  },
  {
    key: 'dueDate',
    asked: /\b(?:due date|deadline|due by|by when|when (?:is|it'?s|should) [^.?!]{0,30}\bdue)\b/i,
    payloadKeys: ['dueDate', 'due_date', 'dueAt', 'whenIso'],
    label: 'the due date',
  },
  {
    key: 'owner',
    asked: /\b(?:assignee|who (?:should )?(?:owns?|handles?|is responsible)|assign(?:ed)? (?:it )?to|delegate (?:it )?to)\b/i,
    payloadKeys: ['delegateeName', 'delegateeEmail', 'assignee', 'owner', 'ownerId', 'assignedTo'],
    label: 'the owner',
  },
  {
    key: 'title',
    asked: /\b(?:what(?:'s| is) the title|title or topic|what should I call it)\b/i,
    payloadKeys: ['title', 'name'],
    label: 'the title',
  },
];

/** Was this turn of Brain's a question at all? Only a question can leave one open. */
export function isQuestionTurn(text: string | null | undefined): boolean {
  return /\?/.test(String(text ?? ''));
}

/** The slots Brain's previous message actually asked for. */
export function requestedSlots(priorQuestion: string | null | undefined): string[] {
  const q = String(priorQuestion ?? '');
  if (!isQuestionTurn(q)) return [];
  return RECEIPT_SLOTS.filter((s) => s.asked.test(q)).map((s) => s.key);
}

/**
 * The slots this action actually sets. A key present with an empty string, null
 * or an empty array is NOT filled — treating it as filled is how a slot goes
 * silently unchased.
 */
export function filledSlots(payload: Record<string, unknown> | null | undefined): string[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  return RECEIPT_SLOTS.filter((s) => s.payloadKeys.some((k) => {
    const v = p[k];
    if (v === undefined || v === null) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  })).map((s) => s.key);
}

/** Asked for, and still not supplied. */
export function outstandingSlots(
  priorQuestion: string | null | undefined,
  payload: Record<string, unknown> | null | undefined,
): string[] {
  const filled = new Set(filledSlots(payload));
  return requestedSlots(priorQuestion).filter((k) => !filled.has(k));
}

/** The most recent thing BRAIN said, which is the only turn that can have left
 *  a question open. Callers hand us the composer's history shape. */
export function lastBrainQuestion(
  history: Array<{ role?: string; content?: string }> | null | undefined,
): string | null {
  const turns = Array.isArray(history) ? history : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const role = String(t?.role ?? '');
    if (role === 'user') continue;              // keep walking back past the answer
    const content = String(t?.content ?? '');
    return isQuestionTurn(content) ? content : null;
  }
  return null;
}

const ACTION_PHRASES: Record<string, string> = {
  update_open_item: 'the update to the open item',
  create_open_item: 'the new open item',
  delegate_open_item: 'the delegation',
  send_email: 'the email',
  notify_via_whatsapp: 'the WhatsApp message',
  schedule_meeting: 'the meeting',
  update_contact: 'the contact update',
};

export function actionPhrase(actionType: string): string {
  const t = String(actionType ?? '').trim();
  return ACTION_PHRASES[t] ?? `the ${t.replace(/_/g, ' ')}`.replace(/\s+/g, ' ').trim();
}

/**
 * The marker. Two properties, both learned the hard way by other markers:
 *
 *   - JSON body (DEF-175): escaping is the field boundary, so an action type or
 *     label can never terminate its own field and inject something the
 *     constructor never asserted;
 *   - `systemMarker()` PROVENANCE (DEF-169): the sentinel is what makes this a
 *     marker rather than a string that happens to have brackets. `isWholeMarker`
 *     is only a shape test — and its shape regex rejects the `]` inside a JSON
 *     array, so a bare bracketed payload would silently never be rendered at
 *     all. Provenance decides, exactly as it does for the digest and withdrawal
 *     markers, which carry arrays for the same reason.
 */
export function actionReceiptMarker(args: {
  actionType: string;
  payload?: Record<string, unknown> | null;
  priorQuestion?: string | null;
}): string {
  const outstanding = outstandingSlots(args.priorQuestion, args.payload).slice(0, 4);
  const payload = { action: String(args.actionType ?? ''), outstanding };
  return systemMarker(`proceeding: ${JSON.stringify(payload)}`);
}

/**
 * DEF-211 — a clarifying question must not DELETE the answer.
 *
 * `B03-pronoun-followup` C5 95 -> 75. The whole reply was:
 *
 *     "When you say 'what about it', are you asking for more details, or do you
 *      want me to take an action regarding the Q3 headcount plan?"
 *
 * Judge: *"Brain asks for clarification, which is appropriate for a vague query.
 * However, it could have made an intelligent guess and OFFERED INFORMATION
 * FIRST."* And it could have — the subject was resolved well enough to name it
 * in the question.
 *
 * This is the same class as DEF-205/206 (decline) and DEF-209 (act), on the two
 * branches I left behind: `applyReasoningDecision`'s `ask` case returned
 * `question.text` and ignored `answerText` COMPLETELY, and the legacy decider's
 * `missingSlot` arm — three lines below the arm DEF-209 repaired — overwrote the
 * composed prose with a slot prompt. Substance the owner could have used was
 * discarded because a question also needed asking. Those are not alternatives.
 *
 * The order is deliberate: what is known FIRST, the open question after. A reply
 * that opens with a question makes the owner answer before he learns anything;
 * the same two sentences the other way round answer him and then ask.
 */
/** Lowercased, punctuation-flattened, whitespace-collapsed. Two sentences that
 *  differ only in capitalisation, spacing or a trailing full stop are the same
 *  sentence for the purpose of "have we already said this?". */
function sameSentenceKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Split on sentence enders, keeping the ender so a question stays a question. */
function sentencesOf(text: string): string[] {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function answerThenAsk(
  answer: string | null | undefined,
  question: string | null | undefined,
): string {
  const a = String(answer ?? '').trim();
  const q = String(question ?? '').trim();
  if (!a) return q;
  if (!q) return a;

  // DEF-216 — SENTENCE BY SENTENCE, not whole-string.
  //
  // `if (a.includes(q)) return a` only caught a byte-identical repeat, and
  // `B02-unknown-fact` showed what that misses. The prose already ended with
  // *"Shall I create a new contact for her?"*; the decider's question was
  // *"I can't seem to find Hamna Latif Bhutta in your contacts list to get her
  // number. Shall I create a new contact for her?"* — a longer string whose TAIL
  // duplicates the prose and whose HEAD restates the prose's opening. Neither
  // was a substring of the answer, so both shipped and he read the question
  // twice (C5 95 -> 60, C3 95 -> 75, C4 90 -> 70).
  //
  // So each sentence of the question is kept only if the answer does not already
  // say it. That drops the duplicated ask AND the restated finding, which is the
  // half a simple "don't repeat the question" check would still have got wrong.
  const said = new Set(sentencesOf(a).map(sameSentenceKey));
  const fresh = sentencesOf(q).filter((sentence) => !said.has(sameSentenceKey(sentence)));

  // Every sentence was already said — the answer asked it itself. Nothing to add.
  if (fresh.length === 0) return a;
  // Nothing was said before: keep the question whole rather than reassembled, so
  // a question the splitter mis-cut is never reworded on its way to him.
  if (fresh.length === sentencesOf(q).length) return `${a}\n\n${q}`;
  return `${a}\n\n${fresh.join(' ')}`;
}

/**
 * DEF-212 — the receipt survives as FACT without being the owner's sentence.
 *
 * B04's reply came back as `Updated "Define rules for Brain's responsiveness to
 * new vs. existing contacts": priority=high.` — field names and an equals sign,
 * the exact string DEF-144 and DEF-145 were written about. The path is
 * `brainComposer`'s update branch: when `verifyUpdateProse` cannot positively
 * justify the composed answer it does `answer = actionResult.message`, and the
 * deterministic receipt becomes the reply.
 *
 * That fallback is RIGHT about truth and WRONG about everything else. The
 * receipt is true by construction — it lists what the database actually
 * received — so replacing unverifiable prose with it is the correct fail-closed
 * move, and I am not touching that judgement. What it also does is throw away
 * the outstanding half of Brain's own question (DEF-209) and hand the owner a
 * log line.
 *
 * So the receipt stops being the SENTENCE and becomes the PAYLOAD: the curated
 * meaning states it verbatim — no rewording, nothing added to the claim — and
 * then names whatever the owner still has not answered. `sanitizeAnswerInBrainVoice`
 * chooses the words from that fact. Nothing about what was written is softened,
 * asserted or inferred; the receipt text travels intact.
 */
export function actionAppliedMarker(args: {
  receipt: string;
  outstanding?: readonly string[];
}): string {
  const receipt = String(args.receipt ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const known = new Set(RECEIPT_SLOTS.map((s) => s.key));
  const outstanding = (args.outstanding ?? []).filter((k) => known.has(k)).slice(0, 4);
  return systemMarker(`applied: ${JSON.stringify({ receipt, outstanding })}`);
}
