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

const log = createLogger('open-item-draft-ask');

const ACTIVE_DRAFT_STATUSES = ['DRAFT'];
const MAX_ASKS = 6; // days 0..5; day 6 expires
const WARN_DAY = 5; // include "I'll drop this draft today if I don't hear back"

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
  errors: number;
}

function dayIndex(createdAt: Date, now: Date): number {
  return Math.floor((now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000));
}

function buildAskBody(args: {
  title: string;
  missingSlots: Array<'priority' | 'dueDate'>;
  day: number;
  warn: boolean;
}): string {
  const { title, missingSlots, day, warn } = args;
  const slotPhrase = (() => {
    const both = missingSlots.includes('priority') && missingSlots.includes('dueDate');
    if (both) return 'priority and deadline';
    if (missingSlots.includes('priority')) return 'priority';
    return 'deadline';
  })();
  // Tone — natural, Brain identifies itself.
  const lead = day === 0
    ? `Quick one — what ${slotPhrase} should I put on this open item?\n\n"${title}"`
    : `Still need ${slotPhrase} for this open item (day ${day + 1}):\n\n"${title}"`;
  const warnLine = warn
    ? `\n\nIf I don't hear back today I'll drop this draft from your list. Reply "skip" if you want to drop it now.`
    : `\n\nReply with the priority (critical / high / medium / low) and/or a deadline (e.g. "tomorrow 5pm", "Fri", "May 22"). Reply "skip" to drop it.`;
  return `— Nexeo —\n${lead}${warnLine}`;
}

export async function runOpenItemDraftAsk(): Promise<RunResult> {
  const result: RunResult = { scanned: 0, asked: 0, expired: 0, errors: 0 };
  const now = new Date();
  const todayUtcDateStr = now.toISOString().slice(0, 10);

  // Pull all DRAFT items. Cap at 500 per run; daily cadence makes
  // this comfortably enough. Owner phone lookup happens inside
  // brainContactsUser so we don't duplicate the resolution logic.
  const drafts = await prisma.openItem.findMany({
    where: { status: { in: ACTIVE_DRAFT_STATUSES } as any },
    select: {
      id: true, title: true, status: true, createdAt: true,
      clientNumber: true, userId: true, metadata: true,
    } as any,
    take: 500,
  }) as any[];

  for (const item of drafts) {
    result.scanned += 1;
    try {
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

      // Day 6+ → expire.
      if (day >= MAX_ASKS) {
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
              inactivationReason: 'Draft expired — priority/deadline not provided after 6 daily prompts',
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

      const warn = day === WARN_DAY;
      const body = buildAskBody({ title: item.title, missingSlots, day, warn });

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
