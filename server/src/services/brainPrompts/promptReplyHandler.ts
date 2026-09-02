/**
 * MyOS — Brain prompt reply handler.
 *
 * Bridges inbound user messages to the prompt queue. When a user has a
 * prompt in `awaiting_reply`, their next inbound message is treated as
 * the answer to that prompt, NOT as a normal Brain chat turn.
 *
 * Pipeline:
 *   1. Look up the user's awaiting_reply prompt.
 *   2. If none → return { handled: false } so caller proceeds with
 *      normal chat routing.
 *   3. If found → record the answer, apply the side-effect, ack the
 *      user with a short confirmation, and dispatch the next queued
 *      prompt.
 *
 * Side-effects supported (extend as new producers are added):
 *   set_due_date    — parses the answer as a date phrase, sets dueDate
 *                     on the linked open item.
 *   assign_owner    — sets delegateeName + delegateeEmail on the open
 *                     item from the answer.
 *   free_form_note  — appends the answer as a note on the open item.
 *   noop            — record the answer only; no item update.
 *
 * Date parsing is intentionally simple — no external library. Recognizes
 * "today / tomorrow / friday / next monday / yyyy-mm-dd / N days". Edge
 * cases fall back to recording the raw answer + flagging the item with
 * metadata.dueDateNeedsClarification=true so a human can see the gap.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { getAwaitingPrompt, getAnswerableQuestions, reviveExpiredPrompt, recordAnswer, sendNextPrompt } from './brainPromptQueueService';

const log = createLogger('prompt-reply-handler');

export interface HandleReplyInput {
  userId: number;
  /** Verbatim text the user sent. */
  text: string;
  /**
   * Tenant this user belongs to. Correlation is per-user under a tenant —
   * never a global "the owner" (owner instruction, 2026-08-07: *"nothing should
   * be hardcoded related me it should be user under tenant/client"*).
   * REQUIRED (DEF-176): this used to be optional with an unscoped
   * single-prompt fallback — the exact cross-tenant read class DEF-091 closed,
   * living on in a branch. Every real caller has the tenant in hand.
   */
  clientNumber: string;
}

export interface HandleReplyResult {
  /** True when this message was consumed as a prompt answer. Caller
   *  should NOT route it to the normal chat handler. */
  handled: boolean;
  /** What Brain should reply back to the user (the ack). Caller is
   *  responsible for sending it on the same channel the user wrote on. */
  ackMessage?: string;
  /** Side-effect outcome for telemetry. */
  sideEffectStatus?: 'applied' | 'failed' | 'noop' | 'unknown_kind';
  promptId?: string;
  /**
   * DEF-017: the part of a COMPOUND message that was NOT the answer, rewritten
   * as a standalone request. When present the caller MUST still route this
   * through the normal chat path — the answer half has been recorded, but the
   * instruction half has not been acted on yet. Ignoring it is the bug:
   * "Priority High, due date today and delegate to Hamna" previously had the
   * date and the delegation silently discarded.
   */
  residualText?: string;
  /**
   * DEF-093: the question the user was answering.
   *
   * Exposed so the piggyback extractor can judge the RESIDUAL rather than
   * re-reading the whole message blind. Without it, "High immediate" — a
   * perfectly good answer to "what priority and deadline?" — was read in
   * isolation, judged a new instruction, and became an open item titled "High
   * immediate" on 2026-08-07 22:09.
   */
  answeredQuestion?: string;
}


/**
 * The questions this user could still plausibly be answering, newest first.
 *
 * DEF-176: the tenantless fallback that lived here is deleted, not kept for
 * compatibility — its own comment admitted it was the DEF-091 read class.
 * `clientNumber` is required at the type level now.
 */
async function findCandidates(input: HandleReplyInput) {
  const { getBehaviorValue } = await import('../behaviorConfig');
  const ctx = { userId: input.userId, clientNumber: input.clientNumber };
  const [lookbackHours, limit] = await Promise.all([
    getBehaviorValue('prompt_reply.lookback_hours', ctx).catch(() => 24),
    getBehaviorValue('prompt_reply.max_candidates', ctx).catch(() => 5),
  ]);
  return getAnswerableQuestions({
    userId: input.userId,
    clientNumber: input.clientNumber,
    lookbackHours,
    limit,
  });
}

/**
 * Markers the media pipelines fold into an inbound turn when Brain has OBSERVED something —
 * currently an image reading and a voice transcript. Kept as one regex so the next channel that
 * learns to observe (email attachments, Google Chat images) inherits the DEF-241 rule for free
 * rather than rediscovering it.
 */
const OBSERVATION_MARKER = /\[image received\s*[—-]\s*contents:\]|\[voice note\]|\[transcript\]/i;

