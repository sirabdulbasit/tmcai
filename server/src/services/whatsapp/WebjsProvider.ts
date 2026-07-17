// ═════════════════════════════════════════════════════════════════════════════
// WebjsProvider — Free WhatsApp Web.js provider for development/testing
//
// Uses whatsapp-web.js (headless Chromium) to connect via QR code scan.
// Admin scans QR in admin panel → WhatsApp Web session established.
// NOT for production — use MetaProvider for production deployments.
// ═════════════════════════════════════════════════════════════════════════════

import { IWhatsAppProvider, SendMessageParams, SendResult, ConnectionStatus, TestResult } from './IWhatsAppProvider';
import { classifyWebjsSendResult } from './sendReceipt';
import { sendInboundTextReply } from './inboundReplyTransport';
import { startInboundActivity, InboundActivity } from './inboundActivity';
import { resolveRegisteredWhatsAppUser } from './inboundIdentity';
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import fs from 'fs';
import path from 'path';
import {
  classifyWebjsInitFailure,
  getWebjsInitPolicy,
  initTimeoutRetryDelayMs,
} from './webjsInitPolicy';
import {
  WebjsInitTelemetry,
  WebjsInitTelemetrySnapshot,
} from './webjsInitTelemetry';

const log = createLogger('whatsapp:webjs');

// Per-tenant state (in-memory — lost on restart, reconnects via saved session)
const clients = new Map<string, any>();           // whatsapp-web.js Client instances
const qrCodes = new Map<string, string>();        // base64 QR images
const statusMap = new Map<string, string>();       // connection status

// Reconnect coordination — prevents the "keeps disconnecting" loop:
//   - initFlight: an initialize() call is already running for this tenant
//   - reconnectTimer: a scheduled reconnect handle we can cancel
//   - reconnectAttempt: exponential-backoff counter, reset on successful ready
interface InitFlight {
  token: symbol;
  startedAt: number;
  deadlineAt: number;
}
export interface WebjsInitHealth {
  state: 'idle' | 'connecting' | 'connected' | 'init_timeout' | 'error';
  startedAt: number | null;
  deadlineAt: number | null;
  retryAt: number | null;
  consecutiveTimeouts: number;
  requiresRepair: boolean;
  lastError?: string;
  telemetry?: WebjsInitTelemetrySnapshot;
}
const initFlights = new Map<string, InitFlight>();
const initHealth = new Map<string, WebjsInitHealth>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const reconnectAttempts = new Map<string, number>();
const RECONNECT_BACKOFF_MS = [10_000, 30_000, 120_000, 300_000, 600_000]; // 10s → 30s → 2m → 5m → 10m
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

export function getWebjsInitHealth(clientNumber: string): WebjsInitHealth {
  return initHealth.get(clientNumber) ?? {
    state: 'idle', startedAt: null, deadlineAt: null, retryAt: null,
    consecutiveTimeouts: 0, requiresRepair: false,
  };
}

// Per-message dedup so the `message` and `message_create` listeners
// don't both invoke handleInboundMessage for the same inbound. Without
// this, replies like "Friday" produce TWO replies — one from the date
// parser (correct), one from the chat router (wrong, "Happy Friday").
// Returns true if msgId was ALREADY seen (caller should skip).
const seenMessageIds = new Map<string, number>();
const SEEN_TTL_MS = 60 * 1000;
function markSeen(msgId: string): boolean {
  const now = Date.now();
  // Clean entries older than TTL
  if (seenMessageIds.size > 200) {
    for (const [k, t] of seenMessageIds) {
      if (now - t > SEEN_TTL_MS) seenMessageIds.delete(k);
    }
  }
  if (seenMessageIds.has(msgId)) return true;
  seenMessageIds.set(msgId, now);
  return false;
}

/**
 * Remove stale Chromium SingletonLock files from a LocalAuth session
 * folder when the PID inside them is no longer alive.
 *
 * Why this exists: when the prior server process gets SIGKILL'd (nodemon
 * crash, OOM, OS reboot), Chrome doesn't get a chance to clean up its
 * SingletonLock / SingletonCookie / SingletonSocket files. The next
 * process tries to launch Chromium against the same user-data dir,
 * Chromium sees the lock, refuses to start, and the WhatsApp client
 * never reaches `ready`. The user then has to manually re-pair via QR.
 *
 * Safety: SingletonLock contains "<hostname>-<pid>". We only remove
 * when the PID is dead (process.kill(pid, 0) throws ESRCH). If the PID
 * is alive — meaning a different running server process owns the
 * session — we leave it alone and let the new client fail loudly.
 */
function cleanStaleSingletonLocks(sessionDir: string): boolean {
  if (!fs.existsSync(sessionDir)) return false;
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  let cleaned = false;
  for (const name of lockFiles) {
    const p = path.join(sessionDir, name);
    let stale = false;
    try {
      // SingletonLock is a symlink whose link target is "host-pid".
      const target = fs.readlinkSync(p);
      const m = /-(\d+)$/.exec(target);
      const pid = m ? Number(m[1]) : NaN;
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, 0); /* alive */ }
        catch (err: any) { if (err.code === 'ESRCH') stale = true; }
      } else {
        // Not a parseable lock — treat as stale.
        stale = true;
      }
    } catch (err: any) {
      // Not a symlink (or doesn't exist) — try a plain file unlink. If
      // it doesn't exist that's fine; if it exists as a regular file
      // it was left over from an older Chromium version, also stale.
      if (err.code === 'ENOENT') continue;
      stale = true;
    }
    if (stale) {
      try { fs.unlinkSync(p); cleaned = true; log.warn('removed stale chromium lock', { file: p }); }
      catch { /* ignore — fail loudly when initialize tries to launch */ }
    }
  }
  return cleaned;
}

async function disposeWebjsClient(client: any, timeoutMs: number = 5_000): Promise<void> {
  let destroyCompleted = false;
  const wait = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
  await Promise.race([
    Promise.resolve().then(() => client.destroy()).then(() => { destroyCompleted = true; }).catch(() => undefined),
    wait(timeoutMs),
  ]);
  if (destroyCompleted) return;
  // destroy() itself can hang on a wedged DevTools protocol. Fall through to
  // the underlying browser with its own bound so shutdown/recovery continues.
  try {
    const browser = await Promise.race([
      Promise.resolve(client.pupBrowser),
      wait(1_000).then(() => null),
    ]);
    if (browser) {
      await Promise.race([
        Promise.resolve(browser.close()).catch(() => undefined),
        wait(2_000),
      ]);
    }
  } catch { /* the OS/session cleanup path handles any already-dead browser */ }
}

