/**
 * waOutboundReconciliation — periodic safety net to ensure
 * whatsapp_outbound_messages has every outbound from each user's
 * recent chats, regardless of which capture path missed it.
 *
 * Per user 2026-05-16: "how can i be confident that this will be
 * resolved permanently for both email and whatsapp?"
 *
 * Confidence comes from DEFENSE IN DEPTH — three independent paths
 * that all try to capture the same signal:
 *
 *   Path 1: message_create event listener (real-time)
 *           — fast, but fragile (stops firing on webjs reconnect,
 *             may not fire on @lid chats)
 *   Path 2: back-catch-up on each inbound
 *           — runs whenever an inbound arrives, fetches recent
 *             chat history, writes any outbound we don't have.
 *             Independent of message_create.
 *   Path 3: this job — periodic reconciliation, every 10 min
 *           — walks the most-recently-active chats per connected
 *             user, fetches recent messages, ensures coverage.
 *             Independent of inbound activity too.
 *
 * Any ONE path failing doesn't break the contract. All three would
 * have to fail simultaneously for an outbound to be silently lost,
 * which is improbable.
 *
 * Plus: the waIngestHealthAudit job (separate, daily) compares
 * webjs's view of a chat against our DB and emits a structured
 * warning when coverage drops below 80%. So if all three capture
 * paths somehow fail, the audit makes it loud in pm2 logs.
 *
 * Cadence: every 10 min. Cheap — one getChats per connected user,
 * one fetchMessages per active chat (10 chats max).
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('wa-outbound-reconciliation');

const MAX_CHATS_PER_USER = 10;
const LOOKBACK_MS = 60 * 60 * 1000; // 1 hour

interface RunResult {
  usersScanned: number;
  chatsScanned: number;
  outboundWritten: number;
  errors: number;
}

export async function runWaOutboundReconciliation(): Promise<RunResult> {
  const result: RunResult = { usersScanned: 0, chatsScanned: 0, outboundWritten: 0, errors: 0 };

  const { listConnectedClients } = await import('../services/whatsapp/UserWebjsProvider').catch(() => ({ listConnectedClients: null as any }));
  if (!listConnectedClients) return result;

  const connected: Array<{ userId: number; clientNumber: string; client: any }> = await listConnectedClients();
  const nowMs = Date.now();
  const sinceMs = nowMs - LOOKBACK_MS;

  for (const { userId, clientNumber, client } of connected) {
    result.usersScanned += 1;
    try {
      const chats = await client.getChats().catch(() => [] as any[]);
      // Focus on chats with activity in the lookback window. Sort by
      // last-message time, take top N. Skips groups/newsletters.
      const recent = chats
        .filter((c: any) => c?.id?._serialized && !c.isGroup && !String(c.id._serialized).includes('@newsletter'))
        .filter((c: any) => c.lastMessage?.timestamp && c.lastMessage.timestamp * 1000 >= sinceMs)
        .sort((a: any, b: any) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0))
        .slice(0, MAX_CHATS_PER_USER);

      for (const chat of recent) {
        result.chatsScanned += 1;
        const chatId = String(chat.id._serialized);
        try {
          const messages = await chat.fetchMessages({ limit: 20 }).catch(() => [] as any[]);
          for (const m of messages) {
            if (!m.fromMe) continue;
            const ts = m.timestamp ? m.timestamp * 1000 : Date.now();
            if (ts < sinceMs) continue; // outside the window we care about
            const msgId = m.id?._serialized || m.id?.id || `recon:${chatId}:${ts}`;

            // Body fallback for media-only
            let body = String(m.body ?? '').slice(0, 4000);
            if (!body && m.hasMedia) {
              const t = String(m.type ?? '').toLowerCase();
              body = t === 'image' ? '[image]'
                : t === 'video' ? '[video]'
                : t === 'audio' || t === 'ptt' ? '[voice]'
                : t === 'document' ? '[document]'
                : t === 'sticker' ? '[sticker]'
                : '[media]';
            }
            if (!body) continue;

            // Upsert — idempotent on (userId, waMessageId).
            try {
              const before = await prisma.whatsAppOutboundMessage.findUnique({
                where: { userId_waMessageId: { userId, waMessageId: msgId } } as any,
                select: { id: true },
              }).catch(() => null);
              if (before) continue; // already have it
              await prisma.whatsAppOutboundMessage.create({
                data: {
                  clientNumber, userId,
                  chatId,
                  waMessageId: msgId,
                  bodyText: body,
                  sentAt: new Date(ts),
                } as any,
              });
              result.outboundWritten += 1;
            } catch (e: any) {
              result.errors += 1;
              log.warn('reconciliation write failed', { userId, chatId, error: e.message });
            }
          }
        } catch (e: any) {
          result.errors += 1;
          log.warn('reconciliation chat fetch failed', { userId, chatId, error: e.message });
        }
      }
    } catch (e: any) {
      result.errors += 1;
      log.warn('reconciliation user scan failed', { userId, error: e.message });
    }
  }

  return result;
}
