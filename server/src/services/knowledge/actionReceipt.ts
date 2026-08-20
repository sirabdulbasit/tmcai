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

/**
 * The most recent thing BRAIN said, which is the only turn that can have left a
 * question open.
 *
 * DEF-219 — IT READS `text`, AND THAT IS THE WHOLE DEFECT THIS FIXES.
 *
 * The composer's history turn is `ComposerHistoryTurn = { role; text }`. This
 * function read `t.content`, which is `undefined` on every real call, so
 * `String(undefined)` became the string "undefined", `isQuestionTurn` said no,
 * and it returned **null in production, always**.
 *
 * Everything downstream then behaved exactly as though Brain had never asked a
 * question: `requestedSlots(null)` is `[]`, so `outstandingSlots` is `[]`, so
 * DEF-209's proceeding marker named no slot, DEF-212's applied marker rendered
 * as the bare receipt (its no-slots branch returns the receipt verbatim), and
 * DEF-215's "ASK FOR IT IN THIS REPLY" could never fire. Three consecutive
 * fixes were dead on arrival on one field name.
 *
 * My tests did not catch it because every one of them built its own
 * `{ role, content }` fixture instead of the type the composer actually passes.
 * A fixture I invent cannot disagree with me; the real type can.
 *
 * Both keys are accepted because other call sites may hold either shape, and a
 * reader that understands only one of them is how this happened.
 */
export interface HistoryTurnLike {
  role?: string;
  /** The composer's field (`ComposerHistoryTurn`). */
  text?: string;
  /** The chat-message field some other producers use. */
  content?: string;
}

