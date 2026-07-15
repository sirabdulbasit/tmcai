// ═════════════════════════════════════════════════════════════════════════════
// whatsappService.ts — Phase 8.5: WhatsApp Integration via Meta Cloud API
//
// Handles:
// - Outbound messaging (text + template) via Meta Graph API
// - Inbound webhook processing
// - Multi-turn session management (24h inactivity window)
// - Daily limits: 100/connection, 20/agent, 200/user
// - All outbound passes through outputSanitizer
// ═════════════════════════════════════════════════════════════════════════════

import prisma from '../db/prisma';
import { isFeatureEnabled } from './featureFlagService';
import createLogger from '../utils/logger';

const log = createLogger('whatsapp');

const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const DAILY_LIMIT_USER = 200;
const DAILY_LIMIT_AGENT = 20;
const DAILY_LIMIT_CONNECTION = 100;

// ─── Connection management ────────────────────────────────────────────────────

export async function connectWhatsApp(
  userId: number,
  phoneNumber: string,
  waId?: string,
): Promise<void> {
  await prisma.whatsAppConnection.upsert({
    where: { userId },
    create: { userId, phoneNumber, waId: waId ?? null, status: 'active', provider: 'meta' },
    update: { phoneNumber, waId: waId ?? null, status: 'active', updatedAt: new Date() },
  });
  log.info('WhatsApp connected', { userId, phoneNumber });
}

export async function disconnectWhatsApp(userId: number): Promise<void> {
  await prisma.whatsAppConnection.updateMany({
    where: { userId },
    data: { status: 'disconnected', updatedAt: new Date() },
  });
}

export async function getWhatsAppStatus(userId: number): Promise<{
  connected: boolean;
  phoneNumber?: string;
  status?: string;
}> {
  const conn = await prisma.whatsAppConnection.findUnique({ where: { userId } });
  if (!conn || conn.status !== 'active') return { connected: false };
  return { connected: true, phoneNumber: conn.phoneNumber, status: conn.status };
}

// ─── Daily limit check ────────────────────────────────────────────────────────

