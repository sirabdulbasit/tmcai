/**
 * MyOS — Sender Wiki Backfill.
 *
 * One-time walk of every historical feed_event for a user, folding them
 * into the sender_history and sender_topic Wiki pages. Gives Brain a full
 * running memory from day one instead of only learning from new events.
 *
 * Strategy:
 *   1. Iterate feed_events chronologically (oldest → newest) in batches.
 *   2. For each event, compute dedup_hash + archetype and call
 *      updateSenderWikiOnIngest with mode='backfill' (skips per-batch LLM).
 *   3. After the walk, run ONE llm-based resummarize per distinct sender
 *      that now has ≥2 interactions. Bounded total LLM cost.
 *
 * Idempotent — rerunning will just overwrite pages with the same content
 * (counts get re-accumulated from scratch because updates are incremental;
 * to keep it correct we clear existing sender_history / sender_topic pages
 * for the user at the start of the walk).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { updateSenderWikiOnIngest, resummarizeSenderPage } from './senderWikiService';
import { classifyArchetypeFromPayload } from '../triage/executorHelpers';
import { computeDedupHash } from '../triage/triageSuggester';

const log = createLogger('sender-wiki-backfill');

export interface BackfillSummary {
  clientNumber: string;
  userId: number;
  totalEvents: number;
  processed: number;
  skipped: number;
  errors: number;
  uniqueSenders: number;
  resummarized: number;
  durationMs: number;
}

export interface BackfillOptions {
  /** Wipe existing sender_history + sender_topic pages before walking.
   *  Recommended on re-runs to avoid double-counting. Default: true. */
  wipeFirst?: boolean;
  /** Cap on how many distinct senders to run LLM resummarize for after the
   *  walk. Bounds total cost on large accounts. Default: 100. */
  maxResummarize?: number;
  /** Batch size for the chronological walk. Default: 500. */
  batchSize?: number;
}

export async function backfillSenderWiki(
  clientNumber: string,
  userId: number,
  opts: BackfillOptions = {},
): Promise<BackfillSummary> {
  const t0 = Date.now();
  const wipeFirst = opts.wipeFirst ?? true;
  const maxResummarize = opts.maxResummarize ?? 100;
  const batchSize = opts.batchSize ?? 500;

  const summary: BackfillSummary = {
    clientNumber, userId,
    totalEvents: 0, processed: 0, skipped: 0, errors: 0,
    uniqueSenders: 0, resummarized: 0, durationMs: 0,
  };

  // 1. Clean slate so incremental counters start at 0 again
  if (wipeFirst) {
    await prisma.wikiPage.deleteMany({
      where: { clientNumber, userId, pageType: { in: ['sender_history', 'sender_topic'] } as any } as any,
    }).catch(() => {});
    log.info('wiped existing sender_history / sender_topic pages', { clientNumber, userId });
  }

  // 2. Chronological walk — oldest first so "recent" window ends on actual latest
  const totalEvents = await prisma.feedEvent.count({
    where: { clientNumber, userId, senderEmail: { not: null } } as any,
  }).catch(() => 0);
  summary.totalEvents = totalEvents;

  if (totalEvents === 0) {
    summary.durationMs = Date.now() - t0;
    return summary;
  }

  const distinctSenders = new Set<string>();
  let cursor: Date | null = null;

  while (summary.processed + summary.skipped + summary.errors < totalEvents) {
    const batch: any[] = await prisma.feedEvent.findMany({
      where: {
        clientNumber, userId,
        // email OR phone — WhatsApp events have phone only
        OR: [{ senderEmail: { not: null } }, { senderPhone: { not: null } }] as any,
        ...(cursor ? { createdAt: { gt: cursor } } : {}),
      } as any,
      select: {
        id: true, sourceType: true, senderEmail: true, senderPhone: true,
        senderName: true, rawPayload: true, createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    }).catch(() => [] as any[]);

    if (batch.length === 0) break;

    for (const ev of batch) {
      try {
        if (!ev.senderEmail && !ev.senderPhone) { summary.skipped += 1; continue; }

        const p: any = ev.rawPayload ?? {};
        const itemType =
          ev.sourceType === 'gmail' ? 'email' :
          ev.sourceType === 'whatsapp' ? 'whatsapp' :
          ev.sourceType === 'gcal' ? 'meeting' :
          ev.sourceType === 'gtasks' ? 'task' : 'email';

        let archetype: string | undefined;
        let dedupHash: string | undefined;
        try {
          archetype = classifyArchetypeFromPayload(
            String(p.subject ?? ''),
            String(p.snippet ?? p.body ?? ''),
            String(p.from ?? ev.senderEmail ?? ev.senderPhone),
          );
          const senderDomain = ev.senderEmail?.split('@')[1]?.toLowerCase();
          dedupHash = computeDedupHash({
            userId,
            itemType: itemType as any,
            archetype: archetype as any,
            senderDomain,
          });
        } catch { /* topic page just skipped for this row */ }

        await updateSenderWikiOnIngest({
          clientNumber, userId,
          senderEmail: ev.senderEmail ?? null,
          senderPhone: ev.senderPhone ?? null,
          senderName: ev.senderName ?? null,
          subject: String(p.subject ?? p.summary ?? p.title ?? '') || null,
          preview: String(p.snippet ?? p.body ?? '') || null,
          dedupHash, archetype,
          sourceType: ev.sourceType,
          feedEventId: ev.id,
          receivedAt: ev.createdAt,
          mode: 'backfill',
        });

        distinctSenders.add((ev.senderEmail ?? ev.senderPhone ?? '').toLowerCase());
        summary.processed += 1;
      } catch (err: any) {
        summary.errors += 1;
        log.warn('event backfill failed', { feedEventId: ev.id, error: err.message });
      }
    }

    cursor = batch[batch.length - 1].createdAt;
    if (summary.processed % 2000 === 0) {
      log.info('backfill progress', { processed: summary.processed, total: totalEvents });
    }
  }

  summary.uniqueSenders = distinctSenders.size;

  // 3. One-time LLM resummarize per distinct sender (capped)
  const sendersToSummarize = Array.from(distinctSenders).slice(0, maxResummarize);
  for (const sender of sendersToSummarize) {
    try {
      await resummarizeSenderPage(clientNumber, userId, sender);
      summary.resummarized += 1;
    } catch (err: any) {
      log.warn('resummarize failed', { sender, error: err.message });
    }
  }

  summary.durationMs = Date.now() - t0;
  log.info('backfill complete', summary as any);
  return summary;
}
