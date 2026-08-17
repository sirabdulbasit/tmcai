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
 *
 * ── TENANT BOUNDARY (DEF-192, Codex iteration-4 carried CRITICAL) ───────────
 * This job SENDS EMAIL in the owner's name, and it used to do so from a
 * global read: one `findMany` over every tenant's delegated items, an owner
 * identity resolved from a bare userId, and mutations matched on bare `id`.
 * Nothing enforced a tenant, so one worker could compose a chase using
 * identity it was not authorized to read (invariant #1).
 *
 * The boundary is now the entry point, exactly as DEF-189 did for the backlog
 * cleanup: `runDelegationFollowUpForTenant(clientNumber)` carries the tenant
 * into EVERY query, and the only cross-tenant read is the tenant REGISTRY
 * enumeration in `runDelegationFollowUp` (distinct clientNumber over active
 * users — the sanctioned `runContactPruneForAllTenants` shape), which reads no
 * tenant data. Owner identity is resolved UNDER the item's tenant
 * (`getUserNameAndEmail(userId, clientNumber)`), and every mutation is a
 * scoped `updateMany` whose affected-row count is checked — a row that is not
 * ours to change is not counted as chased, escalated or stale.
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

const ITEMS_PER_TENANT_RUN = 200;

/**
 * The ONLY cross-tenant read in this file, and it reads the tenant REGISTRY
 * (distinct clientNumber over active users), never tenant data. Deterministic
 * order; one tenant's failure never blocks the next.
 */
export async function runDelegationFollowUp(): Promise<FollowUpRunSummary> {
  const t0 = Date.now();
  const total: FollowUpRunSummary = { scanned: 0, sent: 0, held: 0, escalated: 0, marked_stale: 0, errors: 0, durationMs: 0 };

  const tenants = await prisma.user.findMany({
    where: { isActive: true },
    select: { clientNumber: true },
    distinct: ['clientNumber'],
    orderBy: { clientNumber: 'asc' },
  }).catch((e: any) => {
    total.errors += 1;
    log.warn('tenant registry read failed — no follow-ups this tick', { error: e?.message });
    return [] as Array<{ clientNumber: string }>;
  });

  for (const t of tenants) {
    try {
      const s = await runDelegationFollowUpForTenant(t.clientNumber);
      total.scanned += s.scanned;
      total.sent += s.sent;
      total.held += s.held;
      total.escalated += s.escalated;
      total.marked_stale += s.marked_stale;
      total.errors += s.errors;
    } catch (e: any) {
      total.errors += 1;
      log.warn('tenant follow-up pass failed', { clientNumber: t.clientNumber, error: e?.message });
    }
  }

  total.durationMs = Date.now() - t0;
  return total;
}

/** Chase ONE tenant's delegated items. Every query below carries this tenant. */
export async function runDelegationFollowUpForTenant(clientNumber: string): Promise<FollowUpRunSummary> {
  const t0 = Date.now();
  const summary: FollowUpRunSummary = { scanned: 0, sent: 0, held: 0, escalated: 0, marked_stale: 0, errors: 0, durationMs: 0 };
  const now = new Date();

  const items = await prisma.openItem.findMany({
    where: {
      clientNumber,
      status: 'DELEGATED',
      type: 'delegation',
      delegateeEmail: { not: null },
    } as any,
    take: ITEMS_PER_TENANT_RUN,
    orderBy: { updatedAt: 'asc' },
  }).catch((e: any) => { log.warn('query failed', { clientNumber, error: e.message }); return [] as any[]; });

  summary.scanned = items.length;
  if (items.length === 0) {
    summary.durationMs = Date.now() - t0;
    return summary;
  }

  const { decideChaseVerdict, composeChaseEmail, getUserNameAndEmail } =
    await import('../services/delegation/smartChaseService');
  const { resolveOpenItemsSettings } = await import('../services/openItems/openItemsSettings');
  const { sendUserEmail } = await import('../services/gmailService');

  // Per-(tenant, user) setting cache for this run (DEF-188 — a bare userId
  // key could serve one tenant another tenant's preferences). `null` caches
  // a pair with NO settings authority behind it (DEF-191, Codex iteration-4:
  // this job MUTATES and sends in the owner's name, so a missing/foreign
  // user row must hold the item, never inherit fabricated defaults).
  const settingsCache = new Map<string, { followUpDays: number } | null>();
  // DEF-192 — keyed by (tenant, user) and resolved UNDER the item's tenant. A
  // bare-userId key could serve one tenant another tenant's owner identity,
  // and that identity becomes the From-name of an outbound email.
  const ownerCache = new Map<string, { name: string; email: string } | null>();

  /**
   * DEF-192 — the ONE item-mutation path here. Tenant + user + id scope the
   * write and the affected-row count is the verdict: a row that moved, was
   * deleted, or belongs elsewhere is NOT ours and the caller must not count
   * the action as having happened. Replaces four `update({where:{id}})` calls
   * whose `.catch(() => {})` also hid every failure.
   */
  const scopedItemUpdate = async (
    item: { id: string; userId: number; clientNumber: string },
    data: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      const res = await prisma.openItem.updateMany({
        where: { id: item.id, clientNumber: item.clientNumber, userId: item.userId },
        data: data as any,
      });
      return res.count === 1;
    } catch (e: any) {
      log.warn('scoped item update failed', { itemId: item.id, error: e?.message });
      return false;
    }
  };

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

      // Per-user followUpDays baseline, under explicit authority (DEF-191).
      const settingsKey = `${item.clientNumber}|${item.userId}`;
      let s = settingsCache.get(settingsKey);
      if (s === undefined) {
        const resolved = await resolveOpenItemsSettings(item.userId, item.clientNumber);
        s = resolved.authority === 'no_user' ? null : { followUpDays: resolved.value!.followUpDays };
        settingsCache.set(settingsKey, s);
        if (s === null) {
          log.warn('no authorized user row behind this pair — follow-up held', {
            clientNumber: item.clientNumber, userId: item.userId,
          });
        }
      }
      if (s === null) {
        summary.held += 1;
        continue;
      }

      // Owner identity for compose + disclosure footer — resolved UNDER the
      // item's tenant (DEF-192): a pair that does not exist there reads
      // nothing, and an unresolvable owner never gets chased for.
      const ownerKey = `${item.clientNumber}|${item.userId}`;
      let owner = ownerCache.get(ownerKey);
      if (owner === undefined) {
        owner = await getUserNameAndEmail(item.userId, item.clientNumber);
        ownerCache.set(ownerKey, owner);
      }
      if (!owner) {
        log.warn('owner not resolvable in this tenant, skipping', {
          itemId: item.id, userId: item.userId, clientNumber: item.clientNumber,
        });
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
        // DEF-192 — the write is the fact. A zero-row result means this row
        // was not ours to change, so nothing is recorded and nothing counted.
        if (!(await scopedItemUpdate(item, {
          metadata: {
            ...meta,
            stale: true,
            staleAt: now.toISOString(),
            staleReason: verdict.reason,
            followUp: { ...fu, dueAt: null }, // stop the timer
          } as any,
        }))) { summary.errors += 1; continue; }
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
          if (!(await scopedItemUpdate(item, {
            priority: 'high',
            metadata: { ...meta, followUp: { ...fu, escalatedAt: now.toISOString(), escalateReason: verdict.reason } } as any,
          }))) { summary.errors += 1; continue; }
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
        // DEF-192 — scoped and count-checked like the others, but this one is
        // AFTER the email has left: a failed write does NOT mean the chase did
        // not happen, so `sent` still counts (that is the truthful fact) while
        // `errors` and a loud log record that the bookkeeping did not land.
        // KNOWN RESIDUAL, stated rather than implied: with no `lastSentAt`
        // persisted, the next tick can chase the same item again. That is
        // pre-existing (the old `.catch(() => {})` had the same hole and hid
        // it); making it visible is this turn's scope, fixing the re-send
        // needs a pre-send intent record and is not attempted here.
        const bookkept = await scopedItemUpdate(item, {
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
        });
        if (!bookkept) {
          summary.errors += 1;
          log.warn('CHASE SENT but its bookkeeping write did not land — the next tick may chase this item again', {
            itemId: item.id, clientNumber: item.clientNumber, userId: item.userId, messageId: r.messageId,
          });
        }

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
