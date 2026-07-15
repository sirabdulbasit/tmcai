/**
 * openItemDraftAskJob — daily WhatsApp slot-filling for DRAFT open items.
 *
 * User decision 2026-05-14: every open item must have priority AND
 * deadline. When either is missing at create, the item is parked as
 * status='DRAFT' (the gate does this). This job runs daily, walks
 * the DRAFT items, and asks the owner via the Nexeo channel
 * (sendViaNotifier — Brain's own identity, never the user's paired
 * channel) to fill in the missing slot(s).
 *
 * Cadence (per user spec):
 *   Day 0 (creation day):  first ask (sent by this job's first tick
 *                          after creation)
 *   Days 1-4:              one ask per day
 *   Day 5:                 final ask + warning ("if I don't hear
 *                          back today I'll drop this draft")
 *   Day 6 onward:          status -> CLOSED, audit reason recorded
 *                          ("Draft expired — priority/dueDate not
 *                          provided after 6 daily prompts")
 *
 * "Day N" is counted as floor((now - createdAt) / 24h).
 *
 * Tone: natural. Brain identifies itself as Nexeo and asks for the
 * specific missing slot(s). Per the 2026-05-13 / 2026-05-14
 * Brain-never-speaks-as-user rule: outbound goes via
 * sendViaNotifier (Nexeo identity), never via the user's paired
 * WhatsApp.
 *
 * Idempotency: items track lastAskAt in metadata.draft. The job
 * skips items that were already asked today (UTC day).
 *
 * Failure mode: if sendViaNotifier returns ok:false (tenant
 * notifier not configured), the ask is NOT recorded — next tick
 * retries. Once the tenant configures the notifier, the cadence
 * resumes from where it left off.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { brainContactsUser } from '../services/notifications/brainOutboundService';
import { planZombieLifecycle } from '../services/openItems/zombieItemPolicy';

const log = createLogger('open-item-draft-ask');

const ACTIVE_DRAFT_STATUSES = ['DRAFT'];
// MAX_ASKS / WARN_DAY are now per-user (Settings → Open Items →
// DRAFT expiry). Resolved per item via getOpenItemsSettings(userId).
// Day N is counted as floor((now - createdAt) / 24h):
//   days 0 .. (expiry-2): ask
//   day  (expiry-1):       final ask + warning
//   day  expiry or later:  status -> CLOSED, audit reason recorded.

interface DraftMeta {
  missingSlots?: Array<'priority' | 'dueDate'>;
  asksSentCount?: number;
  firstAskScheduledAt?: string | null;
  lastAskAt?: string | null;
  expiredAt?: string | null;
}

interface RunResult {
  scanned: number;
  asked: number;
  expired: number;
  quarantined: number;
  selfPruned: number;
  recovered: number;
  errors: number;
}

function dayIndex(createdAt: Date, now: Date): number {
  return Math.floor((now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000));
}

// Phrasing delegated to brainHumanComm.phraseDraftAsk so all
// Brain↔user voice lives in one place. Per user 2026-05-15:
// "user shouldn't feel that he is talking to any program".
// - varied wording per day/item
// - first-name greeting when available
// - no "— Nexeo —" branded header (Brain identity is conveyed by
//   the WhatsApp sender being Nexeo's number, not by a label)

export async function runOpenItemDraftAsk(): Promise<RunResult> {
  const result: RunResult = {
    scanned: 0, asked: 0, expired: 0, quarantined: 0, selfPruned: 0, recovered: 0, errors: 0,
  };
  const now = new Date();
  const todayUtcDateStr = now.toISOString().slice(0, 10);

  // Pull all DRAFT items. Cap at 500 per run; daily cadence makes
  // this comfortably enough. Owner phone lookup happens inside
  // brainContactsUser so we don't duplicate the resolution logic.
  const drafts = await prisma.openItem.findMany({
    where: { status: { in: ACTIVE_DRAFT_STATUSES } as any },
    select: {
      id: true, title: true, description: true, status: true, priority: true,
      dueDate: true, delegateeId: true, delegateeName: true,
      delegateeEmail: true, notes: true, createdAt: true,
      clientNumber: true, userId: true, metadata: true,
    } as any,
    take: 500,
  }) as any[];

  for (const item of drafts) {
    result.scanned += 1;
    try {
      // Self-pruning safety rail. Malformed residue is quarantined first, so it
      // cannot nag the user. It is only soft-closed after the policy grace
      // period, and any edit that makes it useful automatically recovers it.
      const prunePlan = planZombieLifecycle(item, now);
      if (prunePlan.action === 'quarantine') {
        await prisma.openItem.update({
          where: { id: item.id },
          data: {
            metadata: {
              ...(item.metadata ?? {}),
              selfPrune: prunePlan.selfPrune,
            } as any,
          },
        });
        result.quarantined += 1;
        log.info('Draft quarantined from proactive asks', { itemId: item.id, reason: prunePlan.reason });
        continue;
      }
      if (prunePlan.action === 'hold') continue;
      if (prunePlan.action === 'archive') {
        await prisma.openItem.update({
          where: { id: item.id },
          data: {
            status: 'CLOSED',
            metadata: {
              ...(item.metadata ?? {}),
              selfPrune: prunePlan.selfPrune,
              archivedReason: `zombie:${prunePlan.reason}`,
              archivedAt: now.toISOString(),
              inactivationReason: `Self-pruned after quarantine (${prunePlan.reason})`,
            } as any,
          },
        });
        result.selfPruned += 1;
        log.info('Quarantined draft soft-closed', { itemId: item.id, reason: prunePlan.reason });
        continue;
      }
      if (prunePlan.action === 'recover') {
        item.metadata = {
          ...(item.metadata ?? {}),
          selfPrune: prunePlan.selfPrune,
        };
        await prisma.openItem.update({
          where: { id: item.id },
          data: { metadata: item.metadata as any },
        });
        result.recovered += 1;
      }

      const meta: DraftMeta = (item.metadata?.draft ?? {}) as DraftMeta;
      const missingSlots = (meta.missingSlots ?? []).filter(
        (s) => s === 'priority' || s === 'dueDate',
      ) as Array<'priority' | 'dueDate'>;
      // If for some reason missingSlots resolved to empty, fix up the
      // status — item shouldn't be in DRAFT.
      if (missingSlots.length === 0) {
        await prisma.openItem.update({
          where: { id: item.id },
          data: { status: 'NEW' },
        }).catch(() => null);
        continue;
      }

      const day = dayIndex(item.createdAt, now);

      // Per-user DRAFT expiry — Settings → Open Items.
      const { getOpenItemsSettings } = await import('../services/openItems/openItemsSettings');
      const oiSettings = await getOpenItemsSettings(item.userId);
      const maxAsks = oiSettings.draftExpiryDays;
      const warnDay = Math.max(1, maxAsks - 1);

      // Day >= maxAsks → expire.
      if (day >= maxAsks) {
        await prisma.openItem.update({
          where: { id: item.id },
          data: {
            status: 'CLOSED',
            metadata: {
              ...(item.metadata ?? {}),
              draft: {
                ...meta,
                expiredAt: now.toISOString(),
              },
              inactivationReason: `Draft expired — priority/deadline not provided after ${maxAsks} daily prompts`,
            } as any,
          } as any,
        });
        result.expired += 1;
        continue;
      }

      // Skip if already asked today (UTC day).
      const lastAsk = meta.lastAskAt ? new Date(meta.lastAskAt) : null;
      if (lastAsk && lastAsk.toISOString().slice(0, 10) === todayUtcDateStr) {
        continue;
      }

      const { phraseDraftAsk, addressUser, rememberPending } = await import('../services/notifications/brainHumanComm');
      const userFirstName = await addressUser(item.userId);
      const body = phraseDraftAsk({
        userFirstName,
        itemTitle: item.title,
        missingSlots,
        dayIndex: day,
        itemId: item.id,
        warnDay,
      });

      // Brain → user via the canonical brainContactsUser path. Handles
      // opt-in gate, pause flag, quiet hours, dedup, channel selection.
      // dedupKey scoped per item per UTC day so each day's ask is
      // unique even if multiple ticks fire.
      const dispatchRes = await brainContactsUser({
        userId: item.userId,
        kind: 'open_item_draft_ask',
        summary: `Draft ask day ${day}: "${item.title.slice(0, 60)}"`,
        body,
        dedupKey: `draft_ask:${item.id}:${todayUtcDateStr}`,
      });
      if (!dispatchRes.sent) {
        log.warn('Draft ask not sent', { itemId: item.id, reason: dispatchRes.reason });
        result.errors += 1;
        // Do NOT advance asksSentCount or lastAskAt — next tick retries.
        continue;
      }

      // Remember pending so the user's reply ("high tomorrow 5pm" /
      // "do it" / "skip") can be resolved against this specific ask
      // when it arrives via WhatsApp. 24h TTL.
      await rememberPending(item.userId, {
        kind: 'open_item_draft_ask',
        refId: item.id,
        refTitle: item.title,
        meta: { missingSlots, dayIndex: day },
      });

      // Stamp success.
      await prisma.openItem.update({
        where: { id: item.id },
        data: {
          metadata: {
            ...(item.metadata ?? {}),
            draft: {
              ...meta,
              missingSlots,
              asksSentCount: (meta.asksSentCount ?? 0) + 1,
              firstAskScheduledAt: meta.firstAskScheduledAt ?? now.toISOString(),
              lastAskAt: now.toISOString(),
            },
          } as any,
        } as any,
      });
      result.asked += 1;
    } catch (err: any) {
      log.warn('Draft ask iteration error', { itemId: item.id, error: err.message });
      result.errors += 1;
    }
  }

  return result;
}
