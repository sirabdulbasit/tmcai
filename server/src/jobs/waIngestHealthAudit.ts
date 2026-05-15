/**
 * waIngestHealthAudit — periodic reconciliation between what webjs sees
 * in each WhatsApp chat and what we have stored in feed_events +
 * whatsapp_outbound_messages.
 *
 * Per user 2026-05-15: "make sure this should not happen again" after
 * discovering Brain had only 1 of ~5 inbound messages from a contact
 * and ZERO of the outbound messages, with no visible signal that
 * anything was wrong. Missing-ingest is silent; the only detection
 * channel today is a sharp user noticing a specific gap. This job
 * makes it loud.
 *
 * What it does:
 *   For each connected webjs user, sample their recent chats (last
 *   N=20 active chats). For each chat, ask webjs how many messages
 *   it has in the last K=14 days. Compare against:
 *     - feed_events count (inbound)
 *     - whatsapp_outbound_messages count
 *   If (webjs_count - db_count) / webjs_count > 0.2 (i.e., we have
 *   <80% coverage), emit a structured warning log line.
 *
 * What it does NOT do:
 *   - Doesn't auto-backfill missing messages. That's a separate
 *     decision (some gaps are legitimate: pre-pairing history,
 *     deleted messages, system events the type whitelist filters).
 *   - Doesn't surface to UI yet. First step is making the gap
 *     visible in logs; UI integration is a follow-up.
 *
 * Cadence: daily. Cheap — one webjs.getChats per user, a few
 * chat.fetchMessages calls per active chat. Skips users with no
 * active webjs client.
 *
 * Failure mode: best-effort. A user whose webjs is disconnected
 * just gets skipped; no error escalation.
 *
 * Brain-rule note: this is observability, not auto-fix. The fix
 * for any specific gap depends on its shape (ingest filter
 * dropping it / outbound capture missed it / pre-pairing). Surface
 * the gap, let a human decide. Adding auto-backfill prematurely
 * would risk re-ingesting events we deliberately filtered (e2e_
 * notifications, ciphertext, etc.).
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('wa-ingest-audit');

interface ChatGapReport {
  userId: number;
  clientNumber: string;
  chatId: string;
  chatName: string;
  webjsCount: number;
  feedEventsCount: number;
  outboundCount: number;
  dbTotal: number;
  coveragePct: number;
}

interface AuditResult {
  usersAudited: number;
  chatsAudited: number;
  gapsFound: number;
  errors: number;
  gaps: ChatGapReport[];
}

const LOOKBACK_DAYS = 14;
const MAX_CHATS_PER_USER = 20;
const COVERAGE_THRESHOLD = 0.8;

export async function runWaIngestHealthAudit(): Promise<AuditResult> {
  const result: AuditResult = {
    usersAudited: 0,
    chatsAudited: 0,
    gapsFound: 0,
    errors: 0,
    gaps: [],
  };

  const sinceMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  // Pull active webjs clients via the provider — only audit users
  // we can actually query. Disconnected users are skipped (no
  // signal in that case anyway).
  const { listConnectedClients } = await import('../services/whatsapp/UserWebjsProvider').catch(() => ({ listConnectedClients: null as any }));
  if (!listConnectedClients) {
    log.warn('listConnectedClients not exported; skipping audit');
    return result;
  }

  const connected: Array<{ userId: number; clientNumber: string; client: any }> = await listConnectedClients();
  for (const { userId, clientNumber, client } of connected) {
    result.usersAudited += 1;
    try {
      const chats = await client.getChats().catch(() => [] as any[]);
      // Filter to relevant chats: 1:1 only (skip groups/status), sorted by
      // recent activity, top N.
      const oneOnOnes = chats
        .filter((c: any) => c?.id?._serialized && !c.isGroup && !String(c.id._serialized).includes('@newsletter'))
        .filter((c: any) => c.lastMessage?.timestamp && c.lastMessage.timestamp * 1000 >= sinceMs)
        .sort((a: any, b: any) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0))
        .slice(0, MAX_CHATS_PER_USER);

      for (const chat of oneOnOnes) {
        result.chatsAudited += 1;
        const chatId = String(chat.id._serialized);
        try {
          // Count messages webjs has in the lookback window
          const msgs = await chat.fetchMessages({ limit: 200 }).catch(() => [] as any[]);
          const webjsCount = msgs.filter((m: any) => m.timestamp * 1000 >= sinceMs).length;
          if (webjsCount === 0) continue; // empty window — nothing to compare

          // Count what we have in DB
          const [feedCount, outCount] = await Promise.all([
            prisma.feedEvent.count({
              where: {
                clientNumber, userId,
                sourceType: 'whatsapp',
                createdAt: { gte: new Date(sinceMs) },
                rawPayload: { path: ['chatId'], equals: chatId } as any,
              } as any,
            }).catch(() => 0),
            prisma.whatsAppOutboundMessage.count({
              where: {
                clientNumber, userId,
                chatId,
                sentAt: { gte: new Date(sinceMs) },
              } as any,
            }).catch(() => 0),
          ]);

          const dbTotal = feedCount + outCount;
          const coverage = dbTotal / webjsCount;
          if (coverage < COVERAGE_THRESHOLD) {
            const gap: ChatGapReport = {
              userId, clientNumber, chatId,
              chatName: String(chat.name ?? chat.id.user ?? chatId).slice(0, 60),
              webjsCount,
              feedEventsCount: feedCount,
              outboundCount: outCount,
              dbTotal,
              coveragePct: Math.round(coverage * 100),
            };
            result.gaps.push(gap);
            result.gapsFound += 1;
            log.warn('ingest gap detected', { ...gap } as Record<string, unknown>);
          }
        } catch (e: any) {
          result.errors += 1;
          log.warn('chat audit failed', { userId, chatId, error: e.message });
        }
      }
    } catch (e: any) {
      result.errors += 1;
      log.warn('user audit failed', { userId, error: e.message });
    }
  }

  return result;
}
