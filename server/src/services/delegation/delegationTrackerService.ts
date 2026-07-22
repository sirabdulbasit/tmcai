/**
 * MyOS — Delegation Tracker.
 *
 * When MD delegates a task, a status='DELEGATED', priority='low' OpenItem
 * is created and owned by MD (separate from the delegatee's own OpenItem).
 * This tracker row carries metadata.followUp = { dueAt, count, lastSentAt,
 * lastResponseAt } so Brain can close the loop automatically:
 *
 *   1. On every inbound email/whatsapp, this service checks whether the
 *      sender is a delegatee for one of MD's active DELEGATED items.
 *      If yes, an LLM classifies the message against the delegation:
 *        done      → status='CLOSED', note appended
 *        progress  → description updated with latest summary
 *        blocked   → priority='high', flag added
 *        unrelated → ignored
 *      Every auto-update emits an agent_action with executedByAgent=
 *      'delegation_tracker' so it surfaces in Day Brief's BRIEF section
 *      ("Asad confirmed the billing architecture is done").
 *
 *   2. A separate job (delegationFollowUpJob) walks DELEGATED items whose
 *      followUp.dueAt has passed without a matching inbound, composes a
 *      short nudge in the MD's tone, sends it as MD, and logs it in BRIEF
 *      ("I pinged Asad about Billing Architecture — 3rd follow-up").
 *
 * Scope for POC: email-based delegations only. WhatsApp delegation can be
 * added later; the match would key on phone number instead of email.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('delegation-tracker');

export type DelegationOutcome = 'done' | 'progress' | 'blocked' | 'unrelated';

interface ClassifyResult {
  outcome: DelegationOutcome;
  summary: string;     // 1-sentence update to store in notes/description
  confidence: number;  // 0-1 from model
}

/** Async classifier — LLM asks "is this email saying the delegated task is done / progressing / blocked?" */
async function classifyInbound(
  taskTitle: string,
  taskContext: string,
  senderName: string,
  emailSubject: string,
  emailBody: string,
): Promise<ClassifyResult> {
  try {
    const { callLLM } = await import('../llmRouter');
    const sys = `You classify incoming emails against a delegated task. Output ONLY a single JSON object:
{"outcome": "done" | "progress" | "blocked" | "unrelated", "summary": "<one short sentence>", "confidence": 0.0-1.0}

Rules:
- "done" if the email clearly says the task is completed / signed / delivered / closed / resolved.
- "progress" if the email gives an update (partial progress, new ETA, clarifying question answered).
- "blocked" if the email says they are stuck, waiting on someone, or cannot proceed.
- "unrelated" if the email is not referring to this specific task.
- "summary" is ONE sentence, 20 words max, suitable as a status note.
- "confidence" reflects how sure you are about the outcome.
- NEVER output anything other than the JSON object.`;
    const user = `Task being tracked:
Title: ${taskTitle}
Context: ${taskContext}

Incoming email:
From: ${senderName}
Subject: ${emailSubject}
Body: ${emailBody.slice(0, 800)}

Classify:`;
    const r = await callLLM(sys, user, { maxTokens: 120, purpose: 'delegation_tracker_classify' });
    const match = r.text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no json in response');
    const parsed = JSON.parse(match[0]);
    const outcome = (['done', 'progress', 'blocked', 'unrelated'].includes(parsed.outcome) ? parsed.outcome : 'unrelated') as DelegationOutcome;
    return {
      outcome,
      summary: String(parsed.summary ?? '').slice(0, 200),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
    };
  } catch (err: any) {
    log.warn('classify failed', { error: err.message });
    return { outcome: 'unrelated', summary: '', confidence: 0 };
  }
}

/**
 * Called after feed_events.ingest() for every inbound message. If the
 * sender matches a delegatee on one of the user's active DELEGATED open
 * items, classify and apply the appropriate side-effect.
 */
