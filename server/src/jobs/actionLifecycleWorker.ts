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
const MAX_CONTACTS_PER_USER_PER_RUN = Math.max(1, Number(process.env.ACTION_LIFECYCLE_MAX_PER_USER_PER_RUN ?? 3));
const MAX_CONTACTS_GLOBAL_PER_RUN = Math.max(1, Number(process.env.ACTION_LIFECYCLE_MAX_GLOBAL_PER_RUN ?? 100));

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

/** DEF-074 (2026-08-06) — the follow-up path had its OWN message format.
 *
 *  `Hi <who>, this is <brain> — <owner>'s AI assistant. …` was written inline
 *  here, while `notify_via_whatsapp` used the owner-specified template. So the
 *  SAME counterpart received two different-looking messages from the same
 *  number depending on which code path sent them.
 *
 *  Second implementations of a shared rule are what produced DEF-039, DEF-041,
 *  DEF-044, DEF-045 and DEF-051. This one only cost consistency, but it is the
 *  same mistake. The body is composed here; the wrapper belongs to
 *  `renderOutboundMessage` and nowhere else.
 */
function questionFor(item: any, plan: LifecyclePlan, brainName: string, ownerName: string): string {
  const owner = firstName(ownerName);
  const body = plan.action === 'ask_deadline'
    ? `Sir ${owner} is tracking "${item.title}" through completion. What date can you commit to? If it is delayed, please include the reason and the new deadline.`
    : plan.action === 'ask_completion_evidence'
      ? `Sir ${owner} noted that "${item.title}" is complete. Please confirm what was delivered, or share the completion reference.`
      : `The committed date for "${item.title}" has arrived. Is it completed? If not, please share the reason for the delay and a new committed date.`;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { renderOutboundMessage } = require('../services/notifications/outboundMessageTemplate');
  return renderOutboundMessage(body, { brainName, userName: ownerName });
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
    // Section 33a: register the send on its delegation thread —
    // outbound_intent BEFORE transport, receipt AFTER — so counterpart
    // replies correlate explicitly. CORRELATION EVIDENCE ONLY: no
    // authorization grant is created and no 33b eligibility conferred.
    // Registration is best-effort and must never block the send path.
    const registration = await registerWorkerSend(item, 'whatsapp', phone).catch(() => null);
    const { sendTenantWhatsAppText } = await import('../services/notifications/tenantWhatsappSender');
    const r = await sendTenantWhatsAppText(item.clientNumber, phone, body, item.userId);
    if (registration) {
      await recordWorkerReceipt(item.clientNumber, registration, r.ok ? 'accepted' : 'failed', (r as any).waMessageId ?? null)
        .catch(() => undefined);
    }
    if (r.ok) return { sent: true, channel: 'whatsapp', receipt: r.waMessageId };
  }

  // Section 33a (reviewer-BLOCKING, REQ-002 item 1): the counterpart
  // email branch is DISABLED FAIL-CLOSED. sendUserEmail sends from the
  // USER's identity — forbidden for delegation counterparts. Until 33b
  // ships an approved assistant/tenant sender, a counterpart without a
  // WhatsApp route escalates to the owner instead (structured prompt,
  // caller handles it via sent:false → owner escalation path).
  if (item.delegateeEmail) {
    log.info('counterpart email suppressed (no assistant identity yet — 33a fail-closed)', {
      openItemId: item.id, clientNumber: item.clientNumber,
    });
  }
  return { sent: false, channel: 'none' };
}

/** Upsert the thread and register outbound_intent (dispatch_pending).
 *  Returns what recordWorkerReceipt needs, or null when the thread
 *  cannot be created (bad destination) — the send proceeds regardless. */
async function registerWorkerSend(item: any, channel: 'whatsapp', destination: string):
  Promise<{ threadId: string; intentEventId: string; senderIdentity: string } | null> {
  const {
    upsertActiveThread, registerOutboundIntent,
  } = await import('../services/delegation/delegationThreadService');
  const thread = await upsertActiveThread({
    clientNumber: item.clientNumber, ownerUserId: item.userId,
    openItemId: item.id, channel, destination, origin: 'worker_send',
  });
  if (!thread) return null;
  const senderIdentity = `tenant_wa:${item.clientNumber}`;
  const intent = await registerOutboundIntent({
    clientNumber: item.clientNumber, threadId: thread.id, channel,
    senderIdentity, expectedState: thread.state as any,
  });
  if (!intent.ok || !intent.eventId) return null;
  return { threadId: thread.id, intentEventId: intent.eventId, senderIdentity };
}