/** Destroy every tenant client cleanly — called by gracefulShutdown on
 *  SIGTERM so LocalAuth's disk writes don't get truncated on nodemon/deploy. */
export async function destroyAllClients(): Promise<void> {
  for (const [cn, timer] of reconnectTimers) { clearTimeout(timer); reconnectTimers.delete(cn); }
  const work: Promise<void>[] = [];
  for (const [cn, c] of clients) {
    work.push((async () => {
      await disposeWebjsClient(c);
      clients.delete(cn); statusMap.delete(cn); qrCodes.delete(cn);
      initFlights.delete(cn); initHealth.delete(cn);
    })());
  }
  // Give each client up to 3s to finish destroy() so disk writes flush.
  await Promise.race([
    Promise.all(work),
    new Promise((res) => setTimeout(res, 3000)),
  ]);
}

export class WebjsProvider implements IWhatsAppProvider {

  async initialize(clientNumber: string): Promise<void> {
    // Idempotency — refuse to start a second init for the same tenant.
    // Previously every reconnect attempt could race a boot-time
    // initializeAllTenants call, spawning two Chromiums that fought
    // over the same WhatsApp account and kicked each other out.
    const policy = getWebjsInitPolicy();
    const now = Date.now();
    const activeFlight = initFlights.get(clientNumber);
    if (activeFlight && now < activeFlight.deadlineAt) {
      log.info('initialize skipped — already in flight', {
        clientNumber, startedAt: activeFlight.startedAt, deadlineAt: activeFlight.deadlineAt,
      });
      return;
    }
    const previousHealth = getWebjsInitHealth(clientNumber);
    if (previousHealth.requiresRepair) {
      log.warn('initialize withheld — session requires re-pair', {
        clientNumber, consecutiveTimeouts: previousHealth.consecutiveTimeouts,
      });
      return;
    }
    const current = statusMap.get(clientNumber);
    if (current === 'connected' && clients.has(clientNumber)) {
      log.info('initialize skipped — already connected/connecting', { clientNumber, current });
      return;
    }
    if (current === 'connecting' && activeFlight && now < activeFlight.deadlineAt) return;

    const token = Symbol(clientNumber);
    const telemetry = new WebjsInitTelemetry(now);
    const flight: InitFlight = {
      token,
      startedAt: now,
      deadlineAt: now + policy.initDeadlineMs,
    };
    // Claim the per-tenant initialization slot before any await. A concurrent
    // watchdog/admin/startup call will now see this flight and stand down.
    initFlights.set(clientNumber, flight);
    initHealth.set(clientNumber, {
      state: 'connecting', startedAt: flight.startedAt, deadlineAt: flight.deadlineAt,
      retryAt: null, consecutiveTimeouts: previousHealth.consecutiveTimeouts,
      requiresRepair: false, telemetry: telemetry.snapshot(),
    });

    const syncTelemetry = () => {
      if (initFlights.get(clientNumber)?.token !== token) return;
      const currentHealth = initHealth.get(clientNumber);
      if (!currentHealth) return;
      initHealth.set(clientNumber, { ...currentHealth, telemetry: telemetry.snapshot() });
    };

    if (activeFlight) {
      log.warn('initialization deadline expired — replacing wedged client', {
        clientNumber, previousStartedAt: activeFlight.startedAt,
        previousDeadlineAt: activeFlight.deadlineAt,
      });
    }

    // Cancel any pending reconnect timer — we're (re)initializing NOW.
    const pending = reconnectTimers.get(clientNumber);
    if (pending) { clearTimeout(pending); reconnectTimers.delete(clientNumber); }

    // Clean up any stale client before reinitializing
    if (clients.has(clientNumber)) {
      const oldClient = clients.get(clientNumber);
      // Remove ownership before destroy: its delayed disconnected/error events
      // must not overwrite or schedule reconnects for the replacement client.
      clients.delete(clientNumber);
      await disposeWebjsClient(oldClient);
      statusMap.delete(clientNumber);
      qrCodes.delete(clientNumber);
    }

    // Dynamic import — whatsapp-web.js is optional dependency (not in devDependencies)
    let Client: any, LocalAuth: any, QRCode: any;
    try {
      // @ts-ignore — optional dependency, may not be installed
      const wwebjs = await import('whatsapp-web.js' as string);
      Client = wwebjs.Client || wwebjs.default?.Client;
      LocalAuth = wwebjs.LocalAuth || wwebjs.default?.LocalAuth;
      // @ts-ignore
      QRCode = await import('qrcode' as string);
    } catch {
      log.error('whatsapp-web.js or qrcode not installed. Run: npm install whatsapp-web.js qrcode');
      throw new Error('WhatsApp Web.js dependencies not installed');
    }

    const sessionPath = process.env.WHATSAPP_SESSION_PATH || './whatsapp-sessions';

    // E2: validate the key (path-safe), lock the dirs to 0700, and refuse
    // to initialize on a dir owned by another uid — session state carries
    // live WhatsApp auth tokens.
    const { tenantSessionKey, hardenSessionDir } = await import('./waSessionKey');
    const sessionKey = tenantSessionKey(clientNumber);
    hardenSessionDir(sessionPath);

    // Restart resilience: if the previous process got SIGKILL'd (crash,
    // nodemon SIGTERM grace exceeded, OOM, host reboot), Chromium left
    // SingletonLock files behind in the LocalAuth folder pointing at a
    // dead PID. Without this cleanup, Chromium refuses to launch against
    // that user-data dir and the WhatsApp client never reaches `ready`,
    // forcing the admin to re-scan QR after every hard restart.
    const sessionDir = path.join(sessionPath, `session-${sessionKey}`);
    hardenSessionDir(sessionDir);
    cleanStaleSingletonLocks(sessionDir);

    // Find Chrome/Chromium executable on the system. Honour both names:
    //   - PUPPETEER_EXECUTABLE_PATH (puppeteer's official convention)
    //   - CHROME_PATH (older internal name, kept for back-compat)
    // Linux fallback is google-chrome-stable since /usr/bin/chromium-browser
    // on Ubuntu 24.04 is a snap shim that won't launch from headless node.
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
      || process.env.CHROME_PATH
      || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
        : '/usr/bin/google-chrome-stable');

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionKey, dataPath: sessionPath }),
      restartOnAuthFail: true,
      puppeteer: {
        headless: true,
        executablePath,
        protocolTimeout: policy.protocolTimeoutMs,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
               '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
               '--disable-gpu'],
      },
    });
    telemetry.mark('client_created');
    syncTelemetry();
    // Observe the library's own version lookup instead of issuing an extra
    // DevTools evaluate while bootstrap may already be wedged. This records
    // the actual loaded version when whatsapp-web.js can obtain it and adds no
    // competing Runtime.callFunctionOn traffic.
    if (typeof client.getWWebVersion === 'function') {
      const getWwebVersion = client.getWWebVersion.bind(client);
      client.getWWebVersion = async (...args: any[]) => {
        const version = await getWwebVersion(...args);
        telemetry.setWwebVersion(version);
        syncTelemetry();
        return version;
      };
    }

    // Bounded, content-free bootstrap diagnostics. whatsapp-web.js can stall
    // inside initialize() before emitting QR/ready; the library's exception
    // alone does not identify whether Chromium, navigation, or WA injection
    // was the last successful stage. Browser text is reduced immediately to
    // fixed fingerprints by WebjsInitTelemetry and is never retained raw.
    let observedPage: any = null;
    let browserObserved = false;
    let consoleHandler: ((entry: any) => void) | null = null;
    let pageErrorHandler: ((error: any) => void) | null = null;
    const detachPageTelemetry = () => {
      if (!observedPage) return;
      try {
        if (consoleHandler) observedPage.off?.('console', consoleHandler);
        if (pageErrorHandler) observedPage.off?.('pageerror', pageErrorHandler);
      } catch { /* page may already be closed */ }
      observedPage = null;
      consoleHandler = null;
      pageErrorHandler = null;
    };
    const observeBootstrap = () => {
      if (initFlights.get(clientNumber)?.token !== token) return;
      if (client.pupBrowser && !browserObserved) {
        browserObserved = true;
        telemetry.mark('browser_started');
      }
      const page = client.pupPage;
      if (!page) {
        syncTelemetry();
        return;
      }
      if (page !== observedPage) {
        detachPageTelemetry();
        observedPage = page;
        telemetry.mark('page_created');
        consoleHandler = (entry: any) => {
          try {
            if (entry?.type?.() !== 'error') return;
            telemetry.recordBrowserError('console', entry.text?.(), entry.location?.()?.url);
            syncTelemetry();
          } catch { /* diagnostics must never affect initialization */ }
        };
        pageErrorHandler = (error: any) => {
          telemetry.recordBrowserError('pageerror', error);
          syncTelemetry();
        };
        try {
          page.on?.('console', consoleHandler);
          page.on?.('pageerror', pageErrorHandler);
        } catch { /* diagnostics must never affect initialization */ }
      }
      try { telemetry.setPageUrl(page.url?.()); } catch { /* closed/navigating page */ }
      syncTelemetry();
    };

    statusMap.set(clientNumber, 'connecting');
    clients.set(clientNumber, client);
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_config
          SET status = 'connecting', last_error = NULL
        WHERE client_number = $1`,
      clientNumber,
    ).catch((error: any) => {
      log.warn('failed to persist connecting state', { clientNumber, error: error?.message });
    });

    client.on('qr', async (qr: string) => {
      if (clients.get(clientNumber) !== client) return;
      telemetry.mark('qr_emitted');
      syncTelemetry();
      try {
        const qrImage = await QRCode.toDataURL(qr);
        qrCodes.set(clientNumber, qrImage);
        await prisma.$executeRawUnsafe(
          `UPDATE whatsapp_config SET qr_code = $1, qr_expires_at = $2, status = 'connecting' WHERE client_number = $3`,
          qrImage, new Date(Date.now() + 60_000), clientNumber,
        );
      } catch (e: any) { log.error('QR save failed', { error: e.message }); }
    });
    telemetry.mark('provider_qr_listener_registered');
    syncTelemetry();

    client.on('loading_screen', (percent: number) => {
      if (clients.get(clientNumber) !== client) return;
      telemetry.setLoadingPercent(percent);
      syncTelemetry();
    });

    client.on('authenticated', () => {
      if (clients.get(clientNumber) !== client) return;
      telemetry.mark('authenticated');
      syncTelemetry();
      observeBootstrap();
    });

    client.on('ready', async () => {
      if (clients.get(clientNumber) !== client) return;
      telemetry.mark('ready');
      syncTelemetry();
      statusMap.set(clientNumber, 'connected');
      qrCodes.delete(clientNumber);
      reconnectAttempts.delete(clientNumber);  // reset backoff counter on a clean connection
      initHealth.set(clientNumber, {
        state: 'connected', startedAt: null, deadlineAt: null, retryAt: null,
        consecutiveTimeouts: 0, requiresRepair: false, telemetry: telemetry.snapshot(),
      });
      const number = '+' + client.info.wid.user;
      await prisma.$executeRawUnsafe(
        `UPDATE whatsapp_config SET status = 'connected', connected_number = $1, connected_at = NOW(), qr_code = NULL, qr_expires_at = NULL, last_error = NULL WHERE client_number = $2`,
        number, clientNumber,
      );
      log.info('Connected', { clientNumber, number });
    });

    const handleInboundEvent = async (message: any) => {
      if (message.fromMe) return;

      const rawFrom = message.from || '';

      // Skip non-chat messages: status broadcasts, groups, newsletters
      if (rawFrom === 'status@broadcast' || rawFrom.includes('@g.us') || rawFrom.includes('@newsletter')) {
        return;
      }

      // Skip empty messages — BUT allow voice/audio messages (they have no body)
      const isVoice = message.type === 'ptt' || message.type === 'audio';
      if (!isVoice && (!message.body || !message.body.trim())) return;

      // Type whitelist — mirror UserWebjsProvider. Non-message events
      // (e2e_notification, ciphertext, call_log, gp2, etc.) carry the
      // chatId in `body` and leak past the empty-body guard. Drop them
      // at ingest. See UserWebjsProvider for the full reasoning.
      const messageTypeStr = String(message.type ?? 'chat').toLowerCase();
      const REAL_MESSAGE_TYPES = new Set([
        'chat', 'ptt', 'audio', 'image', 'video', 'document',
        'sticker', 'location', 'vcard', 'multi_vcard', 'list',
        'list_response', 'buttons_response', 'order', 'payment',
        'product', 'revoked',
      ]);
      if (!REAL_MESSAGE_TYPES.has(messageTypeStr)) {
        log.info('Skipped non-message event type', { type: messageTypeStr, from: rawFrom });
        return;
      }

      const msgId = message.id?._serialized ?? message.id?.id ?? `${rawFrom}:${message.timestamp}:${message.body?.slice(0, 16)}`;
      if (markSeen(msgId)) {
        log.info('Raw message event — duplicate, skipping', { msgId });
        return;
      }

      log.info('Raw message event', { from: rawFrom, body: (message.body || '').slice(0, 50), type: message.type, hasMedia: message.hasMedia });

      // Declared outside the try so the catch can gate the error reply on
      // _resolvedUserId (set by handleInboundMessage after registration).
      let inboundParams: import('./WhatsAppInbound').InboundParams | null = null;
      let activity: InboundActivity | null = null;
      try {
        // Extract real phone number — handle both @c.us and @lid formats
        let fromNumber = '';
        // synthLidPhone tracks the @lid-derived synthetic phone (if the
        // message came from an @lid chat). If getContact resolves a real
        // phone AND synthLidPhone is different, we auto-insert the
        // synthetic as a connection alias so future messages from the
        // same @lid chat match instantly — even if getContact later
        // fails (which happens after any webjs library disruption).
        // This is the AUTO-HEAL LAYER per Basit 2026-07-06 request.
        let synthLidPhone: string | null = null;

        if (rawFrom.includes('@c.us')) {
          // Standard format: 923226288256@c.us → +923226288256
          fromNumber = '+' + rawFrom.replace('@c.us', '');
        } else if (rawFrom.includes('@lid')) {
          // LID format: doesn't contain phone number directly. Compute
          // the synthetic AND try to resolve the real phone from contact.
          synthLidPhone = '+' + rawFrom.replace('@lid', '');
          try {
            const contact = await message.getContact();
            const contactNumber = contact?.number || contact?.id?.user || '';
            if (contactNumber && !contactNumber.includes('@')) {
              fromNumber = '+' + contactNumber;
            } else {
              // Fallback: use synthetic as identity
              fromNumber = synthLidPhone;
            }
          } catch {
            fromNumber = synthLidPhone;
          }
        } else {
          fromNumber = '+' + rawFrom.replace(/@.*$/, '');
        }

        // ── AUTO-HEAL @lid alias mapping ─────────────────────────
        // When getContact resolved a REAL phone AND it differs from the
        // @lid synthetic, ensure a connection row exists for the
        // synthetic pointing to the same user_id. Future messages from
        // the same @lid chat then match directly via the phone-variants
        // lookup in WhatsAppInbound, no getContact required. This is
        // the fix for the recurring "@lid broke Brain replies" bug
        // (project_wa_lid_lookup_bug memory + subsequent regressions).
        if (synthLidPhone && fromNumber !== synthLidPhone) {
          void (async () => {
            try {
              // Check if the real phone maps to a registered user in this tenant.
              const rows = await prisma.$queryRawUnsafe<any[]>(
                `SELECT wc.user_id FROM whatsapp_connections wc
                   JOIN users u ON u.id = wc.user_id
                  WHERE u.client_number = $1
                    AND wc.status = 'active'
                    AND u.is_active = TRUE
                    AND wc.phone_number = $2
                  LIMIT 1`,
                clientNumber, fromNumber,
              );
              const userId = rows[0]?.user_id;
              if (!userId) return; // real phone not registered — nothing to alias
              // Check if the synthetic alias already exists for this user.
              const existingAlias = await prisma.$queryRawUnsafe<any[]>(
                `SELECT id FROM whatsapp_connections
                  WHERE user_id = $1 AND phone_number = $2 LIMIT 1`,
                userId, synthLidPhone,
              );
              if (existingAlias.length) return; // alias already learned
              // Insert the @lid synthetic as a new alias row for this user.
              await prisma.$executeRawUnsafe(
                `INSERT INTO whatsapp_connections
                   (user_id, phone_number, status, provider, client_number, display_name)
                 VALUES ($1, $2, 'active', 'webjs', $3, $4)
                 ON CONFLICT DO NOTHING`,
                userId, synthLidPhone, clientNumber,
                `auto-learned LID alias (${synthLidPhone.slice(-6)})`,
              );
              log.info('AUTO-HEAL @lid alias learned', {
                userId, realPhone: fromNumber, synthLidPhone, clientNumber,
              });
            } catch (e: any) {
              log.warn('AUTO-HEAL @lid alias insert failed (non-blocking)', { error: e.message });
            }
          })();
        }

        log.info('Message received', { rawFrom, resolvedNumber: fromNumber, synthLidPhone });

        // Show processing feedback only to registered users. Expected external
        // delegatee replies are captured silently and unknown senders remain
        // fully ignored by policy.
        let resolvedIdentity = await resolveRegisteredWhatsAppUser(clientNumber, fromNumber)
          .catch((e: any) => {
            log.warn('Inbound identity preflight failed', { clientNumber, error: e?.message });
            return undefined;
          });
        if (resolvedIdentity) {
          activity = await startInboundActivity(message, isVoice, {
            clientNumber, userId: resolvedIdentity.userId, messageId: msgId,
          });
        }

        // Handle voice messages — transcribe audio to text
        let messageBody = message.body || '';
        let messageType: 'text' | 'voice' | 'image' = 'text';
        let inputWasVoice = false;

        if (isVoice && message.hasMedia) {
          messageType = 'voice';
          inputWasVoice = true;
          let voiceFailureReason: import('../voiceService').VoiceTranscriptionFailure | undefined;
          try {
            const { downloadInboundMedia } = await import('./inboundMedia');
            const media = await downloadInboundMedia(message, { clientNumber, messageId: msgId });
            if (media?.data) {
              const audioBuffer = Buffer.from(media.data, 'base64');
              const { transcribeVoiceNote } = await import('../voiceService');
              // A5 (2026-07-08, supersedes "always transcribe voice note
              // into english"): transcribe in the SPOKEN language so
              // instructions embedded in the voice note reach the brain
              // unmangled. replyLanguage='english' still guarantees the
              // REPLY is English via the persona language pin
              // (brainPersonaService). Input is translated only on
              // explicit opt-in (brain_channel.translateVoiceInput).
              let translateTo: 'english' | null = null;
              try {
                const rows = resolvedIdentity
                  ? await prisma.$queryRawUnsafe<any[]>(
                    `SELECT notification_preferences AS prefs
                       FROM users
                      WHERE id = $1 AND client_number = $2 AND is_active = TRUE
                      LIMIT 1`,
                    resolvedIdentity.userId, clientNumber,
                  )
                  : [];
                const { resolveInputTranslation } = await import('../voiceInputTranslation');
                translateTo = resolveInputTranslation(rows[0]?.prefs ?? {});
              } catch { /* preference lookup is best-effort */ }
              const transcription = await transcribeVoiceNote(audioBuffer, media.mimetype, { translateTo, clientNumber });
              messageBody = transcription.text;
              voiceFailureReason = transcription.failureReason;
              log.info('Voice transcription completed', {
                provider: transcription.provider, outcome: messageBody ? 'success' : voiceFailureReason,
                textLen: messageBody.length, lang: transcription.language,
                translated: translateTo === 'english', bytes: audioBuffer.length,
                mimeType: (media.mimetype || '').split(';')[0],
              });
            } else {
              voiceFailureReason = 'invalid_media';
            }
          } catch (e: any) {
            log.error('Voice pipeline failed', {
              stage: 'media_or_transcription',
              error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
            });
            voiceFailureReason = 'invalid_media';
            messageBody = '';
          }
          if (!messageBody) {
            // Retry only when the preflight errored (undefined). A confirmed
            // unregistered sender (null) must remain silent by policy.
            if (resolvedIdentity === undefined) {
              resolvedIdentity = await resolveRegisteredWhatsAppUser(clientNumber, fromNumber).catch(() => undefined);
            }
            if (resolvedIdentity) {
              const { voiceTranscriptionFailureMarker } = await import('../voiceService');
              await sendInboundTextReply(message, voiceTranscriptionFailureMarker(voiceFailureReason));
            }
            await activity?.stop();
            return;
          }
          // Transcription echo (Basit 2026-07-13): show the user what was
          // heard BEFORE acting, so a misread is caught immediately
          // ("first it should transcribe my voice note so i can know what
          // actually was conceived from my message"). This is a factual
          // receipt of the user's OWN words, clearly labelled — not a
          // Brain reply — so it's exempt from the LLM-only reply rule.
          // Best-effort: never block processing if the echo send fails.
          try {
            await sendInboundTextReply(message, `🎙️ Heard: "${messageBody}"`);
          } catch (e: any) {
            log.warn('transcription echo failed (non-blocking)', { error: e?.message });
          }
        }

        const { handleInboundMessage } = await import('./WhatsAppInbound');
        // Hoisted so the catch below can read _resolvedUserId — the error
        // reply must only go to REGISTERED senders (A7); unregistered
        // traffic stays silently dropped by policy.
        inboundParams = {
          clientNumber,
          fromNumber,
          messageBody,
          messageType,
          waMessageId: msgId,
          timestamp: message.timestamp ? Number(message.timestamp) * 1000 : Date.now(),
          _resolvedUserId: resolvedIdentity?.userId,
          _resolvedIdentity: resolvedIdentity,
          replyFn: async (text: string) => {
            // If input was voice, reply with voice note too
            if (inputWasVoice) {
              try {
                const chat = await message.getChat();
                const { textToVoiceNote } = await import('../voiceService');
                const audioBuffer = await textToVoiceNote(text);
                if (audioBuffer) {
                  // Send voice note
                  const { MessageMedia } = await import('whatsapp-web.js' as string);
                  const media = new MessageMedia('audio/ogg; codecs=opus', audioBuffer.toString('base64'));
                  await chat.sendMessage(media, { sendAudioAsVoice: true });
                  // Also send text version (for readability)
                  return await sendInboundTextReply(message, text);
                }
              } catch (e: any) {
                log.error('Voice reply failed, sending text only', { error: e.message });
              }
            }
            return await sendInboundTextReply(message, text);
          },
          typingFn: async () => {
            await activity?.pulse();
          },
        };
        await handleInboundMessage(inboundParams);

        await activity?.stop();
      } catch (e: any) {
        // A7: tell the user something went wrong (bracketed system
        // marker, registered senders only) BEFORE clearing the ⏳ —
        // an unacknowledged instruction reads as a disobeyed one.
        const { maybeNotifyInboundError } = await import('./inboundErrorNotify');
        await maybeNotifyInboundError(message, inboundParams?._resolvedUserId);
        await activity?.stop();
        log.error('Inbound handler error', { error: e.message });
      }
    };

    client.on('message', handleInboundEvent);

    // Older whatsapp-web.js fires `message`; newer fires `message_create`.
    // Some versions fire BOTH for the same inbound. Without a dedup
    // gate that produced the "Friday" double-reply: the date parser
    // answered, then the chat router replied "Happy Friday" because
    // the second handler invocation found the awaiting prompt already
    // answered and fell through to chat. Dedup at the message-id level
    // so each inbound is processed exactly once.
    client.on('message_create', handleInboundEvent);

    // ─── Incoming call auto-reject ────────────────────────────────────
    // Policy (Basit, 2026-06-10): "only brain will call user, where user
    // will not call to brain, if user calls, that will not be entertained".
    // whatsapp-web.js emits a 'call' event when someone tries to call the
    // tenant number. We:
    //   1. Reject the call immediately so the caller hears the cancel tone
    //      instead of a stuck ring
    //   2. Log to PM2 only — NEVER write a "missed call" record the user
    //      might later mistake for an alert
    //   3. Send a one-time courtesy text via the inbound chat ("calls
    //      aren't supported, please message me") — throttled per-from-
    //      number to 1h so repeated call attempts don't spam the chat
    //   4. The courtesy text body is composed via the Brain composer
    //      (NOT a hardcoded string) per the no-hardcoded-fake-Brain rule
    client.on('call', async (call: any) => {
      const fromRaw = call?.from ?? '';
      try {
        // Always reject first — never let the call hang waiting.
        if (typeof call?.reject === 'function') {
          await call.reject().catch(() => {});
        }
        log.info('inbound WA call auto-rejected', {
          clientNumber, from: fromRaw, isVideo: !!call?.isVideo,
        });

        // Resolve the from-number to a phone for chat-send fallback.
        const fromPhone = fromRaw.includes('@c.us')
          ? '+' + fromRaw.replace('@c.us', '')
          : fromRaw.includes('@lid')
            ? '+' + fromRaw.replace('@lid', '')
            : '+' + fromRaw.replace(/@.*$/, '');

        // 1h throttle so a repeated caller doesn't get spammed with the
        // same courtesy text. Per-from-number Redis key.
        const throttleKey = `wa_call_courtesy:${clientNumber}:${fromPhone}`;
        try {
          const { getRedis } = await import('../../utils/redisClient');
          const redis = getRedis();
          if (redis) {
            const recent = await redis.get(throttleKey);
            if (recent) {
              log.info('inbound call courtesy text throttled (sent <1h ago)', { from: fromPhone });
              return;
            }
            await redis.set(throttleKey, '1', 'EX', 60 * 60);
          }
        } catch { /* if Redis is down, send anyway — single text is fine */ }

        // Confirm the caller is a registered user before sending courtesy
        // text — per the unregistered-drop rule, randoms shouldn't even
        // get a courtesy reply (it confirms automation to scrapers).
        const tenantOk = await prisma.$queryRawUnsafe<any[]>(
          `SELECT 1 FROM whatsapp_connections wc
             JOIN users u ON u.id = wc.user_id
            WHERE u.client_number = $1
              AND wc.status = 'active'
              AND u.is_active = TRUE
              AND wc.phone_number = $2
            LIMIT 1`,
          clientNumber, fromPhone,
        ).catch(() => [] as any[]);
        if (!tenantOk.length) {
          log.info('inbound call from unregistered number — no courtesy text', {
            from: fromPhone, clientNumber,
          });
          return;
        }

        // LLM-composed courtesy via the same Brain primitive used for
        // regular replies. Not a hardcoded English string — per the
        // no-hardcoded-fake-Brain rule the courtesy body must come from
        // Brain itself with the call-decline context in the prompt.
        try {
          const { sendTenantWhatsAppText } = await import('../notifications/tenantWhatsappSender');
          const { answerAsBrain } = await import('../../routes/brainAskRoutes');
          // Look up the registered user id for this caller so Brain
          // can match language preference and gender.
          const userRow = await prisma.$queryRawUnsafe<any[]>(
            `SELECT wc.user_id FROM whatsapp_connections wc
              WHERE wc.phone_number = $1 AND wc.status = 'active'
              LIMIT 1`,
            fromPhone,
          ).catch(() => [] as any[]);
          const userId = userRow[0]?.user_id ?? null;
          let body = '';
          if (userId) {
            const r = await answerAsBrain(
              clientNumber, userId,
              '[system: user just tried to voice-call you. Calls are not supported on this channel. Compose a short, warm 1-sentence reply asking them to message you instead — match the language they normally use (English or Urdu/Roman-Urdu).]',
              [], { channel: 'whatsapp' },
            );
            body = (r.answer || '').trim();
          }
          // Bracketed system fallback if Brain composer fails — honest,
          // not pretending to be Brain.
          if (!body) body = `[calls aren't supported — please message me instead]`;
          await sendTenantWhatsAppText(clientNumber, fromPhone, body, userId ?? 0);
        } catch (e: any) {
          log.warn('inbound call courtesy text send failed', {
            from: fromPhone, error: e.message,
          });
        }
      } catch (e: any) {
        log.warn('inbound call handler error', { error: e.message });
      }
    });

    client.on('disconnected', async (reason: string) => {
      if (clients.get(clientNumber) !== client) {
        log.info('ignored disconnected event from superseded client', { clientNumber, reason });
        return;
      }
      statusMap.set(clientNumber, 'disconnected');
      clients.delete(clientNumber);
      await prisma.$executeRawUnsafe(
        `UPDATE whatsapp_config SET status = 'disconnected', last_error = $2, last_error_at = NOW() WHERE client_number = $1`,
        clientNumber, `disconnected: ${reason}`,
      );
      log.info('Disconnected', { clientNumber, reason });

      // Don't try to reconnect on explicit LOGOUT or when a CONFLICT has
      // already fired — WA is telling us another session took over, and
      // reconnecting would just kick them out and cause another conflict.
      // Surface to the UI instead so the MD can decide.
      const NO_RECONNECT = ['LOGOUT', 'CONFLICT', 'UNPAIRED', 'UNLAUNCHED'];
      if (NO_RECONNECT.includes(String(reason).toUpperCase())) {
        log.info('Not reconnecting — user action required', { clientNumber, reason });
        reconnectAttempts.delete(clientNumber);
        // Hard fail — the user explicitly logged out from their phone,
        // another session took over, or the device was unpaired.
        // Notify admins by email so they don't find out via "Brain went
        // silent" complaints from users.
        try {
          const { alertWhatsAppDisconnect } = await import('./connectionWatchdog');
          await alertWhatsAppDisconnect({
            clientNumber,
            tenantPhone: '(check Admin → WhatsApp)',
            reason: `WhatsApp closed the session: ${reason}`,
            requiresAction: 'Open Admin → WhatsApp and click Connect to scan a fresh QR code with the tenant phone.',
          });
        } catch (err: any) {
          log.error('disconnect alert send failed', { clientNumber, error: err.message });
        }
        return;
      }

      // Exponential backoff with circuit breaker. Previously a fixed
      // 10s retry looped endlessly when WA kept rejecting — looked like
      // "keeps disconnecting" to the user. Now: 10s → 30s → 2m → 5m →
      // 10m, then stop and require manual reconnect.
      const attempt = reconnectAttempts.get(clientNumber) ?? 0;
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        log.warn('Reconnect circuit breaker open — stopping', { clientNumber, attempts: attempt });
        await prisma.$executeRawUnsafe(
          `UPDATE whatsapp_config SET last_error = $2, last_error_at = NOW() WHERE client_number = $1`,
          clientNumber, `auto-reconnect gave up after ${attempt} attempts — scan QR to recover`,
        );
        reconnectAttempts.delete(clientNumber);
        // Five auto-retries already burned. Time to email admins —
        // every retry already failed, so transient issues are ruled out.
        try {
          const { alertWhatsAppDisconnect } = await import('./connectionWatchdog');
          await alertWhatsAppDisconnect({
            clientNumber,
            tenantPhone: '(check Admin → WhatsApp)',
            reason: `auto-reconnect circuit breaker after ${attempt} attempts (last reason: ${reason})`,
            requiresAction: 'Open Admin → WhatsApp and click Connect to scan a fresh QR code.',
            attemptCount: attempt,
          });
        } catch (err: any) {
          log.error('disconnect alert send failed', { clientNumber, error: err.message });
        }
        return;
      }
      const delay = RECONNECT_BACKOFF_MS[attempt];
      reconnectAttempts.set(clientNumber, attempt + 1);
      log.info('Scheduling reconnect', { clientNumber, attempt: attempt + 1, delayMs: delay });
      const existing = reconnectTimers.get(clientNumber);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(async () => {
        reconnectTimers.delete(clientNumber);
        try {
          const self = new WebjsProvider();
          await self.initialize(clientNumber);
        } catch (e: any) {
          log.error('Auto-reconnect failed', { clientNumber, attempt: attempt + 1, error: e.message });
        }
      }, delay);
      timer.unref();
      reconnectTimers.set(clientNumber, timer);
    });

    client.on('auth_failure', async (msg: string) => {
      if (clients.get(clientNumber) !== client) return;
      statusMap.set(clientNumber, 'error');
      initHealth.set(clientNumber, {
        state: 'error', startedAt: null, deadlineAt: null, retryAt: null,
        consecutiveTimeouts: 0, requiresRepair: true, lastError: msg,
        telemetry: telemetry.snapshot(),
      });
      await prisma.$executeRawUnsafe(
        `UPDATE whatsapp_config SET status = 'error', last_error = $1, last_error_at = NOW() WHERE client_number = $2`,
        msg, clientNumber,
      );
    });

    let deadlineTimer: NodeJS.Timeout | null = null;
    observeBootstrap();
    const telemetryTimer = setInterval(observeBootstrap, 1_000);
    telemetryTimer.unref();
    try {
      await Promise.race([
        client.initialize(),
        new Promise<never>((_, reject) => {
          const remaining = Math.max(1, flight.deadlineAt - Date.now());
          deadlineTimer = setTimeout(() => {
            reject(new Error(`WhatsApp initialization protocol timeout after ${policy.initDeadlineMs}ms`));
          }, remaining);
          deadlineTimer.unref();
        }),
      ]);
    } catch (error: any) {
      // A deadline-expired attempt may finish after its replacement started.
      // Fence it by both flight token and client ownership.
      if (initFlights.get(clientNumber)?.token !== token || clients.get(clientNumber) !== client) {
        log.info('ignored init failure from superseded client', { clientNumber });
        return;
      }
      const failureClass = classifyWebjsInitFailure(error);
      const message = String(error?.message ?? error ?? 'unknown initialization failure').slice(0, 500);
      observeBootstrap();
      syncTelemetry();
      const telemetrySnapshot = telemetry.snapshot();
      const consecutiveTimeouts = failureClass === 'init_timeout'
        ? previousHealth.consecutiveTimeouts + 1
        : 0;
      const requiresRepair = failureClass === 'init_timeout'
        && consecutiveTimeouts >= policy.timeoutEscalationCount;
      const retryAt = failureClass === 'init_timeout' && !requiresRepair
        ? Date.now() + initTimeoutRetryDelayMs(consecutiveTimeouts)
        : null;
      // Release profile ownership before destroying. Any delayed event from
      // this failed client is fenced out by the ownership checks above.
      clients.delete(clientNumber);
      await disposeWebjsClient(client);
      statusMap.set(clientNumber, failureClass === 'init_timeout' ? 'init_timeout' : 'error');
      initHealth.set(clientNumber, {
        state: failureClass === 'init_timeout' ? 'init_timeout' : 'error',
        startedAt: flight.startedAt, deadlineAt: flight.deadlineAt, retryAt,
        consecutiveTimeouts, requiresRepair, lastError: message,
        telemetry: telemetrySnapshot,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE whatsapp_config
            SET status = $2, last_error = $3, last_error_at = NOW()
          WHERE client_number = $1`,
        clientNumber,
        failureClass === 'init_timeout' ? 'init_timeout' : 'error',
        `${failureClass}[${telemetrySnapshot.stage}]: ${message}`,
      ).catch(() => undefined);
      log.error('initialization failed', {
        clientNumber, failureClass, consecutiveTimeouts, retryAt, requiresRepair,
        protocolTimeoutMs: policy.protocolTimeoutMs, initDeadlineMs: policy.initDeadlineMs,
        initStage: telemetrySnapshot.stage,
        pageUrl: telemetrySnapshot.pageUrl,
        wwebVersion: telemetrySnapshot.wwebVersion,
        qrListenerRegistered: telemetrySnapshot.qrListenerRegistered,
        qrEmitted: telemetrySnapshot.qrEmitted,
        authenticated: telemetrySnapshot.authenticated,
        loadingPercent: telemetrySnapshot.loadingPercent,
        browserErrors: telemetrySnapshot.consoleErrors,
      });
      void import('../systemLogService').then(({ log: sysLog }) => sysLog({
        level: requiresRepair ? 'error' : 'warning',
        category: 'health_transition',
        source: `whatsapp:${clientNumber}`,
        message: requiresRepair
          ? `WhatsApp session likely wedged after ${consecutiveTimeouts} initialization timeouts — re-pair may be required`
          : `WhatsApp initialization timeout ${consecutiveTimeouts}/${policy.timeoutEscalationCount}`,
        clientNumber,
      } as any)).catch(() => undefined);
      if (requiresRepair) {
        void import('./connectionWatchdog').then(({ alertWhatsAppDisconnect }) => alertWhatsAppDisconnect({
          clientNumber,
          tenantPhone: '(check Admin → WhatsApp)',
          reason: `session likely wedged after ${consecutiveTimeouts} initialization timeouts`,
          requiresAction: 'Open Admin → WhatsApp and re-pair the QR session.',
          attemptCount: consecutiveTimeouts,
        })).catch((alertError: any) => {
          log.error('init-timeout escalation failed', { clientNumber, error: alertError?.message });
        });
      }
      throw error;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      clearInterval(telemetryTimer);
      detachPageTelemetry();
      // Release the initFlight lock — regardless of success/failure —
      // so a later reconnect can proceed once the current attempt
      // resolves.
      if (initFlights.get(clientNumber)?.token === token) initFlights.delete(clientNumber);
    }
  }

  async getQRCode(clientNumber: string): Promise<string | null> {
    return qrCodes.get(clientNumber) || null;
  }

  async testConnection(clientNumber: string): Promise<TestResult> {
    const client = clients.get(clientNumber);
    const status = statusMap.get(clientNumber);
    if (!client || status !== 'connected') {
      return { success: false, error: `Status: ${status || 'not initialized'}` };
    }
    return { success: true, connectedNumber: '+' + client.info.wid.user };
  }

  async sendMessage(params: SendMessageParams): Promise<SendResult> {
    const client = clients.get(params.clientNumber);
    if (!client || statusMap.get(params.clientNumber) !== 'connected') {
      return { success: false, error: 'WhatsApp not connected' };
    }
    try {
      // Pre-flight: verify the target is actually on WhatsApp before
      // attempting to send. Per Basit 2026-07-07: silent send failures
      // to unknown numbers left Brain reporting "sent" while nothing
      // arrived — 20+ minutes of user confusion in the 2:39–3:03 pm
      // exchange. getNumberId returns null when the number isn't a
      // WhatsApp user, letting us fail LOUDLY with an honest error
      // instead of trying to send into the void.
      //
      // Extra bonus: getNumberId returns the canonical @c.us WA
      // identifier that WORKS for sends even when the naïve
      // "<digits>@c.us" construction fails (some regional numbers
      // have oddities).
      const digitsOnly = String(params.to).replace(/[^\d]/g, '');
      if (!digitsOnly || digitsOnly.length < 8) {
        return { success: false, error: `invalid phone number "${params.to}"` };
      }
      let chatId: string;
      try {
        const numberId = await client.getNumberId(digitsOnly);
        if (!numberId) {
          return {
            success: false,
            error: `+${digitsOnly} is not registered on WhatsApp (getNumberId returned null)`,
          };
        }
        chatId = numberId._serialized;
      } catch (err: any) {
        // getNumberId itself failed — fall back to naive chatId construction
        // rather than blocking. Log so we can see when this happens.
        log.warn('getNumberId threw, falling back to naive chatId', { to: params.to, err: err.message });
        chatId = digitsOnly + '@c.us';
      }

      const msg = await client.sendMessage(chatId, params.message);
      // A resolved send without an id is transport-accepted but unconfirmed.
      // Never retry it: production proved those sends can arrive, and retrying
      // from a false failure creates duplicate user-visible messages.
      return classifyWebjsSendResult(msg);
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Send a voice note (OGG/Opus buffer) through whatsapp-web.js.
   *
   * The `sendAudioAsVoice: true` flag is what makes WhatsApp render the
   * file as a playable voice bubble rather than a generic audio
   * attachment — without it, OGG arrives as a downloadable file.
   *
   * Caller is responsible for daily-limit accounting; this method only
   * handles the wire send. WhatsAppManager.sendWhatsAppVoiceNote wraps
   * with the atomic-claim pattern (mirrors sendWhatsAppMessage).
   */
  async sendVoiceMessage(
    clientNumber: string,
    to: string,
    audio: Buffer,
    mimeType: string = 'audio/ogg; codecs=opus',
  ): Promise<SendResult> {
    const client = clients.get(clientNumber);
    if (!client || statusMap.get(clientNumber) !== 'connected') {
      return { success: false, error: 'WhatsApp not connected' };
    }
    try {
      // @ts-ignore optional dep — already loaded during initialize()
      const wwebjs = await import('whatsapp-web.js' as string);
      const MessageMedia = wwebjs.MessageMedia || wwebjs.default?.MessageMedia;
      // Pre-flight validation — same reasoning as sendMessage.
      const digitsOnly = String(to).replace(/[^\d]/g, '');
      if (!digitsOnly || digitsOnly.length < 8) {
        return { success: false, error: `invalid phone number "${to}"` };
      }
      let chatId: string;
      try {
        const numberId = await client.getNumberId(digitsOnly);
        if (!numberId) {
          return {
            success: false,
            error: `+${digitsOnly} is not registered on WhatsApp`,
          };
        }
        chatId = numberId._serialized;
      } catch {
        chatId = digitsOnly + '@c.us';
      }
      const media = new MessageMedia(mimeType, audio.toString('base64'), `voice-${Date.now()}.ogg`);
      const msg = await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
      return classifyWebjsSendResult(msg);
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async disconnect(clientNumber: string): Promise<void> {
    const client = clients.get(clientNumber);
    if (client) {
      await disposeWebjsClient(client);
      clients.delete(clientNumber);
      statusMap.delete(clientNumber);
      qrCodes.delete(clientNumber);
    }
    initFlights.delete(clientNumber);
    initHealth.delete(clientNumber);
    reconnectAttempts.delete(clientNumber);
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_config SET status = 'disconnected', qr_code = NULL WHERE client_number = $1`, clientNumber,
    );
  }

  async getStatus(clientNumber: string): Promise<ConnectionStatus> {
    const status = (statusMap.get(clientNumber) || 'disconnected') as ConnectionStatus['status'];
    const client = clients.get(clientNumber);
    return {
      status,
      connectedNumber: status === 'connected' && client ? '+' + client.info?.wid?.user : undefined,
      error: getWebjsInitHealth(clientNumber).lastError,
      init: getWebjsInitHealth(clientNumber),
    };
  }
}