export function lastBrainQuestion(history: HistoryTurnLike[] | null | undefined): string | null {
  const turns = Array.isArray(history) ? history : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (String(t?.role ?? '') === 'user') continue;   // walk back past the answer
    const said = t?.text ?? t?.content ?? '';
    return isQuestionTurn(String(said)) ? String(said) : null;
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
 * DEF-220 — and it stops being ENGLISH at all.
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
 * move, and I am not touching that judgement.
 *
 * DEF-212 made the receipt the PAYLOAD of this marker instead of the sentence.
 * It did not go far enough, and I said so on the record when I shipped it: the
 * payload was still the rendered English string, so when NOTHING was
 * outstanding the curated meaning returned that string verbatim and the owner
 * read `Updated "…": priority=high.` anyway. DEF-219 then made that branch the
 * COMMON one — before it, `outstanding` was empty on every real call for a
 * different reason, and afterwards it is empty exactly when Brain had no open
 * question, which is most turns.
 *
 * So the marker carries FIELDS AND VALUES, never a sentence. `APPLIED_FIELDS`
 * below is the one vocabulary for saying each of them, the curated meaning in
 * `answerSanitizer` composes the fact from it, and `sanitizeAnswerInBrainVoice`
 * chooses the final words. The hand-built receipt stays exactly what DEF-144
 * ruled it should be — the audit record — and no longer has a route to his
 * screen. This is the structural half the earlier patches kept deferring: the
 * channel that carried deterministic English is gone, rather than its current
 * occupant reworded.
 */

interface AppliedFieldSpec {
  key: string;
  /** How the fact states this field. `value` is already non-empty. */
  say: (value: string) => string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-08-20` → `20 Aug 2026`, by string surgery.
 *
 * Deliberately NOT via `new Date(...)`: DEF-214 was a whole defect class built
 * out of a date value that changed meaning when a zone was applied to it. This
 * is a calendar date with no instant in it, and nothing here can shift it by a
 * day. Anything that is not exactly `YYYY-MM-DD` is passed through untouched.
 */
function readableDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return value;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/**
 * The fields an update can apply, and the ONE way each is said to the owner.
 *
 * Keyed by the Prisma payload field, so the fact is derived from what the
 * database received rather than from what the model asked for — the DEF-147
 * discipline, unchanged.
 */
export const APPLIED_FIELDS: AppliedFieldSpec[] = [
  { key: 'priority', say: (v) => `its priority is now ${v.toLowerCase()}` },
  { key: 'dueDate', say: (v) => `it is now due on ${readableDate(v)}` },
  { key: 'title', say: (v) => `it is now called "${v}"` },
  {
    key: 'status',
    // The only status this branch writes is DRAFT → NEW, and "NEW" is a word
    // from the schema, not from his vocabulary.
    say: (v) => (v.toUpperCase() === 'NEW'
      ? 'it is now a live item rather than a draft'
      : `its status is now ${v.toLowerCase()}`),
  },
  // The note is carried so the fact can mention it, but never printed: a
  // description can be paragraphs long, and a fact that quotes one in full stops
  // being a fact and becomes the reply.
  { key: 'description', say: () => 'its note has been updated' },
];

export interface AppliedChange { f: string; v: string }

/**
 * The applied fields of a Prisma update payload, in `APPLIED_FIELDS` order.
 *
 * A `Date` becomes its calendar date; everything else its trimmed string. An
 * empty or absent value is not an applied change — the same rule `filledSlots`
 * uses, and for the same reason: claiming a field was set when it was not is
 * the `fabricated-status` class.
 */
export function appliedChanges(payload: Record<string, unknown> | null | undefined): AppliedChange[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const out: AppliedChange[] = [];
  for (const spec of APPLIED_FIELDS) {
    const raw = p[spec.key];
    if (raw === undefined || raw === null) continue;
    const v = raw instanceof Date
      ? raw.toISOString().slice(0, 10)
      : String(raw).replace(/\s+/g, ' ').trim();
    if (!v) continue;
    out.push({ f: spec.key, v: v.slice(0, 200) });
  }
  return out;
}

/** Builder and verifier must agree byte for byte, so both normalise here. */
export function normaliseApplied(applied: readonly AppliedChange[] | undefined): AppliedChange[] {
  const known = new Set(APPLIED_FIELDS.map((s) => s.key));
  return (applied ?? [])
    .filter((c) => c && known.has(c.f) && String(c.v ?? '').trim().length > 0)
    .map((c) => ({ f: c.f, v: String(c.v).replace(/\s+/g, ' ').trim().slice(0, 200) }))
    .slice(0, 6);
}

/**
 * The exact segment of the marker body that identifies WHICH update this is.
 *
 * `verifyAppliedMarker` checks the marker contains it, so a token cannot be
 * replayed onto a marker for a different item or a different set of applied
 * values. It is a substring by construction because `actionAppliedMarker`
 * serialises these two keys first, in this order.
 */
export function appliedFingerprint(title: string, applied: readonly AppliedChange[] | undefined): string {
  return `"title":${JSON.stringify(String(title ?? '').trim().slice(0, 200))}`
    + `,"applied":${JSON.stringify(normaliseApplied(applied))}`;
}

export function actionAppliedMarker(args: {
  title: string;
  applied: readonly AppliedChange[];
  outstanding?: readonly string[];
}): string {
  const title = String(args.title ?? '').trim().slice(0, 200);
  const applied = normaliseApplied(args.applied);
  const known = new Set(RECEIPT_SLOTS.map((s) => s.key));
  const outstanding = (args.outstanding ?? []).filter((k) => known.has(k)).slice(0, 4);
  return systemMarker(`applied: ${JSON.stringify({ title, applied, outstanding })}`);
}

// ─── DEF-238 — the item-action OUTCOME, in a vocabulary the renderer knows ───
//
// Measured on production, 2026-08-19 22:23 (owner turn S38): "delete all open
// items" EXECUTED — `open_items` row cmsotakwf0006rts1bdsrjjkj went CANCELLED
// at 22:23:40.059 — and the owner was told "I couldn't put together an answer
// I trust for that one." The executor returned `[removed: "…"]`, a receipt
// hand-written in `internalActionExecutors`, and `curatedMarkerMeaning` has no
// rule for it (nor for ANY of that file's nine marker strings), so the
// sanitizer swallowed a SUCCESSFUL deletion into the neutral fallback. The
// 20:09 DRAFT refusal died the same way: `[remove_open_item: not removed —
// current status DRAFT …]` also has no curated meaning, which is why he got
// "a message he could do nothing with" instead of the reason.
//
// The class is two hand-maintained lists that can disagree: executors mint
// receipt strings over here, curated meanings live over there, and nothing
// makes a new receipt renderable. So the constructor and the renderer now
// live in THIS module and share one payload vocabulary: a receipt built by
// `itemOutcomeMarker` is renderable by `itemOutcomeMeaning` by construction,
// and a payload the constructor could not have minted is rejected, not
// repaired (the DEF-175 rule, same as the applied/digest/withdrawal markers).
//
// The meaning is a FACT with no embedded instructions, because it has two
// consumers: the whole-marker path hands it to `renderMarkerInBrainVoice`
// (the model phrases it — wording belongs to the model), and the confirmed
// multi-step plan path joins it into a per-step results list where no model
// pass follows.

export type ItemOutcomeVerb = 'removed' | 'closed';

const ITEM_OUTCOME_VOCAB: Record<ItemOutcomeVerb, { did: string; attempt: string }> = {
  removed: {
    did: 'was removed from his open items just now — cancelled, not deleted, so it can be restored if he changes his mind',
    attempt: 'removal',
  },
  closed: {
    did: 'was marked done and closed just now',
    attempt: 'closing',
  },
};

export function itemOutcomeMarker(o: {
  verb: ItemOutcomeVerb;
  ok: boolean;
  title?: string | null;
  why?: string | null;
}): string {
  const title = String(o.title ?? '').trim().slice(0, 200);
  const payload: Record<string, unknown> = { verb: o.verb, ok: !!o.ok };
  if (title) payload.title = title;
  // A failure with no recorded reason still says so honestly — "no reason"
  // is the fact then, never an invented one.
  if (!o.ok) payload.why = String(o.why ?? '').trim().slice(0, 300) || 'the system recorded no reason';
  return systemMarker(`item_outcome: ${JSON.stringify(payload)}`);
}

export function itemOutcomeMeaning(answer: string): string | null {
  const m = /^\s*\[item_outcome:\s*(\{.*\})\s*\]\s*$/.exec(answer ?? '');
  if (!m) return null;
  try {
    const p = JSON.parse(m[1]);
    const vocab = ITEM_OUTCOME_VOCAB[p?.verb as ItemOutcomeVerb];
    if (!vocab || typeof p?.ok !== 'boolean') return null;
    const title = typeof p?.title === 'string' && p.title.trim() && p.title.length <= 200
      ? p.title.trim()
      : null;
    if (p.ok) {
      // A success must name what it acted on — an unnameable success reads
      // as a claim with no referent, which is the fabricated-status shape.
      if (!title) return null;
      return `The open item "${title}" ${vocab.did}.`;
    }
    const why = typeof p?.why === 'string' && p.why.trim() && p.why.length <= 300
      ? p.why.trim()
      : null;
    if (!why) return null;
    return `The ${vocab.attempt} of ${title ? `the open item "${title}"` : 'that item'} did not happen`
      + ` and nothing was changed. The system's reason: ${why}`;
  } catch {
    return null;
  }
}
