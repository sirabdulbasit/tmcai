/**
 * DEF-038 — should Brain ask before doing this?
 *
 * Owner ruling, 2026-08-05: *"Brain should only confirm if I asked anything to
 * do which is not normal, or may contain any risk — so after pointing the risk
 * Brain can seek confirmation."*
 *
 * And the sharper version he gave first: *"why do I need to say 'send' where I
 * am instructing?"* Confirming PERMISSION he already granted adds nothing.
 * Confirming UNDERSTANDING — telling him something he does not know before it
 * happens — is what a good assistant does.
 *
 * WHY THIS IS NOT A RULE TABLE
 * "Abnormal" and "risky" are judgements about meaning in context, which the
 * standing no-hardcoded-judgement rule reserves for the model. A regex on
 * "delegate" would be the DEF-013 class again. What the code contributes is
 * FACTS — has this person been contacted before, can it be undone, whose name
 * is on it — and the model weighs them.
 *
 * TWO PROPERTIES THAT MATTER MORE THAN ACCURACY
 *
 *  1. Fails closed. Errors, low confidence, or the model being unsure about
 *     its own assessment all resolve to "ask". Skipping a needed preview sends
 *     a real message to a real person; showing an unneeded one costs a tap.
 *
 *  2. Novelty decays. With no history every counterpart is unfamiliar, so a
 *     new Brain asks often and a proven one asks rarely — the earned trust the
 *     owner described falls out of the facts rather than being a feature.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import type { ComposedAction, ComposerHistoryTurn } from './brainComposer';

const log = createLogger('confirmation-policy');

export interface ConfirmationVerdict {
  needsConfirmation: boolean;
  /** Short, human reason. When confirmation IS needed this becomes the thing
   *  Brain names to the owner — never a bare "shall I proceed?". */
  reason: string;
}

const ASK = (reason: string): ConfirmationVerdict => ({ needsConfirmation: true, reason });

/** Actions that reach another human under the owner's identity. Everything
 *  else is internal bookkeeping he can undo. This is a fact about the action,
 *  not a judgement about the request. */
const REACHES_A_PERSON = new Set([
  'send_email', 'notify_via_whatsapp', 'delegate_open_item',
  'schedule_meeting', 'cancel_meeting', 'reschedule_meeting',
]);

/** Facts the model needs, gathered from the database rather than guessed. */
async function gatherFacts(act: ComposedAction, userId: number): Promise<Record<string, unknown>> {
  // DEF-076 — ANCHOR TODAY.
  //
  // 2026-08-06 10:14, on a routine ask: "The last contact date with Hamna is in
  // the future (2026). Is this correct?" It is 2026. The model had no current
  // date, so it fell back on its own sense of the year and invented a
  // contradiction — then correctly asked about it. A sound gate on a false
  // premise. Same family as DEF-026, where the prompt had the date but no clock.
  const facts: Record<string, unknown> = {
    today: new Date().toISOString().slice(0, 10),
    action: act.type,
    reachesAPerson: REACHES_A_PERSON.has(act.type),
    // A sent message cannot be unsent; an open-item edit can.
    reversible: !REACHES_A_PERSON.has(act.type),
  };

  const candidateId = (act as any).recipientCandidateId
    ?? (act as any).delegateeCandidateId
    ?? (Array.isArray((act as any).toCandidateIds) ? (act as any).toCandidateIds[0] : undefined);

  if (typeof candidateId === 'string' && candidateId) {
    try {
      const contact = await prisma.entity.findFirst({
        where: { id: candidateId, entityType: 'contact' },
        select: { name: true, lastInteraction: true, relationshipStrength: true },
      });
      if (contact) {
        facts.recipientName = contact.name;
        // Never contacted before is the single strongest reason to check.
        facts.contactedBefore = contact.lastInteraction != null;
        facts.lastContact = contact.lastInteraction?.toISOString().slice(0, 10) ?? null;
      } else {
        facts.recipientResolves = false;
      }
    } catch { /* absent facts make the model MORE cautious, which is correct */ }
  }

  if ((act as any).recipientAdHocPhone || (Array.isArray((act as any).toAdHoc) && (act as any).toAdHoc.length)) {
    // A raw number or address the owner typed, with no contact record behind it.
    facts.adHocRecipient = true;
  }

  return facts;
}