/**
 * DEF-274 — the claimant that was missing.
 *
 * `pending-prompt-eats-command`, 4th occurrence. The previous three fixes all narrowed WHICH
 * replies may be consumed: a `looksLikeAnswer` prefilter, then an LLM relevance gate, then
 * DEF-241's evidence rule. The guard comment below says in writing that *"a third narrowing of
 * the classifier would produce a fifth occurrence"* — so this adds no gate and touches no
 * classifier. It adds the bidder that never existed.
 *
 * CL-044: Brain asked *"Which numbers are you asking for, Sir?"* at 19:32:33; the owner said
 * *"yes"* at 19:32:42; a prompt DELIVERED SEVEN HOURS EARLIER consumed it and replied *"Okay,
 * I've noted that."* Both prompts were legitimately answerable — genuinely sent, inside the
 * lookback. Nothing about them was wrong. The hole is that Brain's own question, nine seconds
 * old, was not a candidate at all, so the queue was the only bidder for that reply.
 *
 * A queued prompt is a question the owner may answer WHENEVER. A question Brain just asked in
 * conversation is one he is answering NOW. When both want the same reply, the live conversation
 * wins — and it must win before the classifier, where no confidence score can override it.
 */
const CONVERSATION_WINDOW_MINUTES = 10;
/**
 * A prompt is delivered to the owner as an ordinary outbound WhatsApp message, and it ends in a
 * question mark like any other. So "the last turn was a question" cannot be the whole test: it
 * would decline the answer to the very prompt that asked it and break the queue entirely.
 *
 * Prompt deliveries are distinguished by TIME, not text — text is deliberately not comparable,
 * because the model owns the wording of every prompt it sends. If a prompt was sent within
 * seconds of that outbound turn, the turn IS that prompt, and the queue keeps its claim.
 */
const PROMPT_DELIVERY_TOLERANCE_MS = 90_000;

async function brainJustAskedAConversationalQuestion(
  input: HandleReplyInput,
  text: string,
): Promise<{ asked: string } | null> {
  // Whole body guarded, and NOT with a per-call `.catch`. This declines consumption, so if it
  // cannot tell what happened it must return null and leave the queue exactly as it was —
  // never throw into the reply path and cost the owner his answer entirely.
  //
  // `.catch()` was not enough and the DEF-241 suite proved it: a promise-returning call that is
  // missing altogether throws SYNCHRONOUSLY, before there is a promise for `.catch` to attach
  // to. My own "falls through safely" test used a rejected promise and sailed past the gap.
  try {
    return await findBrainsLiveQuestion(input, text);
  } catch (err: any) {
    log.debug('could not read the conversation — leaving the queue untouched', {
      error: String(err?.message ?? err).slice(0, 120),
    });
    return null;
  }
}

async function findBrainsLiveQuestion(
  input: HandleReplyInput,
  text: string,
): Promise<{ asked: string } | null> {
  const norm = (v: string) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const rows = await prisma.$queryRawUnsafe<Array<{ direction: string; content: string; created_at: Date }>>(
    `SELECT direction, content, created_at
       FROM whatsapp_messages
      WHERE client_number = $1 AND user_id = $2
        AND created_at >= NOW() - ($3 || ' minutes')::interval
      ORDER BY created_at DESC
      LIMIT 6`,
    input.clientNumber, input.userId, String(CONVERSATION_WINDOW_MINUTES),
  ).catch(() => [] as any[]);

  // The turn being handled may already be stored; it is not its own predecessor.
  const before = rows.filter((r) => norm(r.content) !== norm(text));
  const last = before[0];
  if (!last || last.direction !== 'outbound') return null;
  const asked = norm(last.content);
  if (!asked.endsWith('?')) return null;

  const delivery = await prisma.brainPromptQueue.findFirst({
    where: {
      // Tenant-scoped, invariant #1 — a bare timestamp lookup is how cross-tenant reads happen.
      clientNumber: input.clientNumber,
      userId: input.userId,
      sentAt: {
        gte: new Date(new Date(last.created_at).getTime() - PROMPT_DELIVERY_TOLERANCE_MS),
        lte: new Date(new Date(last.created_at).getTime() + PROMPT_DELIVERY_TOLERANCE_MS),
      },
    },
    select: { id: true },
  }).catch(() => null);
  if (delivery) return null;   // that outbound WAS a prompt; the queue may answer it

  return { asked: asked.slice(0, 140) };
}