async function checkDailyLimits(
  userId: number,
  agentId?: number,
): Promise<{ allowed: boolean; reason?: string }> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [userCount, agentCount, connCount]: any[] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT COUNT(*) as cnt FROM whatsapp_messages
       WHERE user_id = $1 AND direction = 'out' AND created_at >= $2`,
      userId, todayStart,
    ),
    agentId
      ? prisma.$queryRawUnsafe(
          `SELECT COUNT(*) as cnt FROM whatsapp_messages
           WHERE agent_id = $1 AND direction = 'out' AND created_at >= $2`,
          agentId, todayStart,
        )
      : Promise.resolve([{ cnt: 0 }]),
    prisma.$queryRawUnsafe(
      `SELECT COUNT(*) as cnt FROM whatsapp_messages wm
       JOIN whatsapp_connections wc ON wc.user_id = wm.user_id
       WHERE wm.user_id = $1 AND wm.direction = 'out' AND wm.created_at >= $2`,
      userId, todayStart,
    ),
  ]);

  if (Number(userCount[0]?.cnt || 0) >= DAILY_LIMIT_USER) {
    return { allowed: false, reason: `Daily user limit (${DAILY_LIMIT_USER}) reached` };
  }
  if (agentId && Number(agentCount[0]?.cnt || 0) >= DAILY_LIMIT_AGENT) {
    return { allowed: false, reason: `Daily agent limit (${DAILY_LIMIT_AGENT}) reached` };
  }
  if (Number(connCount[0]?.cnt || 0) >= DAILY_LIMIT_CONNECTION) {
    return { allowed: false, reason: `Daily connection limit (${DAILY_LIMIT_CONNECTION}) reached` };
  }

  return { allowed: true };
}

// ─── Outbound messaging ───────────────────────────────────────────────────────

export async function sendWhatsAppMessage(
  userId: number,
  content: string,
  agentId?: number,
  sessionId?: number,
): Promise<{ sent: boolean; messageId?: string; reason?: string }> {
  const enabled = await isFeatureEnabled('GLOBAL', 'ff_whatsapp_enabled', false);
  if (!enabled) return { sent: false, reason: 'WhatsApp not enabled' };

  const conn = await prisma.whatsAppConnection.findUnique({ where: { userId } });
  if (!conn || conn.status !== 'active') {
    return { sent: false, reason: 'No active WhatsApp connection' };
  }

  const limits = await checkDailyLimits(userId, agentId);
  if (!limits.allowed) return { sent: false, reason: limits.reason };

  // Sanitize content before sending
  const sanitized = sanitizeOutbound(content);

  // Call Meta Cloud API
  let externalMessageId: string | undefined;
  try {
    externalMessageId = await callMetaAPI(conn.phoneNumber, sanitized);
  } catch (err: any) {
    log.error('Meta API send failed', { userId, error: err.message });
    // Log as failed
    await prisma.whatsAppMessage.create({
      data: {
        userId,
        direction: 'out',
        content: sanitized,
        status: 'failed',
        agentId: agentId ?? null,
        sessionId: sessionId ?? null,
      },
    });
    return { sent: false, reason: 'Meta API error' };
  }

  await prisma.whatsAppMessage.create({
    data: {
      userId,
      direction: 'out',
      content: sanitized,
      messageId: externalMessageId ?? null,
      status: 'sent',
      agentId: agentId ?? null,
      sessionId: sessionId ?? null,
    },
  });

  // Update session lastMessageAt
  if (sessionId) {
    await prisma.whatsAppSession.update({
      where: { id: sessionId },
      data: {
        lastMessageAt: new Date(),
        conversationHistory: { push: { role: 'assistant', content: sanitized, ts: Date.now() } },
      },
    });
  }

  log.info('WhatsApp message sent', { userId, agentId, messageId: externalMessageId });
  return { sent: true, messageId: externalMessageId };
}

/**
 * HaseebOS v15 H4 — send a WhatsApp message to any phone number (not just the
 * calling user's registered one). Used when an agent delegates a reply to an
 * external contact. Logs as outbound with no userId scoping.
 */
export async function sendWhatsAppToPhone(
  clientNumber: string,
  toPhone: string,
  content: string,
  agentId?: number,
): Promise<{ sent: boolean; messageId?: string; reason?: string }> {
  const enabled = await isFeatureEnabled('GLOBAL', 'ff_whatsapp_enabled', false);
  if (!enabled) return { sent: false, reason: 'WhatsApp not enabled' };

  const sanitized = sanitizeOutbound(content);
  let externalMessageId: string | undefined;
  try {
    externalMessageId = await callMetaAPI(toPhone, sanitized);
  } catch (err: any) {
    log.error('Meta API send-to-phone failed', { clientNumber, toPhone, error: err.message });
    return { sent: false, reason: 'Meta API error' };
  }

  // Log the outbound under a pseudo-user record via WhatsAppMessage; if we can't
  // resolve a userId for this phone, skip the DB log (Meta is source of truth).
  try {
    const conn = await prisma.whatsAppConnection.findFirst({ where: { phoneNumber: toPhone } });
    if (conn) {
      await prisma.whatsAppMessage.create({
        data: {
          userId: conn.userId,
          direction: 'out',
          content: sanitized,
          messageId: externalMessageId ?? null,
          status: 'sent',
          agentId: agentId ?? null,
        },
      });
    }
  } catch (err: any) {
    log.warn('WhatsApp send-to-phone DB log failed (non-fatal)', { err: err.message });
  }

  log.info('WhatsApp message sent to external phone', { clientNumber, toPhone, messageId: externalMessageId });
  return { sent: true, messageId: externalMessageId };
}

// ─── Inbound webhook processing ───────────────────────────────────────────────

export interface InboundMessage {
  waId: string;     // sender's WhatsApp ID
  phoneNumber: string;
  content: string;
  messageId: string;
  timestamp: number;
}

export async function processInboundMessage(msg: InboundMessage): Promise<void> {
  const enabled = await isFeatureEnabled('GLOBAL', 'ff_whatsapp_inbound', false);
  if (!enabled) {
    log.debug('Inbound WhatsApp disabled, dropping message', { waId: msg.waId });
    return;
  }

  // Identify user by waId or phoneNumber
  const conn = await prisma.whatsAppConnection.findFirst({
    where: {
      OR: [{ waId: msg.waId }, { phoneNumber: msg.phoneNumber }],
      status: 'active',
    },
  });

  if (!conn) {
    log.warn('Inbound WhatsApp from unknown number', { waId: msg.waId });
    return;
  }

  const userId = conn.userId;

  // Get or create session
  const session = await getOrCreateSession(userId);

  // Log inbound message
  await prisma.whatsAppMessage.create({
    data: {
      userId,
      direction: 'in',
      content: msg.content,
      messageId: msg.messageId,
      status: 'received',
      sessionId: session.id,
    },
  });

  // Update session history
  await prisma.whatsAppSession.update({
    where: { id: session.id },
    data: {
      lastMessageAt: new Date(),
      conversationHistory: { push: { role: 'user', content: msg.content, ts: msg.timestamp } },
    },
  });

  // HaseebOS v15 — publish to feed.raw so the Feed Curator agent can triage
  try {
    const { ingest } = await import('./feed/feedIngestionService');
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { clientNumber: true } });
    if (user?.clientNumber) {
      await ingest({
        clientNumber: user.clientNumber,
        sourceType: 'whatsapp',
        sourceId: msg.messageId,
        payload: {
          userId,
          waId: msg.waId,
          phoneNumber: msg.phoneNumber,
          content: msg.content,
          timestamp: msg.timestamp,
          sessionId: session.id,
        },
      });
    }
  } catch (err: any) {
    log.warn('Feed ingestion failed for inbound WhatsApp (non-fatal)', { err: err.message });
  }

  log.info('Inbound WhatsApp processed', { userId, sessionId: session.id });
  // Actual LLM response is triggered by the route handler or agent worker — not here
}

// ─── Session management ───────────────────────────────────────────────────────

export async function getOrCreateSession(
  userId: number,
  agentId?: number,
): Promise<{ id: number; conversationHistory: any[]; isNew: boolean }> {
  const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS);

  // Find active session within timeout window
  const existing = await prisma.whatsAppSession.findFirst({
    where: {
      userId,
      closedAt: null,
      lastMessageAt: { gte: cutoff },
      ...(agentId !== undefined ? { agentId } : {}),
    },
    orderBy: { lastMessageAt: 'desc' },
  });

  if (existing) {
    return {
      id: existing.id,
      conversationHistory: (existing.conversationHistory as any[]) || [],
      isNew: false,
    };
  }

  // Close any stale open sessions for this user
  await prisma.whatsAppSession.updateMany({
    where: { userId, closedAt: null },
    data: { closedAt: new Date() },
  });

  const newSession = await prisma.whatsAppSession.create({
    data: {
      userId,
      agentId: agentId ?? null,
      conversationHistory: [],
      lastMessageAt: new Date(),
    },
  });

  return { id: newSession.id, conversationHistory: [], isNew: true };
}

export async function closeSession(sessionId: number): Promise<void> {
  await prisma.whatsAppSession.update({
    where: { id: sessionId },
    data: { closedAt: new Date() },
  });
}

export async function getSessionHistory(sessionId: number): Promise<any[]> {
  const session = await prisma.whatsAppSession.findUnique({ where: { id: sessionId } });
  return (session?.conversationHistory as any[]) || [];
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function sanitizeOutbound(content: string): string {
  // Strip any injected instructions or system prompt leakage
  return content
    .replace(/\[SYSTEM\]/gi, '')
    .replace(/\[INST\]/gi, '')
    .replace(/<\|.*?\|>/g, '')
    .trim()
    .slice(0, 4096); // Meta message size limit
}

async function callMetaAPI(toPhone: string, content: string): Promise<string> {
  const accessToken = process.env.META_WHATSAPP_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    throw new Error('META_WHATSAPP_TOKEN or META_PHONE_NUMBER_ID not configured');
  }

  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: toPhone,
    type: 'text',
    text: { body: content },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Meta API ${resp.status}: ${errText}`);
  }

  const data = await resp.json() as any;
  return data?.messages?.[0]?.id ?? 'unknown';
}