export async function checkInboundForDelegationUpdate(params: {
  feedEventId: string;
  clientNumber: string;
  userId: number;
  sourceType: string;
  senderEmail: string | null;
  senderName: string | null;
  rawPayload: Record<string, unknown> | null;
}): Promise<{ handled: boolean; outcome?: DelegationOutcome; openItemId?: string }> {
  if (!params.senderEmail || params.sourceType !== 'gmail') return { handled: false };

  // Section 33a adapter: with capture enabled, email delegation replies go
  // through explicit thread correlation (In-Reply-To when available, else
  // the single-active-thread rule) — this function's own most-recently-
  // updated pick and its LLM side-effects are bypassed entirely. The
  // delegatee-mirror update is deferred to 33b (disclosed in the ledger).
  // Capture OFF ⇒ full legacy behavior below, unchanged.
  const { isDelegationCaptureEnabled } = await import('./delegationThreadService');
  if (await isDelegationCaptureEnabled(params.clientNumber)) {
    const payloadForCorrelation: any = params.rawPayload ?? {};
    const { captureDelegationReply } = await import('./delegationCaptureService');
    const captured = await captureDelegationReply({
      clientNumber: params.clientNumber,
      channel: 'email',
      fromIdentifier: params.senderEmail,
      body: String(payloadForCorrelation.snippet ?? payloadForCorrelation.body ?? '').slice(0, 4000),
      sourceId: `feed:${params.feedEventId}`,
      inReplyTo: payloadForCorrelation.inReplyTo ? String(payloadForCorrelation.inReplyTo) : null,
      evidenceSourceType: 'feed_event',
      evidenceSourceId: params.feedEventId,
    }).catch(() => ({ matched: false as const, openItemId: undefined as string | undefined }));
    return captured.matched
      ? { handled: true, openItemId: (captured as any).openItemId }
      : { handled: false };
  }

  // Find open DELEGATED items where the delegatee email matches this sender
  const candidates = await prisma.openItem.findMany({
    where: {
      clientNumber: params.clientNumber,
      userId: params.userId,
      ownerId: params.userId,
      status: 'DELEGATED',
      delegateeEmail: { equals: params.senderEmail, mode: 'insensitive' },
    } as any,
    take: 5,
    orderBy: { updatedAt: 'desc' },
  });
  if (candidates.length === 0) return { handled: false };

  const payload: any = params.rawPayload ?? {};
  const subject = String(payload.subject ?? '');
  const snippet = String(payload.snippet ?? payload.body ?? '');

  // Match to the best candidate by title similarity + subject overlap
  const best = candidates[0]; // simplest: pick the most-recently-updated

  const classification = await classifyInbound(
    best.title,
    String(best.description ?? '').slice(0, 500),
    params.senderName ?? params.senderEmail,
    subject,
    snippet,
  );

  if (classification.outcome === 'unrelated' || classification.confidence < 0.55) {
    return { handled: false };
  }

  const now = new Date();
  const existingNotes: any[] = Array.isArray(best.notes) ? (best.notes as any[]) : [];
  const note = {
    at: now.toISOString(),
    by: 'delegation_tracker',
    outcome: classification.outcome,
    summary: classification.summary,
    sourceFeedEventId: params.feedEventId,
  };

  let nextStatus = best.status;
  let nextPriority = best.priority;
  let nextDescription = best.description;

  if (classification.outcome === 'done') {
    nextStatus = 'CLOSED';
    nextDescription = `${best.description ?? ''}\n\n✓ ${classification.summary}`.trim();
  } else if (classification.outcome === 'progress') {
    nextDescription = `${best.description ?? ''}\n\n• ${classification.summary}`.trim();
  } else if (classification.outcome === 'blocked') {
    nextPriority = 'high';
    nextDescription = `${best.description ?? ''}\n\n⚠ Blocked: ${classification.summary}`.trim();
  }

  // Stamp metadata.followUp.lastResponseAt so follow-up job stops nagging
  const meta: any = (best.metadata as any) ?? {};
  const followUp = { ...(meta.followUp ?? {}), lastResponseAt: now.toISOString() };

  await prisma.openItem.update({
    where: { id: best.id },
    data: {
      status: nextStatus,
      priority: nextPriority,
      description: nextDescription,
      notes: [...existingNotes, note] as any,
      metadata: { ...meta, followUp } as any,
      updatedAt: now,
    } as any,
  });

  // Keep email replies and WhatsApp replies on the same living-action
  // lifecycle. The tracker classification is reused as a grounded hint so
  // this path does not spend a second LLM call.
  try {
    const { parseDuePhrase } = await import('../brainPrompts/promptReplyHandler');
    const { recordActionLifecycleReply } = await import('../openItems/actionLifecycleService');
    const newDeadline = classification.outcome === 'progress' || classification.outcome === 'blocked'
      ? parseDuePhrase(snippet)
      : null;
    await recordActionLifecycleReply({
      openItemId: best.id,
      clientNumber: params.clientNumber,
      body: snippet || classification.summary,
      source: 'email',
      sourceId: params.feedEventId,
      interpretation: {
        outcome: classification.outcome === 'done' ? 'completed'
          : classification.outcome === 'progress' ? 'in_progress'
          : 'blocked',
        summary: classification.summary,
        newDeadline,
        delayReason: classification.outcome === 'blocked' ? classification.summary : null,
        completionEvidence: classification.outcome === 'done' ? classification.summary : null,
        needsUserIntervention: classification.outcome === 'blocked',
        confidence: classification.confidence,
      },
    });
  } catch (err: any) {
    log.warn('action lifecycle email update failed', { error: err.message });
  }

  // Mirror update on the delegatee's parallel open_item (created
  // when MD delegated). Without this, the delegatee's Action Center
  // still shows the task as open even though Brain has confirmed
  // it's done from the sender side. Match by sourceFeedEventId
  // (the original delegation stamps it on both rows) AND owner =
  // the delegatee. Quietly skip if no such row exists (delegation
  // was external, not to a Nexeo user).
  try {
    const delegateeOpenItem = await prisma.openItem.findFirst({
      where: {
        clientNumber: params.clientNumber,
        sourceFeedEventId: best.sourceFeedEventId,
        ownerId: best.delegateeId ?? undefined,
        // Don't accidentally re-close a row already CLOSED on a prior pass
        status: { not: 'CLOSED' } as any,
      } as any,
      select: { id: true, description: true, notes: true, ownerId: true },
    });
    if (delegateeOpenItem && best.delegateeId) {
      const delNotes: any[] = Array.isArray(delegateeOpenItem.notes)
        ? (delegateeOpenItem.notes as any[]) : [];
      const mirrorNote = {
        at: now.toISOString(),
        by: 'delegation_tracker',
        outcome: classification.outcome,
        summary: `Sender-side mirror: ${classification.summary}`,
        sourceFeedEventId: params.feedEventId,
      };
      const mirrorDescAddon =
        classification.outcome === 'done' ? `\n\n✓ Closed (sender confirmed: ${classification.summary})`
        : classification.outcome === 'blocked' ? `\n\n⚠ Blocked (sender side flag): ${classification.summary}`
        : `\n\n• Update: ${classification.summary}`;
      await prisma.openItem.update({
        where: { id: delegateeOpenItem.id },
        data: {
          status: classification.outcome === 'done' ? 'CLOSED' : undefined,
          priority: classification.outcome === 'blocked' ? 'high' : undefined,
          description: `${delegateeOpenItem.description ?? ''}${mirrorDescAddon}`.trim(),
          notes: [...delNotes, mirrorNote] as any,
          updatedAt: now,
        } as any,
      });
      log.info('mirror-updated delegatee open item', {
        delegateeOpenItemId: delegateeOpenItem.id,
        outcome: classification.outcome,
      });
    }
  } catch (err: any) {
    log.warn('delegatee mirror update failed', { error: err.message });
  }

  // Write an agent_action so the BRIEF section shows what Brain did
  await prisma.agentAction.create({
    data: {
      clientNumber: params.clientNumber,
      userId: params.userId,
      actionType:
        classification.outcome === 'done' ? 'delegation_closed' :
        classification.outcome === 'blocked' ? 'delegation_blocked' :
        'delegation_updated',
      status: 'done',
      requiresApproval: false,
      executedByAgent: 'delegation_tracker',
      input: { feedEventId: params.feedEventId, openItemId: best.id } as any,
      output: {
        delegateeName: best.delegateeName,
        delegateeEmail: best.delegateeEmail,
        title: best.title,
        outcome: classification.outcome,
        summary: classification.summary,
      } as any,
    } as any,
  }).catch((e: any) => log.warn('agent_action write failed', { error: e.message }));

  log.info('auto-updated delegation', { openItemId: best.id, outcome: classification.outcome });
  return { handled: true, outcome: classification.outcome, openItemId: best.id };
}