export async function handlePromptReply(input: HandleReplyInput): Promise<HandleReplyResult> {
  const text = input.text.trim();
  if (!text) return { handled: false };  // empty body — let normal flow ignore it

  // DEF-241 — A TURN CARRYING NEW EVIDENCE IS NOT A BARE REPLY.
  //
  // 2026-08-24 17:06 PKT. The owner sent a screenshot captioned "see". The image pipeline did
  // its job perfectly: 133 KB downloaded, Gemini returned 4,210 characters describing the page,
  // folded in as `see\n\n[image received — contents:]…`. Two seconds later this handler
  // correlated the turn to a 2-minute-old pending question at 0.9 confidence, filed it as a
  // `free_form_note`, and logged `consumed as prompt reply, sideEffect: noop`. The reading was
  // discarded, the turn never reached the composer and was never even persisted to `messages`.
  // He then got "Okay, I've seen that." and, when he asked what it had seen, "I found it, but I
  // couldn't get a clear read on its status" — Brain claiming a reading it had thrown away.
  //
  // `pending-prompt-eats-command` is the 4th occurrence of this tag. The previous two fixes both
  // narrowed WHICH replies may be consumed — a `looksLikeAnswer` regex prefilter, then an LLM
  // relevance gate. Both asked "is this an answer?"; neither asked "does consuming this DESTROY
  // something?". A third narrowing of the classifier would produce a fifth occurrence, so the
  // rule is structural instead: a turn containing an observation marker THIS SYSTEM generated —
  // an image reading, a voice transcript — is new evidence by construction, and evidence is not
  // an answer. It is declined here, BEFORE the classifier is consulted, so no confidence score
  // can override it.
  //
  // Deliberately narrow: only markers Brain itself mints. A human typing "[image]" is not
  // special, which is why the image marker is matched with its `contents:` payload rather than
  // as a bare word.
  if (OBSERVATION_MARKER.test(text)) {
    log.info('declined prompt consumption — turn carries new evidence', {
      userId: input.userId,
      marker: text.match(OBSERVATION_MARKER)?.[0] ?? null,
      reason: 'DEF-241: an observation is evidence, not an answer to a pending question',
    });
    return { handled: false };   // straight to the composer, contents intact
  }

  // DEF-095 — which question is this answering?
  //
  // This used to be one row in one state: `findFirst({ state: 'awaiting_reply' })`,
  // unordered. The owner hit the consequence on 2026-08-07 — he answered an hour
  // later and Brain had no idea what he was replying to. At that moment there
  // were ZERO rows in `awaiting_reply` and 119 expired ones, so the answer
  // correlated to nothing and was re-read as a new instruction.
  //
  // Now: the recent questions he could plausibly be answering, newest first,
  // still-awaiting before expired. Each is judged by the SAME relevance
  // classifier that already guarded the single-candidate path — no second
  // implementation of "does this answer that" (the DEF-039/041/074/078 shape),
  // and no keyword matching, because whether a message answers a question is a
  // judgement (owner ruling: no hardcoded judgement).
  const candidates = await findCandidates(input);
  if (candidates.length === 0) return { handled: false };

  // DEF-274 — a question Brain asked moments ago outranks any queued prompt. Declined here,
  // BEFORE the classifier, so no confidence score can override it (DEF-241's shape).
  const live = await brainJustAskedAConversationalQuestion(input, text);
  if (live) {
    log.info('declined prompt consumption — the user is answering Brain\'s own question', {
      userId: input.userId,
      asked: live.asked,
      candidates: candidates.length,
      reason: 'DEF-274: a live conversation outranks a queued prompt',
    });
    return { handled: false };   // straight to the composer, in context
  }

  // Each candidate gets the SAME two gates the single-candidate path always
  // had — the `looksLikeAnswer` prefilter, then the LLM relevance verdict. The
  // first candidate that genuinely answers wins; the rest are left untouched.
  //
  // Order matters only for which plausible question is TESTED first, never for
  // whether a wrong one can be accepted: a candidate the classifier declines is
  // skipped, exactly as before.
  const { classifyPromptReplyRelevance, mayConsumeAsAnswer, mayConsumePartially } =
    await import('./promptReplyRelevance');

  let awaiting: (typeof candidates)[number] | null = null;
  let sideEffectKind = 'noop';
  let verdict: Awaited<ReturnType<typeof classifyPromptReplyRelevance>> = null;

  for (const cand of candidates) {
    const kind = ((cand.sideEffect as any)?.kind as string | undefined) ?? 'noop';

    // Prefilter. Previously: ANY non-empty text was treated as the answer, so an
    // unrelated "Brief my day" got eaten as a date-parse attempt against a stale
    // set_due_date prompt and never reached the chat router.
    if (!looksLikeAnswer(text, kind)) {
      log.info('skipping prompt consumption — message doesn\'t look like an answer', {
        userId: input.userId, promptId: String(cand.id),
        sideEffectKind: kind, textPreview: text.slice(0, 60),
      });
      continue;
    }

    // Section 32B: looksLikeAnswer is only a PREFILTER — the final consumption
    // decision is LLM-with-context. Production 2026-07-22: "Whatsup?" slipped
    // past the regex and a greeting was recorded as an action-status answer.
    // Only a confident verdict may mutate; classifier failure included.
    const openItemTitle = cand.openItemId
      ? await prisma.openItem.findFirst({
          // Tenant-scoped: the title is read for a specific tenant's item, and
          // a bare id lookup is how cross-tenant reads happen (DEF-091).
          where: { id: cand.openItemId, clientNumber: cand.clientNumber },
          select: { title: true },
        }).then((r) => r?.title ?? null).catch(() => null)
      : null;

    const v = await classifyPromptReplyRelevance({
      pendingQuestion: cand.question,
      sideEffectKind: kind,
      openItemTitle,
      inboundText: text,
      clientNumber: cand.clientNumber,
      userId: input.userId,
    });

    if (mayConsumeAsAnswer(v) || mayConsumePartially(v)) {
      awaiting = cand; sideEffectKind = kind; verdict = v;
      if (candidates.length > 1) {
        log.info('correlated reply to an earlier question', {
          userId: input.userId, promptId: String(cand.id), state: cand.state,
          candidatesConsidered: candidates.length,
          ageMinutes: cand.sentAt ? Math.round((Date.now() - cand.sentAt.getTime()) / 60000) : null,
          relevance: v?.relevance ?? null,
        });
      }
      break;
    }

    log.info('relevance gate declined prompt consumption', {
      userId: input.userId, promptId: String(cand.id), sideEffectKind: kind,
      relevance: v?.relevance ?? 'classifier_failure',
      confidence: v?.confidence ?? null,
    });
  }

  // No candidate answered — route to chat with every question left as it was.
  if (!awaiting) return { handled: false };

  // DEF-095: an expired question the user has just answered is not expired.
  // Returned to `awaiting_reply` first so `recordAnswer`'s
  // `awaiting_reply → answered` transition stays truthful; a row jumping
  // `expired → answered` would make the queue's own history unreadable.
  if (awaiting.state === 'expired') {
    await reviveExpiredPrompt(awaiting.id, {
      userId: input.userId, clientNumber: input.clientNumber,
    }).catch((err) => {
      log.warn('could not revive expired prompt before recording answer', {
        promptId: String(awaiting!.id), err: err?.message,
      });
    });
  }

  const partial = mayConsumePartially(verdict);

  // DEF-017: on a partial match, ONLY the answering half is recorded and fed
  // to the side effect. The whole string used to be used, which is how
  // "Priority High, due date today and delegate to Hamna Latif" produced a
  // fabricated 2024-03-29 deadline — the date parser was handed the entire
  // sentence.
  const answerText = partial ? String(verdict!.answerPart).trim() : text;
  const residualText = partial ? String(verdict!.residual).trim() : undefined;

  log.info('handling prompt reply', {
    userId: input.userId, promptId: String(awaiting.id),
    sideEffectKind, relevanceConfidence: verdict!.confidence,
    partial, answerPreview: answerText.slice(0, 60),
    residualPreview: residualText?.slice(0, 80),
  });

  // 1. Persist the answer FIRST, and believe the write (DEF-178).
  //
  //    `recordAnswer` is a compare-and-set: exactly one row moves
  //    `awaiting_reply → answered` or nothing does. Until iteration 53 the
  //    count was ignored, so a prompt that was deleted, consumed by a
  //    concurrent delivery of the same webhook, expired again after revival,
  //    or resolved under the wrong scope still got its side effect applied
  //    and its "[recorded]" ack sent — owner state changed with no durable
  //    answer ledger behind it (Codex iteration-50 CRITICAL). No persisted
  //    answer, no mutation, no ack: the message routes to normal chat, which
  //    is what it is when the question it answered no longer exists.
  const persisted = await recordAnswer(awaiting.id, answerText, {
    userId: input.userId, clientNumber: input.clientNumber,
  });
  if (!persisted) {
    log.warn('answer did not persist — prompt gone, already consumed, or out of scope; no side effect applied', {
      userId: input.userId, promptId: String(awaiting.id), state: awaiting.state,
    });
    return { handled: false };
  }

  // 2. Apply side-effect.
  const seResult = await applySideEffect(
    awaiting.sideEffect as any,
    answerText,
    awaiting.openItemId ?? null,
  );

  // 3. Compose ack — short, factual, no fluff.
  const ack = composeAck(answerText, awaiting.sideEffect as any, seResult);

  // 4. Dispatch next prompt. If this errors we still ack — the queue
  //    is consistent, just delayed by one tick.
  void sendNextPrompt(input.userId, input.clientNumber).catch((err) => {
    log.warn('sendNextPrompt failed after answer', { err: err.message });
  });

  return {
    handled: true,
    ackMessage: ack,
    sideEffectStatus: seResult.status,
    promptId: String(awaiting.id),
    residualText,
    answeredQuestion: awaiting.question ?? undefined,
  };
}