export async function assessConfirmationNeed(input: {
  action: ComposedAction;
  question: string;
  history: ComposerHistoryTurn[];
  userId: number;
}): Promise<ConfirmationVerdict> {
  const facts = await gatherFacts(input.action, input.userId);

  // An unresolved recipient is refused by actionTargetGuard anyway, but if we
  // get here it is unambiguously worth asking about.
  if (facts.recipientResolves === false) return ASK('I could not match that person to a contact');

  const lastBrain = [...input.history].reverse().find((h) => h.role === 'brain')?.text ?? '';

  try {
    const { callGemini } = await import('../geminiService');
    const systemPrompt = `You decide whether an assistant should CHECK WITH ITS OWNER before carrying out something the owner just asked for.

The owner's own rule: "Only confirm if I asked something which is not normal, or may contain risk — and then only after pointing out the risk."

Confirm when, and only when, the check-in would tell the owner something he does not already know. Examples that DESERVE a check:
- the recipient has never been contacted before
- the request is unusually large or sweeping compared to a normal ask
- the content is sensitive, or could embarrass the owner
- the instruction is ambiguous about who or what
- something in the facts looks stale, wrong, or contradictory

TODAY'S DATE IS GIVEN TO YOU in facts.today. Use it and nothing else. Any date on
or before it is in the PAST. Never call a date "in the future" from your own
sense of what year it is — on 2026-08-06 that produced a confirmation over a
last-contact date of 2026, which was simply yesterday.

Do NOT confirm merely because an action sends a message. The owner instructed it; repeating his instruction back is not information. Routine, clearly-worded requests to known people should just happen.

THE DEFAULT IS TO ACT. The owner has said twice that unnecessary confirmation is
the single thing he most dislikes about this assistant. A question you cannot
finish — "…and here is what he does not already know: ___" — is not worth
asking. If the only thing you would tell him is that you are about to do what he
just asked, act.

Reply with JSON only:
{"needsConfirmation": boolean, "reason": "<= 15 words, what you'd tell him>", "confidence": 0..1}

Set "confidence" to how sure you are that the check-in is WORTH MAKING — that it
carries something the owner does not already know. If you are unsure, say so with
a LOW confidence rather than defaulting to true: being unsure whether a check is
warranted is not a reason to make it. Reserve high confidence for a concrete,
nameable concern.`;

    const userPrompt = `Owner's message: ${JSON.stringify(input.question)}
Brain's previous message: ${JSON.stringify(lastBrain.slice(0, 300))}
Action about to run: ${JSON.stringify(input.action).slice(0, 800)}
Facts: ${JSON.stringify(facts)}`;

    const raw = await callGemini(systemPrompt, userPrompt);
    const parsed = JSON.parse(String(raw).replace(/```json|```/g, '').trim());
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

    // ── DEF-079 — CONFIDENCE DECIDES, and the owner sets the bar ─────
    //
    // This used to read: `confidence < 0.6 → ASK`. So being UNSURE produced a
    // question, which is backwards for someone whose standing complaint is
    // being asked to confirm things he just instructed. Uncertainty about
    // whether a check is warranted is not a reason to run the check.
    //
    // Now it asks only when the assessment is CONFIDENT the check-in carries
    // information he lacks. The bar is `confirmation.min_confidence_pct`
    // (default 75), a tenant config — his knob, tunable without a deploy,
    // rather than a magic number I chose.
    //
    // The two hard cases below this are unchanged and deliberately not
    // governed by confidence: an unresolved recipient and a failed assessment
    // mean we cannot judge at all, which is different from judging "routine".
    const { getBehaviorValue } = await import('../behaviorConfig');
    const minPct = await getBehaviorValue('confirmation.min_confidence_pct', { userId: input.userId })
      .catch(() => 75);
    const bar = Math.max(0, Math.min(100, minPct)) / 100;

    if (parsed.needsConfirmation === true && confidence >= bar) {
      return ASK(reason || 'worth checking first');
    }
    return {
      needsConfirmation: false,
      reason: parsed.needsConfirmation === true
        ? `${reason || 'possible concern'} — below the ${Math.round(bar * 100)}% bar, acting`
        : (reason || 'routine and clearly instructed'),
    };
  } catch (error: any) {
    log.warn('confirmation assessment failed — defaulting to ask', {
      error: error?.message?.slice(0, 200),
    });
    return ASK('could not assess this one, so checking');
  }
}
