/**
 * MyOS — UserWebjsProvider (Path A, per-user WhatsApp pairing).
 *
 * Distinct from WebjsProvider (which is tenant-scoped for customer-facing
 * bot conversations). This provider pairs the MD's personal WhatsApp via
 * QR scan so incoming chats land in My Attention as feed_events, and
 * terminal actions (archive, reply, delegate) can mark the conversation
 * as read + optionally send a reply on the MD's behalf.
 *
 * State model:
 *   user_connectors.connector_type=whatsapp_personal
 *     .metadata = { status, qrDataUrl, qrExpiresAt, connectedNumber, lastError }
 *   Client instances are kept in-memory per userId; the LocalAuth session
 *   (on disk under WHATSAPP_USER_SESSION_PATH) survives process restart
 *   so the next boot silently reconnects without a new QR.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { ingest as ingestFeedEvent } from '../feed/feedIngestionService';
import fs from 'fs';
import path from 'path';

const log = createLogger('whatsapp:user-webjs');

// Per-user state
const clients = new Map<number, any>();
const waMessageIndex = new Map<string, { userId: number; chatId: string }>(); // feedEventId → chat pointer

// Excluded-contacts cache — MD's list of numbers that should NEVER flow into
// Day Brief or be read by Brain (wife, kids, close friends). Numbers are
// stored in user.notificationPreferences.whatsapp.excludedNumbers as E.164.
// Cached 60s per user to keep the inbound hot path fast.
interface ExcludedCache { numbers: Set<string>; fetchedAt: number }
const excludedCache = new Map<number, ExcludedCache>();
const EXCLUDED_TTL = 60_000;

function normalizePhone(p: string): string {
  return (p || '').replace(/[^+\d]/g, '');
}

async function excludedFor(userId: number): Promise<Set<string>> {
  const cached = excludedCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < EXCLUDED_TTL) return cached.numbers;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { notificationPreferences: true } });
  const prefs: any = u?.notificationPreferences ?? {};
  const list: string[] = prefs?.whatsapp?.excludedNumbers ?? [];
  const set = new Set(list.map(normalizePhone).filter(Boolean));
  excludedCache.set(userId, { numbers: set, fetchedAt: Date.now() });
  return set;
}

export async function getExcludedNumbers(userId: number): Promise<string[]> {
  const s = await excludedFor(userId);
  return Array.from(s);
}

export async function setExcludedNumbers(userId: number, numbers: string[]): Promise<string[]> {
  const clean = Array.from(new Set(numbers.map(normalizePhone).filter((n) => n.length >= 7)));
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { notificationPreferences: true } });
  const prefs: any = (u?.notificationPreferences as any) ?? {};
  prefs.whatsapp = { ...(prefs.whatsapp ?? {}), excludedNumbers: clean };
  await prisma.user.update({ where: { id: userId }, data: { notificationPreferences: prefs as any } });
  excludedCache.set(userId, { numbers: new Set(clean), fetchedAt: Date.now() });
  return clean;
}

type Status = 'disconnected' | 'connecting' | 'qr' | 'connected' | 'error';

interface UserMeta {
  status?: Status;
  qrDataUrl?: string | null;
  qrExpiresAt?: string | null;
  connectedNumber?: string | null;
  lastError?: string | null;
  sessionClientId?: string;
  pairedAt?: string | null;
}

async function getUserConnector(userId: number) {
  return prisma.userConnector.findFirst({
    where: { userId, connectorType: { slug: 'whatsapp_personal' } },
    include: { connectorType: true },
  });
}

/** Ensure the user has a whatsapp_personal row — lazy-creates on first pair.
 *  Avoids a seed migration per new user. */
async function ensureUserConnector(userId: number, clientNumber: string) {
  const existing = await getUserConnector(userId);
  if (existing) return existing;
  const type = await prisma.connectorType.findUnique({ where: { slug: 'whatsapp_personal' } });
  if (!type) return null;
  try {
    await prisma.userConnector.create({
      data: {
        userId,
        clientNumber,
        connectorTypeId: type.id,
        status: 'pending',
        config: {} as any,
        metadata: { status: 'disconnected' } as any,
      },
    });
  } catch { /* concurrent insert — next findFirst will see it */ }
  return getUserConnector(userId);
}