// ─── Side-effect application ────────────────────────────────────────────

interface SideEffectOutcome {
  status: 'applied' | 'failed' | 'noop' | 'unknown_kind';
  detail?: string;
}

// Exported for tests. The alias-capture case writes a DURABLE identity binding and spends the
// owner's single ask doing it, so its failure paths have to be exercised rather than read.
export async function applySideEffect(
  side: { kind?: string; openItemId?: string; data?: Record<string, unknown> } | null,
  answer: string,
  fallbackOpenItemId: string | null,
): Promise<SideEffectOutcome> {
  const kind = side?.kind ?? 'noop';
  const openItemId = side?.openItemId ?? fallbackOpenItemId;

  switch (kind) {
    case 'noop':
      return { status: 'noop' };

    case 'set_due_date': {
      if (!openItemId) return { status: 'failed', detail: 'no_open_item' };
      const parsed = parseDuePhrase(answer);
      if (!parsed) {
        // Can't parse — flag the item so a human can clarify, don't fail
        // the whole conversation.
        await prisma.openItem.update({
          where: { id: openItemId },
          data: { metadata: { dueDateNeedsClarification: true, lastAnswer: answer.slice(0, 200) } as any },
        }).catch(() => {});
        return { status: 'failed', detail: 'unparseable_date' };
      }
      await prisma.openItem.update({
        where: { id: openItemId },
        data: { dueDate: parsed },
      }).catch((err) => log.warn('set_due_date update failed', { err: err.message }));
      return { status: 'applied', detail: parsed.toISOString().slice(0, 10) };
    }

    case 'assign_owner': {
      if (!openItemId) return { status: 'failed', detail: 'no_open_item' };
      // Try to extract email + name from the answer. Heuristics:
      //   "Asad Khan <asad@tmcltd.com>"  → both
      //   "asad@tmcltd.com"              → email; name from local part
      //   "Asad"                         → name only
      const owner = parseOwner(answer);
      if (!owner.name && !owner.email) return { status: 'failed', detail: 'no_owner_in_answer' };
      // DEF-129 — through the matrix, atomically.
      //
      // This is the owner answering "who should own this?" on WhatsApp, and it
      // set status + delegatee in one ungoverned write: no guard, no ledger row,
      // no event publish. Now the delegatee travels WITH the transition, so a
      // refusal leaves no half-assignment behind.
      const { transitionStatus } = await import('../itemLifecycle/lifecycleService');
      const item = await prisma.openItem.findFirst({ where: { id: openItemId }, select: { clientNumber: true } });
      if (!item) return { status: 'failed', detail: 'item_not_found' };
      const r = await transitionStatus(openItemId, 'DELEGATED', {
        clientNumber: item.clientNumber,
        actor: 'system',
        reason: `Owner assigned ${owner.name ?? owner.email} by prompt reply`,
        itemData: { delegateeName: owner.name ?? null, delegateeEmail: owner.email ?? null },
      }).catch((err: any) => {
        log.warn('assign_owner transition threw', { err: err?.message });
        return { ok: false, error: err?.message ?? 'transition threw' } as any;
      });
      if (!r.ok) {
        // Honest failure: the owner is told the assignment did not take rather
        // than being left to assume it did.
        log.warn('assign_owner refused by lifecycle', { openItemId, error: r.error });
        return { status: 'failed', detail: `transition_refused: ${r.error ?? 'unknown'}` };
      }
      return { status: 'applied', detail: owner.name ?? owner.email ?? '' };
    }

    case 'free_form_note': {
      if (!openItemId) return { status: 'noop' };
      const item = await prisma.openItem.findFirst({ where: { id: openItemId } });
      if (!item) return { status: 'failed', detail: 'item_not_found' };
      const notes = (item.notes as Array<Record<string, unknown>>) || [];
      notes.push({ text: answer, at: new Date().toISOString(), source: 'prompt_reply' });
      await prisma.openItem.update({ where: { id: openItemId }, data: { notes: notes as any } })
        .catch((err) => log.warn('free_form_note update failed', { err: err.message }));
      return { status: 'applied' };
    }

    case 'wa_sender_alias_capture': {
      // DEF-272 — the owner naming a sender whose number WhatsApp withheld. Writes the `waLid`
      // alias that `identifySender` already reads, so the SAME person is named from then on.
      const waLid = String(side?.data?.waLid ?? '');
      const clientNumber = String(side?.data?.clientNumber ?? '');
      if (!waLid || !clientNumber) return { status: 'failed', detail: 'missing_lid' };

      // "skip" is a real answer and must not become a contact called "skip".
      const name = answer.trim();
      if (!name || /^(skip|no|nope|ignore|dunno|don'?t know|not sure)$/i.test(name)) {
        return { status: 'applied', detail: 'declined' };
      }
      // A name, not a sentence. Anything long is the owner talking, not naming — and writing a
      // paragraph into a contact name would be worse than leaving the sender anonymous.
      if (name.length > 80) return { status: 'failed', detail: 'answer_not_a_name' };

      // Prefer an EXISTING contact — the owner naming someone he already has on file must not
      // create a second copy of them. `entities` already carries 778 contacts and a duplicate
      // identity costs more than an unresolved one (MEM-003's stated trade).
      const existing = await prisma.entity.findFirst({
        where: {
          clientNumber, entityType: 'contact',
          name: { equals: name, mode: 'insensitive' },
        },
        select: { id: true, metadata: true },
      }).catch(() => null);

      if (existing) {
        // Never REBIND an alias. If this contact already answers to a different `@lid`,
        // overwriting would silently un-name the other identity — and DEF-162 records that a
        // wrong identity bind is durable and misroutes that person indefinitely. Refuse loudly.
        const priorLid = (existing.metadata as any)?.waLid;
        if (priorLid && priorLid !== waLid) {
          log.warn('refused to rebind a waLid alias', { name, priorLid, waLid });
          return { status: 'failed', detail: 'contact_has_a_different_wa_identity' };
        }
        // The write is the whole fix, so its failure must NOT be reported as success. Returning
        // `applied` here would tell the owner the person is named while the ask is spent and
        // never repeats — BLD-011: an error handler that returns a success is claiming a fact.
        try {
          await prisma.entity.update({
            where: { id: existing.id },
            data: { metadata: { ...((existing.metadata as any) ?? {}), waLid } as any },
          });
        } catch (err: any) {
          log.warn('waLid alias write failed', { err: err?.message });
          return { status: 'failed', detail: 'alias_write_failed' };
        }
        return { status: 'applied', detail: `aliased_existing:${name}` };
      }

      // No such contact. Create one carrying ONLY what the owner actually told us — a name and
      // the alias. No phone: the transport withheld it and inventing one is the defect DEF-121
      // exists to prevent.
      try {
        await prisma.entity.create({
          data: {
            clientNumber, entityType: 'contact', name,
            metadata: { waLid, source: 'owner_named_wa_sender' } as any,
          } as any,
        });
      } catch (err: any) {
        // Same reason as above: the write IS the fix. A swallowed failure here spends the
        // owner's one ask and leaves the sender anonymous forever, while telling him otherwise.
        log.warn('contact create for waLid failed', { err: err?.message });
        return { status: 'failed', detail: 'alias_write_failed' };
      }
      return { status: 'applied', detail: `aliased_new:${name}` };
    }

    case 'wa_sender_policy_decision': {
      // Section 35 Phase 1 — the owner's answer to "reply or ignore?" for
      // an unknown WhatsApp sender. Strict forms fast-path; everything
      // else is LLM-classified (never a regex final boundary). An unclear
      // answer keeps the sender pending and says so — no guessing.
      const phone = String(side?.data?.phone ?? '');
      const clientNumber = String(side?.data?.clientNumber ?? '');
      const ownerUserId = Number(side?.data?.ownerUserId ?? 0);
      if (!phone || !clientNumber || !ownerUserId) return { status: 'failed', detail: 'missing_sender_ref' };
      const { interpretSenderDecision, decideSenderPolicy } = await import('../whatsapp/senderTriage');
      const decision = await interpretSenderDecision(answer);
      if (decision === 'unclear') return { status: 'failed', detail: 'unclear_decision' };
      await decideSenderPolicy({
        clientNumber, phone, ownerUserId,
        policy: decision === 'ignore' ? 'ignored' : 'allowed',
        decidedBy: 'owner_decision',
        note: answer.slice(0, 200),
      }).catch((err: any) => log.warn('sender policy write failed', { err: err?.message }));
      return { status: 'applied', detail: `${phone}:${decision === 'ignore' ? 'ignored' : 'allowed'}` };
    }

    case 'action_status_update': {
      if (!openItemId) return { status: 'failed', detail: 'no_open_item' };
      const item = await prisma.openItem.findFirst({ where: { id: openItemId }, select: { clientNumber: true } });
      if (!item) return { status: 'failed', detail: 'item_not_found' };
      const { recordActionLifecycleReply } = await import('../openItems/actionLifecycleService');
      const result = await recordActionLifecycleReply({
        openItemId,
        clientNumber: item.clientNumber,
        body: answer,
        source: 'user',
      });
      if (!result.handled) return { status: 'failed', detail: 'item_not_found' };
      if (result.closed) return { status: 'applied', detail: 'completed' };
      if (result.newDueDate) return { status: 'applied', detail: `new_due:${result.newDueDate}` };
      if (result.needsUserIntervention) return { status: 'applied', detail: 'intervention_recorded' };
      // ── DEF-284 — `result.outcome` is what the USER REPORTED, not what the system DID ──────
      //
      // 2026-09-02 15:10: he replied "Extension received, so close it" and was told
      // **"[completion recorded and item closed]"**. The item is still `NEW`, and
      // `item_status_history` records the transition as REJECTED — `approval required, none
      // provided`. Nothing closed.
      //
      // The mechanism is this line. `outcome` is the interpretation of his sentence
      // ('completed' | 'blocked' | 'in_progress'); falling through to it means a rejected close
      // returns `detail: 'completed'`, and `composeAck` matches that exact string to
      // "[completion recorded and item closed]". **His own claim was echoed back as an
      // accomplished fact** — 9th `fabricated-status`, and the narrowest one yet: one identifier
      // doing duty for two different questions.
      //
      // So a reported completion that did NOT close says so, and carries the reason out with it.
      if (result.outcome === 'completed') {
        return {
          status: 'applied',
          detail: `completion_reported_not_closed:${result.closeBlocked ?? 'the item did not close'}`,
        };
      }
      return { status: 'applied', detail: result.outcome ?? 'status_recorded' };
    }

    default:
      return { status: 'unknown_kind' };
  }
}

// ─── Date phrase parser ────────────────────────────────────────────────
// Deliberately simple — recognises common short answers without an LLM.
// Returns null when nothing matches.

const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

/**
 * Sanity window for a parsed deadline (DEF-017, 2026-08-05).
 *
 * Production wrote a due date of **2024-03-29** — over two years in the past —
 * from a compound instruction, and reported it back as
 * `[new deadline recorded: 2024-03-29]`. `resolveDate` (the canonical parser)
 * already refuses anything older than a year; this parser, which has FIVE
 * callers, had no guard at all. A deadline in the past is far more likely a
 * parse error than an intention, and writing one silently is worse than
 * refusing: returning null routes the caller into its existing
 * "unparseable date — ask the user" path.
 */
export function withinSaneDueWindow(d: Date, todayMidnight: Date): boolean {
  const oneDayBefore = new Date(todayMidnight.getTime() - 24 * 60 * 60 * 1000);
  const fiveYearsAhead = new Date(todayMidnight.getTime() + 5 * 365 * 24 * 60 * 60 * 1000);
  return d >= oneDayBefore && d <= fiveYearsAhead;
}

/**
 * DEF-249 — the same window, applied to a date NOBODY parsed here.
 *
 * DEF-017 put a sanity window inside `parseDuePhrase`, which was the right fix for the parser
 * and the wrong shape for the problem. `actionLifecycleService` asks a MODEL for the deadline and
 * accepts its answer on `Number.isFinite` alone, using `parseDuePhrase` only as a fallback — so
 * the guard sat in the branch that runs when the model FAILS, and was skipped whenever it
 * succeeded. 2026-08-27: the owner said "28th October", the model supplied the year 2024, and
 * `Decide on Imperialsoft services termination date` was written due 2024-10-28 — permanently
 * overdue, and nagging him about it forever.
 *
 * The guard belongs on the VALUE, not on one producer of it. Exported so every path that obtains
 * a date from anywhere can apply the same window.
 */
export function saneDueDate(d: Date | null | undefined): Date | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return withinSaneDueWindow(d, todayMidnight) ? d : null;
}

