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

/** Stamp lastSyncAt for the user's whatsapp_personal row so the
 *  Day Brief + Connectors page show fresh "last sync" times for an
 *  event-driven channel that has no poll cycle of its own. Called
 *  on ready, on every inbound message, and from the heartbeat tick. */
async function stampWhatsAppSync(userId: number): Promise<void> {
  try {
    const row = await getUserConnector(userId);
    if (!row) return;
    await prisma.userConnector.update({
      where: { id: row.id },
      data: { lastSyncAt: new Date() },
    });
  } catch { /* best-effort; never block the message path */ }
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
      // Detect "zombie pairing": a row that was previously paired
      // (connectedNumber set) but the underlying webjs session has died
      // and is now stuck issuing QRs for re-pair. Without this, the DB
      // keeps lying that status='connected' while the channel is broken.
      // First QR after a successful pair stamps qrLoopSinceAt; subsequent
      // QRs check if we've been looping > 2 min and flip to disconnected
      // so the broken-connector banner fires.
      const existing = await getUserConnector(userId);
      const meta: any = existing?.metadata ?? {};
      const wasPaired = !!meta.connectedNumber;
      const loopSinceAt: string | null = meta.qrLoopSinceAt ?? null;
      const loopForMs = loopSinceAt ? Date.now() - new Date(loopSinceAt).getTime() : 0;
      const looksDead = wasPaired && loopForMs > 2 * 60 * 1000;

      await writeMeta(userId, {
        status: 'qr',
        qrDataUrl,
        qrExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        qrLoopSinceAt: loopSinceAt ?? new Date().toISOString(),
        ...(looksDead ? { lastError: 'pairing died — please scan the new QR to reconnect' } : {}),
      } as any, looksDead ? 'disconnected' : undefined);

      if (looksDead) log.warn('Zombie pairing detected — flipped to disconnected', { userId });
      else log.info('QR issued', { userId });
    } catch (e: any) { log.error('QR save failed', { userId, error: e.message }); }
  });

  client.on('ready', async () => {
    const number = client.info?.wid?.user ? '+' + client.info.wid.user : null;
    await writeMeta(userId, {
      status: 'connected',
      qrDataUrl: null,
      qrExpiresAt: null,
      qrLoopSinceAt: null,
      connectedNumber: number,
      lastError: null,
      pairedAt: new Date().toISOString(),
    } as any, 'connected');
    await stampWhatsAppSync(userId);
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
      // Stamp freshness regardless of whether the message survives the
      // filters below (groups / status / empty body). Channel is alive,
      // and that's what "last sync" should reflect.
      stampWhatsAppSync(userId).catch(() => {});

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

      // ── Voice note handling ──
      // Voice notes (ptt) and audio messages used to ingest with an
      // empty body — Brain saw they arrived but had no idea what was
      // said. Now: download the audio, transcribe via voiceService
      // (Gemini → Google Speech fallback, Urdu/English/mixed), and if
      // the original wasn't English, translate to English via the LLM.
      // The body becomes a clearly-labelled formatted block so triage,
      // search, and the View thread modal all read it as text.
      const isVoice = message.type === 'ptt' || message.type === 'audio';
      let voiceTranscript: { language: string; original: string; english: string; confidence: number } | null = null;
      if (isVoice && message.hasMedia) {
        try {
          const media = await message.downloadMedia();
          if (media?.data) {
            const buffer = Buffer.from(media.data, 'base64');
            const { transcribeVoiceNote } = await import('../voiceService');
            const tx = await transcribeVoiceNote(buffer, media.mimetype);
            if (tx.text) {
              let english = '';
              const isEnglishish = (tx.language || '').toLowerCase().startsWith('en');
              if (!isEnglishish) {
                try {
                  const { callLLM } = await import('../llmRouter');
                  const r = await callLLM(
                    'Translate the input into clear, natural English. Output ONLY the English translation — no preamble, no labels, no quotes.',
                    tx.text,
                    {
                      maxTokens: 400,
                      providers: ['gemini-flash', 'gemini', 'claude'],
                      userId,
                      clientNumber,
                      purpose: 'voice_translate',
                      timeoutMs: 12_000,
                    },
                  );
                  english = r.text.trim();
                } catch (e: any) {
                  log.warn('voice translation failed', { userId, error: e.message });
                }
              }
              voiceTranscript = {
                language: tx.language || 'unknown',
                original: tx.text,
                english,
                confidence: tx.confidence || 0,
              };
            }
          }
        } catch (e: any) {
          log.warn('voice transcription failed', { userId, error: e.message });
        }
      }

      // Build the body Brain sees. For voice notes we synthesise a
      // clearly-labelled block so triage prompts read sensible text
      // instead of '[voice note]'. Fallback when transcription fails.
      const humanLang = (code: string): string => {
        const c = (code || '').toLowerCase();
        if (c.startsWith('ur')) return 'Urdu';
        if (c.startsWith('en')) return 'English';
        if (c.startsWith('hi')) return 'Hindi';
        if (c.startsWith('ar')) return 'Arabic';
        return code || 'unknown language';
      };
      const formattedBody = isVoice
        ? voiceTranscript && voiceTranscript.original
          ? [
              `🎤 Voice note in ${humanLang(voiceTranscript.language)} (auto-transcribed)`,
              ``,
              `Original: ${voiceTranscript.original}`,
              voiceTranscript.english ? `\nEnglish: ${voiceTranscript.english}` : '',
            ].filter(Boolean).join('\n')
          : `🎤 Voice note (transcription unavailable — open WhatsApp to listen)`
        : (message.body || '');

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
        body: formattedBody,
        type: message.type || 'chat',
        hasMedia: !!message.hasMedia,
        timestamp: message.timestamp ? message.timestamp * 1000 : Date.now(),
        threadContext,
        // Structured voice metadata so the triage prompts and the View
        // thread modal can render the transcript distinctly. null when
        // the message wasn't a voice note or when transcription failed.
        voiceTranscript,
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

      // ── Voice / text instruction pipeline ──
      // Two-step flow per user spec (2026-05-08): transcribe first,
      // SHOW the transcript + planned action to the user, only act
      // after they confirm. Voice transcription can mishear,
      // especially across Urdu/English code-switching, so silent
      // execution is risky. Confirmation gate prevents Brain from
      // acting on a misread.
      //
      // Flow:
      //   inbound msg →
      //     if user has a PENDING voice instruction (last 5 min):
      //       if msg is yes/ok/confirm/1 → dispatch it
      //       if msg is no/cancel/2     → cancel it
      //       else                        → cancel + treat as new instr
      //     else if msg looks like an instruction:
      //       extract intent → stage (don't dispatch) → reply with
      //       transcript + planned action + "Reply YES to confirm"
      const transcriptText = voiceTranscript?.english || voiceTranscript?.original || message.body || '';
      const cleanLower = transcriptText.trim().toLowerCase();
      const looksLikeConfirm = /^\s*(yes|ok|confirm|do it|go ahead|haan|theek hai|bilkul|1)\s*$/i.test(transcriptText.trim());
      const looksLikeCancel = /^\s*(no|cancel|stop|nahi|drop|2|3)\s*$/i.test(transcriptText.trim());

      if (result.feedEventId) {
        void (async () => {
          try {
            // 1. Look for a pending voice instruction from this chat in
            //    the last 5 min. We stage these as agent_action rows with
            //    status='pending_voice_confirmation'.
            const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
            const pending = await prisma.agentAction.findFirst({
              where: {
                clientNumber, userId,
                status: 'pending_voice_confirmation',
                createdAt: { gte: fiveMinAgo },
              } as any,
              orderBy: { createdAt: 'desc' } as any,
            });

            if (pending && (looksLikeConfirm || looksLikeCancel)) {
              if (looksLikeCancel) {
                await prisma.agentAction.update({
                  where: { id: pending.id },
                  data: { status: 'cancelled' } as any,
                });
                await sendReply(userId, rawFrom, '✗ Cancelled. Nothing happened. Send a new instruction whenever you want.');
                return;
              }
              // Confirm path: read the staged instruction back, dispatch.
              const stored: any = pending.input ?? {};
              const ix = stored.instruction;
              if (!ix) {
                await sendReply(userId, rawFrom, 'Could not read the staged instruction. Please re-record.');
                return;
              }
              const { dispatchInstruction } = await import('../instructions/instructionDispatcher');
              const out = await dispatchInstruction({ instruction: ix, clientNumber, userId });
              await prisma.agentAction.update({
                where: { id: pending.id },
                data: {
                  status: out.ok ? 'done' : 'failed',
                  output: { dispatchResult: out } as any,
                } as any,
              });
              await sendReply(userId, rawFrom, out.ok ? `✓ ${out.message}` : `✗ ${out.message}`);
              return;
            }

            // If a pending instruction exists but this message doesn't
            // look like a confirm/cancel, mark the old one as cancelled
            // so it doesn't sit forever — the user has effectively moved
            // on. Then fall through to normal extraction on the new msg.
            if (pending && !looksLikeConfirm && !looksLikeCancel) {
              await prisma.agentAction.update({
                where: { id: pending.id },
                data: { status: 'cancelled' } as any,
              }).catch(() => {});
            }

            // 2. Normal trigger heuristics for new instructions.
            const looksLikeInstruction =
              isVoice ||
              /\b(brain|nexeo)\b/i.test(transcriptText) ||
              /^\s*(mute|unmute|draft|reply to|delegate|schedule|set a meeting|set window|add to open items?|note that)\b/i.test(transcriptText);

            if (!looksLikeInstruction || transcriptText.trim().length < 8) return;

            const { extractInstruction } = await import('../instructions/instructionExtractor');
            const ix = await extractInstruction({
              text: transcriptText,
              clientNumber,
              userId,
              triggerFeedEventId: result.feedEventId,
            });
            if (ix.intent === 'none' || ix.confidence < 0.6) return;

            // Stage the action — DO NOT dispatch yet. User confirms first.
            await prisma.agentAction.create({
              data: {
                clientNumber, userId,
                actionType: 'voice_instruction',
                status: 'pending_voice_confirmation',
                requiresApproval: true,
                executedByAgent: 'voice_instruction',
                input: { instruction: ix, transcript: transcriptText, chatId: rawFrom } as any,
                output: { stagedAt: new Date().toISOString() } as any,
              } as any,
            });

            // Build the confirmation message — show the transcript
            // (what Brain heard) and the planned action so the user can
            // catch a misread before acting on it.
            const heardLine = isVoice
              ? `📝 I heard:\n"${(voiceTranscript?.original || transcriptText).slice(0, 400)}"`
              : `📝 You said:\n"${transcriptText.slice(0, 400)}"`;
            const englishLine = isVoice && voiceTranscript?.english && voiceTranscript.original !== voiceTranscript.english
              ? `\n\n(English: ${voiceTranscript.english.slice(0, 400)})`
              : '';
            const planLine = `\n\n→ ${ix.summary || 'I will act on this.'}`;
            const promptLine = `\n\nReply YES to confirm, anything else to cancel.`;

            await sendReply(userId, rawFrom, `${heardLine}${englishLine}${planLine}${promptLine}`);
          } catch (err: any) {
            log.warn('instruction pipeline failed', { userId, error: err.message });
          }
        })();
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

/** Heartbeat — stamp lastSyncAt for every user with a live webjs client.
 *  Runs every 2 min from server.ts so Day Brief reflects "channel is
 *  alive" even when no new messages have arrived. Skips disconnected
 *  clients so a dead pairing doesn't look fresh. */
/** Internal accessor used by maintenance scripts (e.g. voice transcript
 *  backfill) that need to reach the live webjs client to fetch a
 *  message by id. Returns null when no live client is paired. */
export function __getInternalClient(userId: number): any | null {
  return clients.get(userId) ?? null;
}

/**
 * Backfill transcripts for old voice-note feed_events that arrived
 * before the inline transcription path shipped. Must run IN the
 * server process — relies on the live in-memory clients Map. CLI
 * scripts spawn their own Node process and don't share memory, so
 * they always see "no live client". An HTTP endpoint calls this
 * directly inside the server.
 *
 * Optional userId narrows to one user; otherwise covers all paired.
 */
export async function backfillVoiceTranscriptsInProcess(opts?: {
  apply?: boolean;
  userId?: number;
  limit?: number;
}): Promise<{
  scanned: number;
  transcribed: number;
  skippedNoClient: number;
  skippedNotFound: number;
  errors: number;
}> {
  const apply = !!opts?.apply;
  const limit = Math.max(1, Math.min(500, opts?.limit ?? 200));

  let scanned = 0;
  let transcribed = 0;
  let skippedNoClient = 0;
  let skippedNotFound = 0;
  let errors = 0;

  const userFilter = opts?.userId ? `AND user_id = ${opts.userId}` : '';
  const rows: Array<{
    id: string; clientNumber: string; userId: number; rawPayload: any;
  }> = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, client_number AS "clientNumber", user_id AS "userId",
            raw_payload AS "rawPayload"
       FROM feed_events
      WHERE source_type = 'whatsapp'
        AND user_id IS NOT NULL
        ${userFilter}
        AND (raw_payload->>'type' IN ('ptt', 'audio'))
        AND (raw_payload->>'body' = '' OR raw_payload->>'body' IS NULL
             OR raw_payload->>'body' ILIKE '%[voice note]%'
             OR raw_payload->>'body' ILIKE '%(voice note)%')
        AND raw_payload->'voiceTranscript' IS NULL
      ORDER BY id DESC
      LIMIT ${limit}`,
  ).catch(() => [] as any[]);

  const humanLang = (code: string): string => {
    const c = (code || '').toLowerCase();
    if (c.startsWith('ur')) return 'Urdu';
    if (c.startsWith('en')) return 'English';
    if (c.startsWith('hi')) return 'Hindi';
    if (c.startsWith('ar')) return 'Arabic';
    return code || 'unknown language';
  };

  for (const row of rows) {
    scanned += 1;
    const payload = row.rawPayload ?? {};
    const waMessageId = payload.waMessageId;
    if (!waMessageId) { skippedNotFound += 1; continue; }

    const client = clients.get(row.userId);
    if (!client) { skippedNoClient += 1; continue; }

    try {
      const message = await client.getMessageById?.(waMessageId).catch(() => null);
      if (!message || !message.hasMedia) { skippedNotFound += 1; continue; }
      const media = await message.downloadMedia();
      if (!media?.data) { skippedNotFound += 1; continue; }

      const { transcribeVoiceNote } = await import('../voiceService');
      const tx = await transcribeVoiceNote(Buffer.from(media.data, 'base64'), media.mimetype);
      if (!tx.text) { skippedNotFound += 1; continue; }

      let english = '';
      if (!(tx.language || '').toLowerCase().startsWith('en')) {
        try {
          const { callLLM } = await import('../llmRouter');
          const r = await callLLM(
            'Translate the input into clear, natural English. Output ONLY the English translation — no preamble, no labels, no quotes.',
            tx.text,
            {
              maxTokens: 400,
              providers: ['gemini-flash', 'gemini', 'claude'],
              userId: row.userId,
              clientNumber: row.clientNumber,
              purpose: 'voice_translate',
              timeoutMs: 12_000,
            },
          );
          english = r.text.trim();
        } catch { /* skip translation */ }
      }

      const voiceTranscript = {
        language: tx.language || 'unknown',
        original: tx.text,
        english,
        confidence: tx.confidence || 0,
      };
      const formattedBody = [
        `🎤 Voice note in ${humanLang(voiceTranscript.language)} (auto-transcribed)`,
        ``,
        `Original: ${voiceTranscript.original}`,
        english ? `\nEnglish: ${english}` : '',
      ].filter(Boolean).join('\n');

      if (apply) {
        await prisma.feedEvent.update({
          where: { id: row.id },
          data: { rawPayload: { ...payload, body: formattedBody, voiceTranscript } as any },
        });
      }
      transcribed += 1;
      log.info('voice transcript backfilled', { id: row.id, lang: voiceTranscript.language, applied: apply });
    } catch (err: any) {
      errors += 1;
      log.warn('backfill row failed', { id: row.id, error: err.message });
    }
  }

  return { scanned, transcribed, skippedNoClient, skippedNotFound, errors };
}

export async function heartbeatAllConnected(): Promise<{ stamped: number; flippedDead: number }> {
  let stamped = 0;
  let flippedDead = 0;
  for (const [userId, client] of clients.entries()) {
    try {
      // wwebjs Client exposes getState() async; CONNECTED is the only
      // state where we can claim freshness. Cast to any — types from
      // whatsapp-web.js aren't exported through a single union here.
      const state = await client.getState?.().catch(() => null);
      if (state === 'CONNECTED') {
        await stampWhatsAppSync(userId);
        stamped += 1;
      }
    } catch { /* skip this user, don't break the loop */ }
  }

  // Silent-dead-pairing detector. The earlier zombie-detect logic only
  // catches sessions that reach the QR-issued event after death —
  // multiple successive server restarts can fail authentication BEFORE
  // QR fires, leaving the DB at status='connected' with no live client.
  // Sweep: any whatsapp_personal row whose last_sync_at is more than 15
  // minutes old AND has no entry in our in-memory clients Map → flip
  // status to 'disconnected' so the broken-connector banner fires and
  // the user is prompted to re-pair.
  try {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
    const candidates = await prisma.userConnector.findMany({
      where: {
        connectorType: { slug: 'whatsapp_personal' },
        status: 'connected',
        OR: [
          { lastSyncAt: { lt: fifteenMinAgo } },
          { lastSyncAt: null },
        ],
      } as any,
      select: { id: true, userId: true, metadata: true },
    });
    for (const c of candidates) {
      // If we still have a live in-memory client for this user, the
      // heartbeat above would have stamped — leave it alone. Only flip
      // when there's no client at all (boot-time orphan).
      if (clients.has(c.userId)) continue;
      const meta: any = c.metadata ?? {};
      await prisma.userConnector.update({
        where: { id: c.id },
        data: {
          status: 'disconnected',
          metadata: {
            ...meta,
            status: 'disconnected',
            lastError: 'No live WhatsApp client after server restart — please re-pair',
            lastErrorAt: new Date().toISOString(),
          } as any,
        },
      });
      flippedDead += 1;
      log.warn('Silent-dead pairing flipped to disconnected', { userId: c.userId });
    }
  } catch (e: any) {
    log.warn('Silent-dead sweep failed', { error: e.message });
  }

  return { stamped, flippedDead };
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