async function writeMeta(userId: number, patch: UserMeta, status?: Status) {
  const existing = await getUserConnector(userId);
  if (!existing) return;
  const meta = { ...(existing.metadata as any || {}), ...patch };

  // DB status column is a stable "is this pairing alive overall" marker.
  // Map providers real-time state to the canonical values:
  //   connected    → 'connected'
  //   disconnected → 'disconnected'
  //   error        → 'error'
  //   connecting/qr → DO NOT DOWNGRADE. A previously-connected row should
  //                  stay 'connected' through reconnect blips so the gap
  //                  banner / stats don't flicker off on server restart.
  let nextStatus: string | undefined;
  if (status === 'connected') nextStatus = 'connected';
  else if (status === 'disconnected') nextStatus = 'disconnected';
  else if (status === 'error') nextStatus = 'error';

  await prisma.userConnector.update({
    where: { id: existing.id },
    data: {
      metadata: meta as any,
      ...(nextStatus ? { status: nextStatus } : {}),
      updatedAt: new Date(),
    },
  });
}

async function loadDeps() {
  // @ts-ignore optional dep
  const wwebjs: any = await import('whatsapp-web.js' as string);
  // @ts-ignore optional dep
  const QRCode: any = await import('qrcode' as string);
  return { Client: wwebjs.Client || wwebjs.default?.Client, LocalAuth: wwebjs.LocalAuth || wwebjs.default?.LocalAuth, QRCode };
}

function resolveChromePath() {
  // Honour both PUPPETEER_EXECUTABLE_PATH (puppeteer's official convention)
  // and CHROME_PATH (legacy). Linux fallback uses google-chrome-stable
  // because /usr/bin/chromium-browser on Ubuntu 24.04 is a snap shim that
  // won't launch from headless node processes.
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  return '/usr/bin/google-chrome-stable';
}

/** Inlined from WebjsProvider — see comment there for the full rationale. */
function cleanStaleSingletonLocks(sessionDir: string): void {
  if (!fs.existsSync(sessionDir)) return;
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(sessionDir, name);
    let stale = false;
    try {
      const target = fs.readlinkSync(p);
      const m = /-(\d+)$/.exec(target);
      const pid = m ? Number(m[1]) : NaN;
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (err: any) { if (err.code === 'ESRCH') stale = true; }
      } else { stale = true; }
    } catch (err: any) {
      if (err.code === 'ENOENT') continue;
      stale = true;
    }
    if (stale) {
      try { fs.unlinkSync(p); log.warn('removed stale chromium lock (user)', { file: p }); } catch {}
    }
  }
}