export function parseDuePhrase(raw: string): Date | null {
  const s = raw.trim().toLowerCase();
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sane = (d: Date | null): Date | null =>
    d && withinSaneDueWindow(d, todayMidnight) ? d : null;

  if (/^(today|eod|asap|now)\b/.test(s)) return todayMidnight;
  if (/^tomorrow\b/.test(s)) return addDays(todayMidnight, 1);

  const inDays = s.match(/^in\s+(\d+)\s+day/);
  if (inDays) return sane(addDays(todayMidnight, parseInt(inDays[1] as string, 10)));

  const nDays = s.match(/^(\d+)\s+day/);
  if (nDays) return sane(addDays(todayMidnight, parseInt(nDays[1] as string, 10)));

  // ISO date
  const iso = s.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) {
    const d = new Date(iso[1] as string);
    // The 2024-03-29 write came through an absolute date like this one.
    if (!Number.isNaN(d.getTime())) return sane(d);
  }

  // weekday names — "friday" / "next monday" / "this thursday"
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const re = new RegExp(`(?:^|\\b)(?:next\\s+|this\\s+)?(${WEEKDAYS[i]})\\b`);
    const m = s.match(re);
    if (m) {
      const target = i;
      const cur = todayMidnight.getDay();
      let delta = target - cur;
      const isNext = /\bnext\s+/.test(s);
      if (delta <= 0 || isNext) delta += 7;
      return sane(addDays(todayMidnight, delta));
    }
  }

  return null;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

