/**
 * Living Action Center worker.
 *
 * One deterministic lifecycle owns every actionable open item until it is
 * completed, cancelled, or explicitly suppressed. It contacts the concerned
 * party, asks daily when no deadline exists, rechecks at each commitment,
 * records delay reasons/new dates, and involves the owner when human authority
 * or repeated non-response makes intervention necessary.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import {
  ActionLifecycleState,
  LifecyclePlan,
  nextDailyFollowUp,
  planActionLifecycle,
  readActionLifecycle,
} from '../services/openItems/actionLifecycleService';

const log = createLogger('action-lifecycle-worker');
const ACTIVE = [
  'NEW', 'TRIAGED', 'IN_PROGRESS', 'DELEGATED', 'WAITING_INFO', 'SNOOZED', 'DRAFT',
  'new', 'triaged', 'in_progress', 'delegated', 'waiting_info', 'snoozed', 'draft',
];

export interface ActionLifecycleRunResult {
  scanned: number;
  contacted: number;
  escalated: number;
  held: number;
  errors: number;
}

function firstName(name: string | null | undefined): string {
  return String(name ?? '').trim().split(/\s+/)[0] || 'there';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function questionFor(item: any, plan: LifecyclePlan, brainName: string, ownerName: string): string {
  const who = firstName(item.delegateeName);
  const identity = `Hi ${who}, this is ${brainName} — ${firstName(ownerName)}'s AI assistant.`;
  if (plan.action === 'ask_deadline') {
    return `${identity} I'm tracking "${item.title}" through completion. What date can you commit to? If it is delayed, please include the reason and the new deadline.`;
  }
  if (plan.action === 'ask_completion_evidence') {
    return `${identity} You indicated that "${item.title}" is complete. Please confirm what was delivered or share the completion reference so I can close it accurately.`;
  }
  return `${identity} The committed date for "${item.title}" has arrived. Is it completed? If not, please share the reason for delay and a new committed deadline.`;
}

function ownerQuestion(item: any, plan: LifecyclePlan): string {
  if (plan.action === 'ask_deadline') {
    return `I'm keeping "${item.title}" active, but it has no committed deadline. When should it be completed? If someone else owns it, include their name and target date.`;
  }
  if (plan.action === 'ask_completion_evidence') {
    return `You marked progress on "${item.title}", but I still need completion evidence. What was delivered, or when should I check again?`;
  }
  return `The deadline for "${item.title}" has arrived. Is it completed? If not, tell me the delay reason and the new committed deadline.`;
}

function escalationQuestion(item: any, state: ActionLifecycleState, reason: string): string {
  const who = item.delegateeName ?? item.delegateeEmail ?? 'the responsible person';
  const attempts = state.unansweredAttempts;
  const commitments = state.commitmentHistory.length;
  return [
    `Intervention needed on "${item.title}".`,
    `Owner: ${who}. Follow-up attempts without a usable response: ${attempts}. Commitments recorded: ${commitments}.`,
    state.currentDelayReason ? `Latest delay reason: ${state.currentDelayReason}.` : null,
    `Why I'm involving you: ${reason}.`,
    `Recommended next step: decide whether to remove the blocker, contact ${who} directly, reassign the work, or revise the deadline.`,
  ].filter(Boolean).join(' ');
}

async function resolveConcernedPhone(item: any): Promise<string | null> {
  if (item.delegateeId) {
    const connections = await prisma.$queryRawUnsafe<Array<{ phone_number: string }>>(
      `SELECT phone_number FROM whatsapp_connections
        WHERE user_id = $1 AND status = 'active'
        ORDER BY updated_at DESC LIMIT 1`,
      item.delegateeId,
    ).catch(() => []);
    if (connections[0]?.phone_number) return connections[0].phone_number;
  }
  const entity = await prisma.entity.findFirst({
    where: {
      clientNumber: item.clientNumber,
      entityType: 'contact',
      OR: [
        ...(item.delegateeEmail ? [{ email: { equals: item.delegateeEmail, mode: 'insensitive' as const } }] : []),
        ...(item.delegateeName ? [{ name: { equals: item.delegateeName, mode: 'insensitive' as const } }] : []),
      ],
      phone: { not: null },
    } as any,
    select: { phone: true },
  }).catch(() => null);
  return entity?.phone ?? null;
}

async function contactOwner(item: any, plan: LifecyclePlan, body?: string): Promise<{ sent: boolean; channel: string }> {
  const { enqueueBrainPrompt } = await import('../services/brainPrompts/brainPromptQueueService');
  const day = new Date().toISOString().slice(0, 10);
  const r = await enqueueBrainPrompt({
    userId: item.userId,
    clientNumber: item.clientNumber,
    question: body ?? ownerQuestion(item, plan),
    openItemId: item.id,
    sideEffect: { kind: 'action_status_update', openItemId: item.id },
    criticality: plan.action === 'escalate_user' ? 'high' : 'routine',
    dedupKey: `action_lifecycle:${item.id}:${plan.action}:${day}`,
    ttlMs: 36 * 60 * 60 * 1000,
    metadata: { source: 'action_lifecycle_governor', lifecycleAction: plan.action },
  });
  return { sent: r.status !== 'duplicate', channel: 'brain_prompt' };
}

async function contactConcernedParty(item: any, body: string): Promise<{ sent: boolean; channel: string; receipt?: string }> {
  if (item.delegateeId) {
    // A queue row gives the internal delegatee's next WhatsApp reply an exact
    // correlation target; a fire-and-forget notification would fall into that
    // person's normal chat and lose the owner's open-item relationship.
    const { enqueueBrainPrompt } = await import('../services/brainPrompts/brainPromptQueueService');
    const r = await enqueueBrainPrompt({
      userId: item.delegateeId,
      clientNumber: item.clientNumber,
      question: body,
      openItemId: item.id,
      sideEffect: { kind: 'action_status_update', openItemId: item.id },
      criticality: 'routine',
      dedupKey: `action_lifecycle_party:${item.id}:${new Date().toISOString().slice(0, 10)}`,
      metadata: { openItemId: item.id, ownerUserId: item.userId },
    });
    return { sent: true, channel: 'brain_prompt', receipt: r.promptId };
  }

  const phone = await resolveConcernedPhone(item);
  if (phone) {
    const { sendTenantWhatsAppText } = await import('../services/notifications/tenantWhatsappSender');
    const r = await sendTenantWhatsAppText(item.clientNumber, phone, body, item.userId);
    if (r.ok) return { sent: true, channel: 'whatsapp', receipt: r.waMessageId };
  }

  if (item.delegateeEmail) {
    const { sendUserEmail } = await import('../services/gmailService');
    const subject = `Status and commitment: ${item.title.slice(0, 100)}`;
    const html = `<p>${escapeHtml(body).replace(/\n/g, '<br/>')}</p><p style="color:#666;font-size:12px">Sent by Nexeo on behalf of ${escapeHtml(firstName(item.owner?.name))}. Replies are tracked against this action.</p>`;
    const r = await sendUserEmail(item.userId, item.delegateeEmail, subject, html);
    if (r.success) return { sent: true, channel: 'email', receipt: r.messageId };
  }
  return { sent: false, channel: 'none' };
}

async function claimAndRecord(item: any, plan: LifecyclePlan, channel: string, receipt?: string): Promise<void> {
  const now = new Date();
  const current = readActionLifecycle(item.metadata);
  const dueIso = item.dueDate ? new Date(item.dueDate).toISOString() : null;
  const missedNow = !!dueIso && new Date(dueIso).getTime() <= now.getTime() && current.lastMissedDueDate !== dueIso;
  const state: ActionLifecycleState = {
    ...current,
    phase: plan.action === 'ask_deadline' ? 'needs_deadline'
      : plan.action === 'ask_completion_evidence' ? 'verification'
      : plan.action === 'escalate_user' ? 'escalated'
      : 'awaiting_status',
    nextFollowUpAt: nextDailyFollowUp(now).toISOString(),
    lastContactAt: now.toISOString(),
    lastContactChannel: channel,
    unansweredAttempts: plan.action === 'escalate_user' ? current.unansweredAttempts : current.unansweredAttempts + 1,
    missedCommitments: current.missedCommitments + (missedNow ? 1 : 0),
    lastMissedDueDate: missedNow ? dueIso : current.lastMissedDueDate,
    escalatedAt: plan.action === 'escalate_user' ? now.toISOString() : current.escalatedAt,
    escalationCount: plan.action === 'escalate_user' ? (current.escalationCount ?? 0) + 1 : current.escalationCount,
    needsUserIntervention: plan.action === 'escalate_user' ? false : current.needsUserIntervention,
    followUpHistory: [...current.followUpHistory, {
      at: now.toISOString(), event: plan.action, channel,
      summary: receipt ? `receipt:${receipt}` : plan.reason,
    }].slice(-40),
  };
  await prisma.openItem.update({
    where: { id: item.id },
    data: { metadata: { ...(item.metadata ?? {}), actionLifecycle: state } as any },
  });
  await prisma.agentAction.create({
    data: {
      clientNumber: item.clientNumber, userId: item.userId,
      actionType: plan.action === 'escalate_user' ? 'action_lifecycle_escalated' : 'action_lifecycle_follow_up',
      status: 'done', requiresApproval: false, executedByAgent: 'action_lifecycle_governor', riskTier: 'LOW',
      input: { openItemId: item.id, action: plan.action, audience: plan.audience } as any,
      output: { channel, receipt: receipt ?? null, nextFollowUpAt: state.nextFollowUpAt, reason: plan.reason } as any,
    } as any,
  }).catch(() => null);
}

export async function runActionLifecycleSweep(options: { dryRun?: boolean; now?: Date } = {}): Promise<ActionLifecycleRunResult> {
  const result: ActionLifecycleRunResult = { scanned: 0, contacted: 0, escalated: 0, held: 0, errors: 0 };
  const now = options.now ?? new Date();
  const items = await prisma.openItem.findMany({
    where: { status: { in: ACTIVE as any } },
    take: 500,
    orderBy: { updatedAt: 'asc' },
  }).catch((error: any) => {
    log.warn('action query failed', { error: error.message });
    return [] as any[];
  });
  const ownerIds = [...new Set((items as any[]).map((item) => item.userId))];
  const owners = ownerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, name: true },
      }).catch(() => [] as Array<{ id: number; name: string }>)
    : [];
  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
  for (const item of items as any[]) item.owner = ownerById.get(item.userId) ?? null;
  const itemIds = (items as any[]).map((item) => item.id);
  const activePrompts = itemIds.length
    ? await prisma.brainPromptQueue.findMany({
        where: { openItemId: { in: itemIds }, state: { in: ['queued', 'awaiting_reply'] } },
        select: { openItemId: true },
      }).catch(() => [] as Array<{ openItemId: string | null }>)
    : [];
  const itemWithActivePrompt = new Set(activePrompts.map((prompt) => prompt.openItemId).filter(Boolean));

  for (const item of items as any[]) {
    result.scanned += 1;
    try {
      // DRAFT slot filling is governed centrally but remains the specialist
      // worker's responsibility. Do not create a second prompt here.
      if (String(item.status).toUpperCase() === 'DRAFT') { result.held += 1; continue; }
      if (itemWithActivePrompt.has(item.id)) { result.held += 1; continue; }
      const plan = planActionLifecycle(item, now);
      if (plan.action === 'none') { result.held += 1; continue; }
      if (options.dryRun) {
        plan.action === 'escalate_user' ? result.escalated += 1 : result.contacted += 1;
        continue;
      }

      if (plan.action === 'escalate_user') {
        const state = readActionLifecycle(item.metadata);
        const sent = await contactOwner(item, plan, escalationQuestion(item, state, plan.reason));
        if (!sent.sent) { result.errors += 1; continue; }
        await claimAndRecord(item, plan, sent.channel);
        result.escalated += 1;
        continue;
      }

      let sent: { sent: boolean; channel: string; receipt?: string };
      if (plan.audience === 'concerned_party') {
        const { getBrainDisplayName } = await import('../services/knowledge/outboundIdentity');
        const brainName = await getBrainDisplayName(item.userId).catch(() => 'Nexeo');
        sent = await contactConcernedParty(item, questionFor(item, plan, brainName, item.owner?.name ?? 'the owner'));
        // Missing contact route is itself an intervention condition.
        if (!sent.sent) {
          const current = readActionLifecycle(item.metadata);
          const interventionReason = `No working WhatsApp or email route for ${item.delegateeName ?? 'the concerned party'}`;
          const interventionState: ActionLifecycleState = {
            ...current,
            needsUserIntervention: true,
            interventionReason,
            nextFollowUpAt: now.toISOString(),
          };
          await prisma.openItem.update({
            where: { id: item.id },
            data: { metadata: { ...(item.metadata ?? {}), actionLifecycle: {
              ...interventionState,
            } } as any },
          });
          const escalationPlan: LifecyclePlan = {
            action: 'escalate_user', audience: 'owner', reason: interventionReason,
          };
          const ownerContact = await contactOwner(
            item,
            escalationPlan,
            escalationQuestion(item, interventionState, interventionReason),
          );
          if (ownerContact.sent) {
            await claimAndRecord(
              { ...item, metadata: { ...(item.metadata ?? {}), actionLifecycle: interventionState } },
              escalationPlan,
              ownerContact.channel,
            );
            result.escalated += 1;
          } else {
            result.errors += 1;
          }
          continue;
        }
      } else {
        sent = await contactOwner(item, plan);
      }
      if (!sent.sent) { result.errors += 1; continue; }
      await claimAndRecord(item, plan, sent.channel, sent.receipt);
      result.contacted += 1;
    } catch (error: any) {
      result.errors += 1;
      log.warn('action lifecycle iteration failed', { itemId: item.id, error: error.message });
    }
  }
  return result;
}