export async function startPairing(userId: number, clientNumber: string): Promise<{ status: Status; qrDataUrl: string | null; connectedNumber: string | null; error?: string }> {
  const existing = await ensureUserConnector(userId, clientNumber);
  if (!existing) {
    return { status: 'error', qrDataUrl: null, connectedNumber: null, error: 'whatsapp_personal connector type missing. Run migration 20260421_whatsapp_personal_connector.' };
  }

  if (clients.has(userId)) {
    // Already running — return current state
    return getStatus(userId);
  }

  let Client: any, LocalAuth: any, QRCode: any;
  try { ({ Client, LocalAuth, QRCode } = await loadDeps()); }
  catch (e: any) {
    await writeMeta(userId, { status: 'error', lastError: 'whatsapp-web.js not installed' }, 'error');
    return { status: 'error', qrDataUrl: null, connectedNumber: null, error: 'whatsapp-web.js not installed' };
  }

  const sessionPath = process.env.WHATSAPP_USER_SESSION_PATH || './whatsapp-user-sessions';
  const clientId = `u${userId}`;

  // Restart resilience — see WebjsProvider.cleanStaleSingletonLocks for
  // the rationale. Inlined here because UserWebjsProvider doesn't share
  // a base class with WebjsProvider; a tiny duplication beats a circular
  // import or a third utility file just for this 20-liner.
  cleanStaleSingletonLocks(path.join(sessionPath, `session-${clientId}`));

  const client = new Client({
    authStrategy: new LocalAuth({ clientId, dataPath: sessionPath }),
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      executablePath: resolveChromePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-zygote', '--disable-gpu'],
    },
  });

  clients.set(userId, client);
  await writeMeta(userId, { status: 'connecting', sessionClientId: clientId, lastError: null }, 'connecting' as any);

  client.on('qr', async (qr: string) => {
    try {
      const qrDataUrl = await QRCode.toDataURL(qr);
      await writeMeta(userId, {
        status: 'qr',
        qrDataUrl,
        qrExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      log.info('QR issued', { userId });
    } catch (e: any) { log.error('QR save failed', { userId, error: e.message }); }
  });

  client.on('ready', async () => {
    const number = client.info?.wid?.user ? '+' + client.info.wid.user : null;
    await writeMeta(userId, {
      status: 'connected',
      qrDataUrl: null,
      qrExpiresAt: null,
      connectedNumber: number,
      lastError: null,
      pairedAt: new Date().toISOString(),
    }, 'connected');
    log.info('Paired', { userId, number });
  });

  client.on('auth_failure', async (msg: string) => {
    await writeMeta(userId, { status: 'error', lastError: msg }, 'error');
    log.error('auth_failure', { userId, msg });
  });

  client.on('disconnected', async (reason: string) => {
    clients.delete(userId);
    await writeMeta(userId, { status: 'disconnected', lastError: `disconnected: ${reason}` });
    log.info('Disconnected', { userId, reason });
  });

  client.on('message', async (message: any) => {
    try {
      if (message.fromMe) return;
      const rawFrom = message.from || '';
      if (rawFrom === 'status@broadcast' || rawFrom.includes('@g.us') || rawFrom.includes('@newsletter')) return;
      if (!message.body?.trim() && !message.hasMedia) return;

      let phone = '';
      if (rawFrom.includes('@c.us')) phone = '+' + rawFrom.replace('@c.us', '');
      else if (rawFrom.includes('@lid')) {
        try {
          const contact = await message.getContact();
          phone = '+' + (contact?.number || contact?.id?.user || rawFrom.replace('@lid', ''));
        } catch { phone = '+' + rawFrom.replace('@lid', ''); }
      } else phone = '+' + rawFrom.replace(/@.*$/, '');

      // Privacy filter — never ingest messages from excluded contacts
      // (wife, family, close friends). Brain never sees these and they
      // never appear in Day Brief. Checked per-message with a 60s cache.
      const excluded = await excludedFor(userId);
      if (excluded.has(normalizePhone(phone))) {
        log.info('Skipped excluded contact', { userId, phone });
        return;
      }

      let senderName: string | undefined;
      try { const c = await message.getContact(); senderName = c?.pushname || c?.name || c?.verifiedName; } catch {}

      // Pull last ~10 turns of this chat so Brain can reason about context
      // — "On it" / "sure" / "yes" mean nothing without the preceding ask.
      let threadContext: ThreadTurn[] = [];
      try {
        const chat = await message.getChat();
        if (chat?.fetchMessages) {
          const prior = await chat.fetchMessages({ limit: 15 });
          threadContext = (prior || [])
            .filter((m: any) => (m.body && m.body.trim()))
            .slice(-10)
            .map((m: any) => ({
              from: m.fromMe ? 'me' : 'them',
              text: String(m.body).slice(0, 500),
              timestamp: m.timestamp ? m.timestamp * 1000 : Date.now(),
            } as ThreadTurn));
        }
      } catch (e: any) { log.warn('threadContext fetch failed', { error: e.message }); }

      const payload = {
        waMessageId: message.id?._serialized || message.id?.id || null,
        chatId: rawFrom,
        phoneNumber: phone,
        senderName: senderName || null,
        body: message.body || '',
        type: message.type || 'chat',
        hasMedia: !!message.hasMedia,
        timestamp: message.timestamp ? message.timestamp * 1000 : Date.now(),
        threadContext,
      };

      const result = await ingestFeedEvent({
        clientNumber,
        sourceType: 'whatsapp',
        sourceId: payload.waMessageId || `${rawFrom}:${payload.timestamp}`,
        payload,
        userId,
        eventType: 'message_received',
        sender: { id: rawFrom, phone, name: senderName },
      });

      if (result.feedEventId) {
        waMessageIndex.set(result.feedEventId, { userId, chatId: rawFrom });
      }
    } catch (e: any) {
      log.error('message handler error', { userId, error: e.message });
    }
  });

  try {
    await client.initialize();
  } catch (e: any) {
    clients.delete(userId);
    await writeMeta(userId, { status: 'error', lastError: e.message }, 'error');
    return { status: 'error', qrDataUrl: null, connectedNumber: null, error: e.message };
  }

  return getStatus(userId);
}

export async function getStatus(userId: number): Promise<{ status: Status; qrDataUrl: string | null; connectedNumber: string | null; error?: string }> {
  const row = await getUserConnector(userId);
  const meta = (row?.metadata as any) || {};
  return {
    status: (meta.status as Status) || 'disconnected',
    qrDataUrl: meta.qrDataUrl || null,
    connectedNumber: meta.connectedNumber || null,
    error: meta.lastError || undefined,
  };
}

export async function disconnect(userId: number): Promise<void> {
  const client = clients.get(userId);
  if (client) {
    try { await client.logout(); } catch {}
    try { await client.destroy(); } catch {}
    clients.delete(userId);
  }
  await writeMeta(userId, { status: 'disconnected', qrDataUrl: null, qrExpiresAt: null, connectedNumber: null }, 'disconnected' as any);
}

export async function sendReply(userId: number, toChatId: string, text: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const client = clients.get(userId);
  if (!client) {
    return { success: false, error: 'WhatsApp session not active — open Connectors and re-scan the QR to re-pair.' };
  }
  try {
    const msg = await client.sendMessage(toChatId, text);
    const messageId = msg?.id?._serialized || msg?.id?.id;

    // Fire-and-forget commitment extraction on every outbound message.
    // Idempotent on (channel='whatsapp', sourceRef=messageId).
    void (async () => {
      try {
        if (!messageId) return;
        const u = await prisma.user.findUnique({
          where: { id: userId }, select: { clientNumber: true },
        });
        if (!u?.clientNumber) return;
        const recipient = '+' + String(toChatId).replace(/@.*$/, '');
        const { extractAndFileCommitments } = await import('../knowledge/commitmentExtractor');
        await extractAndFileCommitments({
          clientNumber: u.clientNumber, userId,
          channel: 'whatsapp', sourceRef: messageId,
          recipient, subject: null, body: text,
          sentAt: new Date(),
        });
      } catch { /* best effort */ }
    })();

    return { success: true, messageId };
  } catch (e: any) {
    return { success: false, error: `WhatsApp send failed: ${e.message}` };
  }
}

/**
 * Mark a WhatsApp conversation as read. Accepts either a waMessageId (from
 * feed_event payload) or a chatId. Mirrors gmailService.markAsRead semantics:
 * fire-and-forget from the action pipeline, success means "we tried".
 */
export async function markAsRead(userId: number, chatIdOrWaMessageId: string): Promise<{ success: boolean; error?: string }> {
  const client = clients.get(userId);
  if (!client) return { success: false, error: 'Not paired' };
  try {
    let chatId = chatIdOrWaMessageId;
    if (!chatId.includes('@')) {
      // Treat as waMessageId — try to locate the chat via getMessageById
      try {
        const msg = await client.getMessageById(chatIdOrWaMessageId);
        chatId = msg?.from || chatId;
      } catch {}
    }
    const chat = await client.getChatById(chatId);
    if (chat?.sendSeen) await chat.sendSeen();
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Pull the last N messages the MD has SENT in a specific chat, so Brain can
 * learn the exact WhatsApp texting style for that relationship. Skipped
 * messages: media-only (no body). Returns empty array if not paired or
 * chatId unreachable.
 */
export async function fetchSentSamplesForChat(userId: number, chatId: string, limit = 30): Promise<string[]> {
  const client = clients.get(userId);
  if (!client) return [];
  try {
    const chat = await client.getChatById(chatId);
    if (!chat?.fetchMessages) return [];
    const msgs = await chat.fetchMessages({ limit: Math.max(50, limit * 2) });
    return (msgs || [])
      .filter((m: any) => m.fromMe && m.body && m.body.trim())
      .slice(-limit)
      .map((m: any) => String(m.body).slice(0, 400));
  } catch { return []; }
}

/**
 * Pull the last N messages (both directions) from a chat, so Brain can
 * understand what an ambiguous message like "On it" or "yes" is actually
 * referring to. Returns an ordered transcript oldest→newest, each entry
 * tagged with who spoke. Used by triage + reply composition.
 */
export interface ThreadTurn {
  from: 'me' | 'them';
  text: string;
  timestamp: number;
}
export async function fetchThreadContext(userId: number, chatId: string, limit = 10): Promise<ThreadTurn[]> {
  const client = clients.get(userId);
  if (!client) return [];
  try {
    const chat = await client.getChatById(chatId);
    if (!chat?.fetchMessages) return [];
    const msgs = await chat.fetchMessages({ limit: Math.max(20, limit * 2) });
    return (msgs || [])
      .filter((m: any) => (m.body && m.body.trim()) || m.type === 'ptt' || m.type === 'audio')
      .slice(-limit)
      .map((m: any) => ({
        from: m.fromMe ? 'me' : 'them',
        text: String(m.body || '(voice note)').slice(0, 500),
        timestamp: m.timestamp ? m.timestamp * 1000 : Date.now(),
      }));
  } catch { return []; }
}

/** Resume previously-paired sessions on server boot.
 *
 *  Important: if the tenant-level WebjsProvider is ALREADY logged in to
 *  the same phone number, we SKIP the per-user resume for that phone.
 *  Otherwise two headless Chromiums race for the same WhatsApp account,
 *  each kicks the other out, and the UI sees a "keeps disconnecting"
 *  loop. Pick one owner per phone.
 */
export async function resumeAllSessions(): Promise<void> {
  const rows = await prisma.userConnector.findMany({
    where: { connectorType: { slug: 'whatsapp_personal' }, status: 'connected' },
    include: { connectorType: true },
  });

  // Read tenant-level claims so we don't double-bind the same phone.
  const tenantClaims = await prisma.$queryRawUnsafe<any[]>(
    `SELECT client_number, connected_number FROM whatsapp_config WHERE status = 'connected' AND connected_number IS NOT NULL`,
  ).catch(() => [] as any[]);
  const claimedByTenant = new Map<string, string>();   // clientNumber → phone
  for (const t of tenantClaims) claimedByTenant.set(t.client_number, String(t.connected_number).replace(/[^\d+]/g, ''));

  for (const r of rows) {
    // Try to read this user's paired phone from connector metadata
    const meta: any = r.metadata ?? {};
    const userPhone = String(meta.connectedNumber ?? meta.phoneNumber ?? '').replace(/[^\d+]/g, '');
    const tenantPhone = claimedByTenant.get(r.clientNumber);
    if (userPhone && tenantPhone && userPhone === tenantPhone) {
      log.info('skip user resume — tenant already owns this phone', { userId: r.userId, phone: userPhone, clientNumber: r.clientNumber });
      continue;
    }
    try { await startPairing(r.userId, r.clientNumber); }
    catch (e: any) { log.warn('resume failed', { userId: r.userId, error: e.message }); }
  }
}

/**
 * Iterate the user's recent WhatsApp chats and yield each chat together
 * with its recent message buffer. Used by the historical scribe to
 * backfill Brain memory with past WhatsApp conversations after a fresh
 * pair (without it, only messages arriving after pairing land in feed).
 *
 * Filtering rules:
 *   - Skip group chats (`chat.isGroup`) — too noisy, low signal
 *   - Skip status broadcasts and newsletters
 *   - Skip excluded contacts (read from notificationPreferences)
 *   - Only chats touched in the last `daysBack` days
 *   - Per-chat message cap (`messagesPerChat`)
 *   - Global message cap (`totalCap`) prevents runaway on heavy users
 *
 * Returns an async iterator so the caller can stream-process and
 * checkpoint progress without holding the entire history in memory.
 */
export interface WhatsAppHistoryItem {
  chatId: string;
  contactNumber: string | null;
  contactName: string | null;
  isFromMe: boolean;
  body: string;
  type: string;
  timestamp: number;
  waMessageId: string;
}

export interface WhatsAppHistoryOpts {
  /** How far back to look in days. Default 14. */
  daysBack?: number;
  /** Cap on messages per chat. Default 100. */
  messagesPerChat?: number;
  /** Global cap across all chats. Default 5000. */
  totalCap?: number;
}

export async function* iterateWhatsAppHistory(
  userId: number,
  opts: WhatsAppHistoryOpts = {},
): AsyncGenerator<WhatsAppHistoryItem> {
  const client = clients.get(userId);
  if (!client) return; // not paired

  const daysBack = opts.daysBack ?? 14;
  const messagesPerChat = opts.messagesPerChat ?? 100;
  const totalCap = opts.totalCap ?? 5000;
  const sinceMs = Date.now() - daysBack * 86_400_000;
  const excluded = await excludedFor(userId);

  let yielded = 0;

  let chats: any[] = [];
  try { chats = await client.getChats(); }
  catch (err: any) { log.warn('getChats failed during scribe', { userId, error: err.message }); return; }

  // Sort chats by last activity descending — most-recent conversations first
  // so we hit the cap on what's relevant rather than ancient noise.
  chats.sort((a: any, b: any) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

  for (const chat of chats) {
    if (yielded >= totalCap) break;

    const id = chat?.id?._serialized ?? '';
    if (!id) continue;
    if (chat.isGroup) continue;
    if (id === 'status@broadcast' || id.includes('@g.us') || id.includes('@newsletter')) continue;

    // chat.timestamp is the last-message-at; skip cold chats outside the window.
    const lastTs = (chat.timestamp ?? 0) * 1000;
    if (lastTs && lastTs < sinceMs) continue;

    // Resolve the other party's phone number for the exclusion check.
    let contactNumber: string | null = null;
    let contactName: string | null = chat.name ?? null;
    try {
      const contact = await chat.getContact();
      const num = contact?.number || contact?.id?.user;
      if (num) contactNumber = '+' + String(num).replace(/^\+/, '');
      if (!contactName) contactName = contact?.pushname || contact?.name || null;
    } catch { /* fallback to chat-id parsing below */ }
    if (!contactNumber) {
      const m = /^(\d+)@/.exec(id);
      if (m) contactNumber = '+' + m[1];
    }

    if (contactNumber && excluded.has(normalizePhone(contactNumber))) {
      log.info('whatsapp scribe: skipping excluded contact', { contactNumber });
      continue;
    }

    let messages: any[] = [];
    try { messages = await chat.fetchMessages({ limit: messagesPerChat }); }
    catch (err: any) {
      log.warn('fetchMessages failed during scribe', { chatId: id, error: err.message });
      continue;
    }

    // Iterate oldest → newest within the chat so feed_events land in time order.
    for (const m of (messages || [])) {
      if (yielded >= totalCap) break;
      const tsMs = (m.timestamp ?? 0) * 1000;
      if (tsMs && tsMs < sinceMs) continue;
      // Skip non-chat messages: notifications, system, calls. Voice notes
      // (ptt) and audio carry no transcribed body in the snapshot, so we
      // log them with a placeholder so Brain at least knows they happened.
      const body = m.body && m.body.trim()
        ? m.body
        : m.type === 'ptt' || m.type === 'audio'
          ? '[voice note]'
          : m.type === 'image' ? '[image]'
          : m.type === 'video' ? '[video]'
          : m.type === 'document' ? '[document]'
          : '';
      if (!body) continue;
      yield {
        chatId: id,
        contactNumber,
        contactName,
        isFromMe: !!m.fromMe,
        body: String(body).slice(0, 4000),
        type: m.type ?? 'chat',
        timestamp: tsMs || Date.now(),
        waMessageId: m.id?.id ?? `${id}:${tsMs}`,
      };
      yielded += 1;
    }
  }
}

/** Destroy every per-user session — called from gracefulShutdown so
 *  LocalAuth finishes writing session state before the process exits. */
export async function destroyAllUserSessions(): Promise<void> {
  const work: Promise<void>[] = [];
  for (const [uid, c] of clients) {
    work.push((async () => {
      try { await c.destroy(); } catch {
        try { const b = await c.pupBrowser; if (b) await b.close(); } catch {}
      }
      clients.delete(uid);
    })());
  }
  await Promise.race([
    Promise.all(work),
    new Promise((res) => setTimeout(res, 3000)),
  ]);
}
