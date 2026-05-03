/**
 * MyOS — Delegation Follow-Up Job.
 *
 * Runs every 30 min. Finds MD-owned OpenItems with status='DELEGATED' whose
 * metadata.followUp.dueAt has passed without a delegatee response since
 * the last nudge, composes a short follow-up in the MD's tone, sends it
 * via Gmail as the MD, and records an agent_action so the BRIEF section
 * of Day Brief shows what Brain did ("I pinged Asad about Billing
 * Architecture — 2nd follow-up").
 *
 * Gates:
 *   - Only email-delegated items (delegateeEmail required; no WA for POC).
 *   - Not more than metadata.followUp.maxFollowUps (default 3) sends.
 *   - After max reached, priority bumps to 'high' and a Noticed-insight
 *     gets surfaced instead of yet another email.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('delegation-followup');

export interface FollowUpRunSummary {
  scanned: number;
  sent: number;
  escalated: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export async function runDelegationFollowUp(): Promise<FollowUpRunSummary> {
  const t0 = Date.now();
  const summary: FollowUpRunSummary = { scanned: 0, sent: 0, escalated: 0, skipped: 0, errors: 0, durationMs: 0 };
  const now = new Date();

  const items = await prisma.openItem.findMany({
    where: {
      status: 'DELEGATED',
      type: 'delegation',
      delegateeEmail: { not: null },
    } as any,
    take: 200,
    orderBy: { updatedAt: 'asc' },
  }).catch((e: any) => { log.warn('query failed', { error: e.message }); return [] as any[]; });

  summary.scanned = items.length;

  for (const item of items) {
    try {
      const meta: any = (item.metadata as any) ?? {};
      const fu = meta.followUp ?? {};
      const dueAt = fu.dueAt ? new Date(fu.dueAt) : null;
      if (!dueAt || dueAt > now) { summary.skipped += 1; continue; }

      const count = Number(fu.count ?? 0);
      const max = Number(fu.maxFollowUps ?? 3);
      const lastSent = fu.lastSentAt ? new Date(fu.lastSentAt) : null;
      const lastResp = fu.lastResponseAt ? new Date(fu.lastResponseAt) : null;

      // Delegatee already responded since last send? Skip — tracker service
      // handles the actual status change on inbound.
      if (lastResp && (!lastSent || lastResp > lastSent)) { summary.skipped += 1; continue; }

      if (count >= max) {
        // Stop nagging — bump priority, let MD decide. Only escalate once.
        if (item.priority !== 'high') {
          await prisma.openItem.update({
            where: { id: item.id },
            data: {
              priority: 'high',
              metadata: { ...meta, followUp: { ...fu, escalatedAt: now.toISOString() } } as any,
            } as any,
          });
          await prisma.agentAction.create({
            data: {
              clientNumber: item.clientNumber,
              userId: item.userId,
              actionType: 'delegation_escalated',
              status: 'done',
              requiresApproval: false,
              executedByAgent: 'delegation_followup',
              input: { openItemId: item.id } as any,
              output: {
                delegateeName: item.delegateeName,
                delegateeEmail: item.delegateeEmail,
                title: item.title,
                followUpsSent: count,
                reason: `${count} follow-ups sent without a response — escalated`,
              } as any,
            } as any,
          }).catch(() => {});
          summary.escalated += 1;
        }
        continue;
      }

      // Compose + send the follow-up in MD's tone
      const { composeForwardNote } = await import('../services/knowledge/toneService');
      const { sendUserEmail } = await import('../services/gmailService');
      const nudgeText = await composeForwardNote({
        userId: item.userId,
        delegateeName: item.delegateeName ?? undefined,
        originalSender: '(internal follow-up)',
        originalSubject: item.title,
        originalSnippet: String(item.description ?? '').slice(0, 400),
        mdNote: count === 0
          ? `Quick follow-up on this — any update when you get a chance?`
          : `Just bumping this up — wanted to check where we are on it.`,
      });

      const subjectLine = item.title.toLowerCase().startsWith('re:')
        ? item.title
        : `Re: ${item.title}`;

      const r = await sendUserEmail(item.userId, item.delegateeEmail as string, subjectLine, nudgeText);

      if (r.success) {
        const nextDueAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // next nudge in 3 days
        const existingNotes: any[] = Array.isArray(item.notes) ? (item.notes as any[]) : [];
        await prisma.openItem.update({
          where: { id: item.id },
          data: {
            notes: [...existingNotes, {
              at: now.toISOString(),
              by: 'delegation_followup',
              event: 'follow_up_sent',
              count: count + 1,
              messageId: r.messageId,
            }] as any,
            metadata: {
              ...meta,
              followUp: {
                ...fu,
                dueAt: nextDueAt.toISOString(),
                count: count + 1,
                lastSentAt: now.toISOString(),
                lastMessageId: r.messageId,
              },
            } as any,
            updatedAt: now,
          } as any,
        });

        await prisma.agentAction.create({
          data: {
            clientNumber: item.clientNumber,
            userId: item.userId,
            actionType: 'delegation_follow_up_sent',
            status: 'done',
            requiresApproval: false,
            executedByAgent: 'delegation_followup',
            input: { openItemId: item.id } as any,
            output: {
              delegateeName: item.delegateeName,
              delegateeEmail: item.delegateeEmail,
              title: item.title,
              attempt: count + 1,
              messageId: r.messageId,
              nextDueAt: nextDueAt.toISOString(),
            } as any,
          } as any,
        }).catch(() => {});

        summary.sent += 1;
        log.info('follow-up sent', { openItemId: item.id, attempt: count + 1 });
      } else {
        summary.errors += 1;
        log.warn('send failed', { openItemId: item.id, error: r.error });
      }
    } catch (err: any) {
      summary.errors += 1;
      log.warn('item failed', { id: item.id, error: err.message });
    }
  }

  summary.durationMs = Date.now() - t0;
  return summary;
}