// ─── Owner parser ──────────────────────────────────────────────────────

export function parseOwner(raw: string): { name: string | null; email: string | null } {
  const s = raw.trim();
  // "Asad Khan <asad@tmcltd.com>"
  const both = s.match(/^(.+?)\s*<\s*([^\s>]+@[^\s>]+)\s*>?$/);
  if (both) return { name: both[1]!.trim() || null, email: both[2]!.toLowerCase() };
  // bare email
  const email = s.match(/([^\s,;<>]+@[^\s,;<>]+)/);
  if (email) {
    const localPart = email[1]!.split('@')[0];
    const niceName = localPart!.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return { name: niceName || null, email: email[1]!.toLowerCase() };
  }
  // name only — keep it as-is (caller may flag if email is needed)
  if (s.length >= 2 && s.length <= 80) return { name: s, email: null };
  return { name: null, email: null };
}

// ─── Ack composer ──────────────────────────────────────────────────────

function composeAck(
  answer: string,
  side: { kind?: string } | null,
  outcome: SideEffectOutcome,
): string {
  // System markers (bracketed), not fake-Brain "Got it" replies. Per
  // Basit 2026-05-20: "don't hardcode anything this is the crime in
  // building AI". These are state-transition acknowledgements emitted
  // by the prompt-queue dispatcher — clearly machine status, not Brain
  // speaking. Each variant names the actual outcome so the user knows
  // exactly what changed.
  const kind = side?.kind ?? 'noop';
  switch (kind) {
    case 'set_due_date':
      if (outcome.status === 'applied') return `[due date set: ${outcome.detail}]`;
      if (outcome.detail === 'unparseable_date') return `[couldn't parse "${clip(answer, 40)}" as a date — flagged for clarification]`;
      return `[noted]`;
    case 'assign_owner':
      if (outcome.status === 'applied') return `[assigned to ${outcome.detail}]`;
      return `[owner not identified — reply with a name or email]`;
    case 'free_form_note':
      return outcome.status === 'applied' ? `[note saved]` : `[noted]`;
    case 'action_status_update':
      if (outcome.detail === 'completed') return `[completion recorded and item closed]`;
      if (outcome.detail?.startsWith('new_due:')) {
        return `[new deadline recorded: ${outcome.detail.slice('new_due:'.length, 'new_due:'.length + 10)}]`;
      }
      if (outcome.detail === 'intervention_recorded') return `[blocker recorded — intervention flagged]`;
      // DEF-284: never report a close that did not happen. The reason travels with it so the
      // next question — "which approval?" — has an answer in the same message.
      if (outcome.detail?.startsWith('completion_reported_not_closed')) {
        const why = outcome.detail.slice('completion_reported_not_closed:'.length);
        return `[noted that it is complete — but the item is still OPEN: ${why}]`;
      }
      return outcome.status === 'applied' ? `[status update recorded]` : `[status update could not be applied]`;
    case 'noop':
    default:
      return `[noted]`;
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Decide whether the inbound text is a plausible answer to the pending
 *  prompt's side-effect, or a NEW chat command that should fall through
 *  to the regular Brain chat router.
 *
 *  Two layers:
 *    1. Universal "new chat command" detector — phrases that are clearly
 *       new requests, never answers to any prompt. Same shape no matter
 *       what side-effect is awaiting.
 *    2. Side-effect-specific shape match — does the text look like a
 *       date (for set_due_date), a name/email (for assign_owner), etc.
 *
 *  Tuned to err on the side of FALL-THROUGH. A false-negative answer
 *  just delays applying a prompt by one turn; a false-positive eats a
 *  legitimate new chat command and replies with gibberish ("couldn't
 *  parse 'brief my day' as a date — flagged for clarification"). The
 *  second failure mode is what MD hit on 2026-05-12 and is much worse. */
export function looksLikeAnswer(text: string, sideEffectKind: string): boolean {
  const t = text.trim();
  if (!t) return false;

  // Layer 1 — universal new-chat trigger phrases. If MD opens with any
  // of these, they're starting a new request, not answering an old prompt.
  // Verbs list must stay in sync with the ComposedAction imperatives in
  // brainComposer.ts. Missing verbs cause the prompt-queue to swallow
  // real commands with [noted] — Basit 2026-07-08: "send a test email"
  // was misread as an answer to a stale prompt and got [noted] back
  // because 'send' wasn't in the allowlist.
  const newChatTrigger = /^(brief\s+my\s+day|day\s+brief|what'?s\s+(on\s+my\s+plate|critical|urgent|going\s+on)|how\s+(many|much)\s+|how\s+is\s+|list\s+(my|all|the)\s+|show\s+me\s+|tell\s+(me\s+about|him|her|them)\s+|delegate\s+|forward\s+|reply\s+(to\s+|with\s+)|draft\s+(a\s+)?(reply|email|message)|schedule\s+|reschedule\s+|set\s+(up\s+)?(a\s+)?meeting|book\s+(a\s+)?meeting|remind\s+me\s+|add\s+(it\s+|this\s+|a\s+task|to\s+my)|track\s+(this|that)|snooze\s+|mute\s+|hide\s+|send\s+|email\s+|notify\s+|ping\s+|call\s+|message\s+|share\s+|update\s+|fix\s+|edit\s+|change\s+|write\s+|compose\s+|cancel$|skip$|nevermind$|later$|stop$|bye$|exit$|hi$|hello$|hey$|good\s+(morning|afternoon|evening|night)|salaam|salam|aoa|assalam)\b/i;
  if (newChatTrigger.test(t)) return false;

  // Layer 2 — shape match per side-effect.
  switch (sideEffectKind) {
    case 'set_due_date': {
      // Recognise common natural-language date forms + ISO.
      const datePattern = /\b(today|tomorrow|tonight|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|next\s+\w+|by\s+\w+|in\s+\d+\s*(day|days|week|weeks|month|months)|end\s+of\s+(day|week|month)|asap|whenever|no\s+idea|sometime|aaj|kal|parsoon|abhi)\b/i;
      const isoLike = /\b\d{4}-\d{2}-\d{2}\b/.test(t) || /^\d{1,2}[\/\-]\d{1,2}/.test(t) || /^\d+\s*(d|days|h|hours)$/i.test(t);
      // Short messages with date words = answer. Long sentences with
      // date words but also clear new-chat structure already failed layer 1.
      if (datePattern.test(t)) return true;
      if (isoLike) return true;
      // Very short freeform like "tomorrow ok" or "monday next" — usually answer.
      if (t.length <= 30 && /^[a-z\d\s.,;:-]+$/i.test(t)) return true;
      return false;
    }
    case 'assign_owner': {
      // Email present → almost certainly an owner answer.
      if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(t)) return true;
      // Short name-shaped: 1-4 tokens, mostly capitalised letters.
      const tokens = t.split(/\s+/);
      if (tokens.length >= 1 && tokens.length <= 4 && tokens.every((w) => /^[A-Z][a-z'\-]{1,}\.?$/.test(w) || /^[A-Z][A-Z]+$/.test(w))) return true;
      return false;
    }
    case 'wa_sender_alias_capture': {
      // DEF-269 — a NAME, and nothing else. The `default` branch accepts any text under 200
      // chars, which here would write whatever the owner happened to type next into a contact
      // name. Names are short and few-token; a sentence is the owner talking, not naming.
      const tokens = t.split(/\s+/);
      if (tokens.length > 4 || t.length > 60) return false;
      if (/[@:;/\\?!]|https?:/i.test(t)) return false;
      return tokens.every((w) => /^[A-Za-z][A-Za-z'\-.]*$/.test(w));
    }
    case 'free_form_note':
      // Anything that isn't a new-chat trigger (layer 1 already filtered).
      return true;
    case 'action_status_update':
      // Status replies are intentionally free-form: completion, progress,
      // blocker, delay reason, and a new deadline often arrive in one sentence.
      return true;
    case 'noop':
    default:
      // Without a typed side-effect we have nothing to validate against.
      // Conservative: accept short freeform, reject anything that smells
      // like a new request. Layer 1 already caught the loud cases.
      return t.length <= 200;
  }
}