async function recordWorkerReceipt(
  clientNumber: string,
  reg: { threadId: string; intentEventId: string; senderIdentity: string },
  status: 'accepted' | 'failed',
  providerMessageId: string | null,
): Promise<void> {
  const { registerOutboundReceipt } = await import('../services/delegation/delegationThreadService');
  await registerOutboundReceipt({
    clientNumber, threadId: reg.threadId, channel: 'whatsapp',
    senderIdentity: reg.senderIdentity, intentEventId: reg.intentEventId,
    status, providerMessageId,
  });
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
  const allItems = await prisma.openItem.findMany({
    where: { status: { in: ACTIVE as any } },
    take: 500,
    orderBy: { updatedAt: 'asc' },
  }).catch((error: any) => {
    log.warn('action query failed', { error: error.message });
    return [] as any[];
  });

  // DEF-109 — Brain's own items are never chased.
  //
  // Owner, twice: "you don't have to tell me about it repeatedly. When it's
  // done, then you have to tell me that we have done it." and "we will not talk
  // about the brain one again either, you have to take care of the brain
  // yourself, when it is complete, then tell me."
  //
  // This worker is the chase-and-remind path: it contacts delegatees, escalates
  // for intervention and asks the owner to resolve blockers. None of that
  // applies to work Brain owns — there is nobody to chase but itself, and the
  // owner has explicitly asked not to be asked. Filtered here rather than in
  // the query so the skip is countable and visible.
  const { isBrainOwned, BRAIN_OWNED_SKIP_REASON } = await import('../services/openItems/brainOwnership');
  const items = (allItems as any[]).filter((item) => !isBrainOwned(item));
  const brainOwnedSkipped = (allItems as any[]).length - items.length;
  if (brainOwnedSkipped > 0) {
    log.info('skipped brain-owned items', { count: brainOwnedSkipped, reason: BRAIN_OWNED_SKIP_REASON });
  }
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
  const contactsByOwner = new Map<number, number>();
  let contactsThisRun = 0;

  for (const item of items as any[]) {
    result.scanned += 1;
    try {
      // DRAFT slot filling is governed centrally but remains the specialist
      // worker's responsibility. Do not create a second prompt here.
      if (String(item.status).toUpperCase() === 'DRAFT') { result.held += 1; continue; }
      if (itemWithActivePrompt.has(item.id)) { result.held += 1; continue; }
      const plan = planActionLifecycle(item, now);
      if (plan.action === 'none') { result.held += 1; continue; }
      const ownerContacts = contactsByOwner.get(item.userId) ?? 0;
      if (contactsThisRun >= MAX_CONTACTS_GLOBAL_PER_RUN || ownerContacts >= MAX_CONTACTS_PER_USER_PER_RUN) {
        result.held += 1;
        continue;
      }
      if (options.dryRun) {
        plan.action === 'escalate_user' ? result.escalated += 1 : result.contacted += 1;
        continue;
      }

      if (plan.action === 'escalate_user') {
        const state = readActionLifecycle(item.metadata);
        const sent = await contactOwner(item, plan, escalationQuestion(item, state, plan.reason));
        if (!sent.sent) { result.errors += 1; continue; }
        await claimAndRecord(item, plan, sent.channel);
        contactsByOwner.set(item.userId, ownerContacts + 1);
        contactsThisRun += 1;
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
            contactsByOwner.set(item.userId, ownerContacts + 1);
            contactsThisRun += 1;
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
      contactsByOwner.set(item.userId, ownerContacts + 1);
      contactsThisRun += 1;
      result.contacted += 1;
    } catch (error: any) {
      result.errors += 1;
      log.warn('action lifecycle iteration failed', { itemId: item.id, error: error.message });
    }
  }
  return result;
}
