/**
 * delegationFollowUpJob — smart chase emails for delegated open items.
 *
 * Rewritten 2026-05-18 after the Mohsin/Atif incident. The old job
 * fired canned "Just bumping this up..." emails on a fixed 3-day
 * cadence with no awareness of context, recipient, or signal. New
 * version:
 *
 *   1. Per-recipient tone — pulls the last ~8 emails the owner has
 *      sent to this specific delegatee from Gmail and feeds them
 *      to the composer as few-shot tone samples. The chase email
 *      reads like one the owner would actually write to this person.
 *
 *   2. LLM-judged timing — instead of a flat 3-day timer, an LLM
 *      verdict (hold / chase / escalate / mark_stale) decides per
 *      item per tick using: priority, due date, days since delegated,
 *      days since last attempt, attempt count, owner activity on the
 *      thread, the user's followUpDays baseline setting. Conservative
 *      by default — prefers hold when uncertain.
 *
 *   3. Disclosure footer — every chase email ends with a single line
 *      identifying it as sent via Nexeo on the owner's behalf. This
 *      is the structural mitigation for the
 *      feedback_brain_never_speaks_as_user concern: even though the
 *      email leaves the owner's Gmail (so it threads correctly), the
 *      recipient can always tell auto from manual. Replies still land
 *      in the owner's inbox, so the owner stays in the loop.
 *
 *   4. Forbidden-phrase guard — the composer is told not to use
 *      "just bumping", "circling back", "any update", etc. If the
 *      LLM uses one, it's asked once to rewrite. No regex panel makes
 *      the substance call; the phrase list is structural filler.
 *
 *   5. Per-user settings — followUpDays (cadence baseline) and
 *      maxFollowUps drive the verdict. Settings → Open Items.
 *
 * Identity / safety: sends from the owner's Gmail (via sendUserEmail)
 * but every body carries the disclosure footer. Audit row in
 * agent_actions with action_type='delegation_follow_up_sent' captures
 * the recipient + Gmail message id + attempt number for traceability.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('delegation-followup');

export interface FollowUpRunSummary {
  scanned: number;
  sent: number;
  held: number;
  escalated: number;
  marked_stale: number;
  errors: number;
  durationMs: number;
}

export async function runDelegationFollowUp(): Promise<FollowUpRunSummary> {
  const t0 = Date.now();
  const summary: FollowUpRunSummary = { scanned: 0, sent: 0, held: 0, escalated: 0, marked_stale: 0, errors: 0, durationMs: 0 };
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
  if (items.length === 0) {
    summary.durationMs = Date.now() - t0;
    return summary;
  }

  const { decideChaseVerdict, composeChaseEmail, getUserNameAndEmail } =
    await import('../services/delegation/smartChaseService');
  const { getOpenItemsSettings } = await import('../services/openItems/openItemsSettings');
  const { sendUserEmail } = await import('../services/gmailService');

  // Per-user setting cache for this run.
  const settingsCache = new Map<number, { followUpDays: number }>();
  const ownerCache = new Map<number, { name: string; email: string } | null>();

  for (const item of items) {
    try {
      const meta: any = (item.metadata as any) ?? {};
      const fu = meta.followUp ?? {};
      const count = Number(fu.count ?? 0);
      const max = Number(fu.maxFollowUps ?? 3);
      const lastSent = fu.lastSentAt ? new Date(fu.lastSentAt) : null;
      const lastResp = fu.lastResponseAt ? new Date(fu.lastResponseAt) : null;

      // Delegatee already responded since last send? Skip — tracker
      // updates the item separately.
      if (lastResp && (!lastSent || lastResp > lastSent)) {
        summary.held += 1;
        continue;
      }

      // Per-user followUpDays baseline.
      let s = settingsCache.get(item.userId);
      if (!s) {
        const oi = await getOpenItemsSettings(item.userId);
        s = { followUpDays: oi.followUpDays };
        settingsCache.set(item.userId, s);
      }

      // Owner identity for compose + disclosure footer.
      let owner = ownerCache.get(item.userId);
      if (owner === undefined) {
        owner = await getUserNameAndEmail(item.userId);
        ownerCache.set(item.userId, owner);
      }
      if (!owner) {
        log.warn('owner not resolvable, skipping', { itemId: item.id, userId: item.userId });
        summary.errors += 1;
        continue;
      }

      // "Owner activity" = any note recorded since last chase. Cheap
      // proxy; richer signals (Gmail thread reply, calendar update)
      // would be nice but require more I/O per tick.
      const notes: any[] = Array.isArray((item as any).notes) ? (item as any).notes : [];
      const lastOwnerNoteAt = notes
        .filter((n) => n && n.by !== 'delegation_followup' && n.at)
        .map((n) => new Date(n.at).getTime())
        .reduce((m, t) => Math.max(m, t), 0);
      const hasOwnerActivity = !!lastSent && lastOwnerNoteAt > lastSent.getTime();

      // Delegated-at: createdAt is a fine proxy for delegation moment.
      const delegatedAt = (item as any).createdAt as Date;

      // ─── Verdict ─────────────────────────────────────────────────
      const verdict = await decideChaseVerdict({
        itemId: item.id,
        itemTitle: item.title,
        itemPriority: item.priority ?? null,
        itemDueDate: (item.dueDate as Date | null) ?? null,
        delegatedAt,
        lastChaseAt: lastSent,
        attemptsSent: count,
        maxAttempts: max,
        followUpDaysBaseline: s.followUpDays,
        hasOwnerActivity,
      }, item.userId, item.clientNumber);

      if (verdict.verdict === 'hold') {
        summary.held += 1;
        continue;
      }

      if (verdict.verdict === 'mark_stale') {
        await prisma.openItem.update({
          where: { id: item.id },
          data: {
            metadata: {
              ...meta,
              stale: true,
              staleAt: now.toISOString(),
              staleReason: verdict.reason,
              followUp: { ...fu, dueAt: null }, // stop the timer
            } as any,
          } as any,
        }).catch(() => {});
        await prisma.agentAction.create({
          data: {
            clientNumber: item.clientNumber, userId: item.userId,
            actionType: 'delegation_marked_stale',
            status: 'done', requiresApproval: false,
            executedByAgent: 'delegation_followup',
            input: { openItemId: item.id } as any,
            output: { reason: verdict.reason, attempts: count } as any,
          } as any,
        }).catch(() => {});
        summary.marked_stale += 1;
        continue;
      }

      if (verdict.verdict === 'escalate') {
        // Only escalate once — flip priority high, surface via
        // agent_action so the owner can act in Day Brief. The owner
        // can then call the delegatee, switch to Nexeo WA, or close
        // the loop manually.
        if (item.priority !== 'high' && item.priority !== 'critical') {
          await prisma.openItem.update({
            where: { id: item.id },
            data: {
              priority: 'high',
              metadata: { ...meta, followUp: { ...fu, escalatedAt: now.toISOString(), escalateReason: verdict.reason } } as any,
            } as any,
          }).catch(() => {});
        }
        await prisma.agentAction.create({
          data: {
            clientNumber: item.clientNumber, userId: item.userId,
            actionType: 'delegation_escalated',
            status: 'done', requiresApproval: false,
            executedByAgent: 'delegation_followup',
            input: { openItemId: item.id } as any,
            output: {
              delegateeName: item.delegateeName,
              delegateeEmail: item.delegateeEmail,
              title: item.title,
              followUpsSent: count,
              reason: verdict.reason,
            } as any,
          } as any,
        }).catch(() => {});
        summary.escalated += 1;
        continue;
      }

      // ─── Verdict = chase. Compose + send. ────────────────────────
      const composed = await composeChaseEmail({
        userId: item.userId,
        clientNumber: item.clientNumber,
        userName: owner.name,
        userEmail: owner.email,
        recipientName: item.delegateeName ?? (item.delegateeEmail as string).split('@')[0],
        recipientEmail: item.delegateeEmail as string,
        itemTitle: item.title,
        itemDescription: String(item.description ?? ''),
        itemDueDate: (item.dueDate as Date | null) ?? null,
        delegatedAt,
        attemptNumber: count + 1,
        maxAttempts: max,
      });

      if (!composed) {
        summary.errors += 1;
        log.warn('compose failed, skipping send', { itemId: item.id });
        continue;
      }

      const r = await sendUserEmail(item.userId, item.delegateeEmail as string, composed.subject, composed.body);

      if (r.success) {
        // Next dueAt = followUpDays from now. The verdict on the NEXT
        // tick will refine based on signals at that time.
        const nextDueAt = new Date(Date.now() + s.followUpDays * 24 * 60 * 60 * 1000);
        const existingNotes: any[] = Array.isArray((item as any).notes) ? (item as any).notes : [];
        await prisma.openItem.update({
          where: { id: item.id },
          data: {
            notes: [...existingNotes, {
              at: now.toISOString(),
              by: 'delegation_followup',
              event: 'follow_up_sent',
              count: count + 1,
              messageId: r.messageId,
              toneSamplesUsed: composed.toneSamplesUsed,
              verdictReason: verdict.reason,
            }] as any,
            metadata: {
              ...meta,
              followUp: {
                ...fu,
                dueAt: nextDueAt.toISOString(),
                count: count + 1,
                lastSentAt: now.toISOString(),
                lastMessageId: r.messageId,
                lastVerdictReason: verdict.reason,
              },
            } as any,
            updatedAt: now,
          } as any,
        });

        await prisma.agentAction.create({
          data: {
            clientNumber: item.clientNumber, userId: item.userId,
            actionType: 'delegation_follow_up_sent',
            status: 'done', requiresApproval: false,
            executedByAgent: 'delegation_followup',
            input: { openItemId: item.id } as any,
            output: {
              delegateeName: item.delegateeName,
              delegateeEmail: item.delegateeEmail,
              title: item.title,
              subject: composed.subject,
              attempt: count + 1,
              messageId: r.messageId,
              nextDueAt: nextDueAt.toISOString(),
              toneSamplesUsed: composed.toneSamplesUsed,
              disclosureFooter: true,
              verdictReason: verdict.reason,
            } as any,
          } as any,
        }).catch(() => {});

        summary.sent += 1;
        log.info('chase sent', {
          itemId: item.id,
          attempt: count + 1,
          toneSamples: composed.toneSamplesUsed,
          to: item.delegateeEmail,
        });
      } else {
        summary.errors += 1;
        log.warn('send failed', { itemId: item.id, error: r.error });
      }
    } catch (err: any) {
      summary.errors += 1;
      log.warn('item failed', { id: item.id, error: err.message });
    }
  }

  summary.durationMs = Date.now() - t0;
  return summary;
}
