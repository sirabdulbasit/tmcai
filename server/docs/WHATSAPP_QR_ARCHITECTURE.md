# WhatsApp QR-Code 2-Way Communication — Reference Architecture

**Purpose:** Complete blueprint for building QR-code WhatsApp (send + receive)
into a Node.js/TypeScript app using `whatsapp-web.js`. Battle-tested in
Nexeo/TMCAI in production since April 2026. Hand this doc to any coding
agent and they can implement the same pattern from scratch.

**Non-goals:** Meta Cloud API (that's a different architecture — see
`WHATSAPP_META_ARCHITECTURE.md`). Multi-tenant separation is included
but a single-tenant version drops the `clientNumber` field.

---

## 1. Why `whatsapp-web.js` (and its trade-offs)

| Pros | Cons |
|---|---|
| Free | Unofficial — reverse-engineered from WhatsApp Web |
| Any WhatsApp number works — no business approval | Meta can ban the number (low risk with human-paced usage) |
| Rich features (voice notes, media, groups) | Chromium overhead (~300MB per client) |
| One-time QR scan, session persists on disk | Occasional library breakage on WA protocol changes |
| No per-message cost | No calling API — can't place voice calls |
| Setup in minutes | ~1 client per box realistic (Chromium heavy) |

**Use when:** small user base, no budget for Meta API, need speed to ship.
**Migrate to Meta when:** 50+ tenants, need voice calls, ban risk becomes real.

---

## 2. Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Your Node.js Server                            │
│                                                                       │
│  ┌──────────────────────────┐   ┌──────────────────────────────┐    │
│  │  WebjsProvider (class)   │   │  Inbound Message Handler     │    │
│  │  - manages Client per    │──▶│  - identity resolution       │    │
│  │    tenant                │   │  - business logic (LLM etc)  │    │
│  │  - QR issuance           │   │  - reply composition         │    │
│  │  - reconnect logic       │   │  - send back                 │    │
│  │  - event handlers        │   └──────────────────────────────┘    │
│  └──────────────────────────┘                                       │
│           │                                                          │
│           │ launches headless Chromium via puppeteer                 │
│           ▼                                                          │
│  ┌──────────────────────────┐                                       │
│  │  Chromium (puppeteer)    │◀────── LocalAuth session persisted    │
│  │  Runs WhatsApp Web       │        to disk (survives restart)     │
│  └──────────────────────────┘                                       │
│           │                                                          │
└───────────┼──────────────────────────────────────────────────────────┘
            │ WebSocket to WhatsApp servers
            ▼
      ┌───────────┐
      │ WhatsApp  │
      │ Web infra │
      └───────────┘
```

Key idea: the `Client` object is your handle to a paired WhatsApp account.
It emits events (`ready`, `qr`, `message`, `call`, `disconnected`) and
exposes methods (`sendMessage`, `getChatById`, `getContacts`).

---

## 3. Dependencies

```jsonc
// package.json
{
  "dependencies": {
    "whatsapp-web.js": "^1.34.7",
    "qrcode": "^1.5.4",       // for rendering the QR as data-URL
    "puppeteer": "^24.x"       // whatsapp-web.js pulls this transitively but pin it
  }
}
```

**System requirement:** Chromium/Chrome binary. On Ubuntu:
```bash
apt install google-chrome-stable
# OR set PUPPETEER_EXECUTABLE_PATH to any chromium
```

Puppeteer's bundled Chromium works too but adds ~200MB to install size.

---

## 4. Database Schema (Prisma)

Only 3 tables are essential. Names use snake_case for tables, camelCase in
Prisma models.

### 4.1 `whatsapp_config` — per-tenant paired-phone state

```prisma
model WhatsAppConfig {
  clientNumber      String    @id @map("client_number")  // your tenant key
  provider          String    @default("webjs")          // 'webjs' | 'meta'
  status            String    @default("disconnected")   // 'connected' | 'connecting' | 'qr' | 'disconnected' | 'error'
  connectedNumber   String?   @map("connected_number")   // +E164 once paired
  connectedAt       DateTime? @map("connected_at")
  qrCode            String?   @map("qr_code")            // data-URL of current QR
  qrExpiresAt       DateTime? @map("qr_expires_at")
  dailyLimit        Int       @default(500) @map("daily_limit")
  monthlyLimit      Int       @default(2000) @map("monthly_limit")
  messagesToday     Int       @default(0) @map("messages_today")
  messagesThisMonth Int       @default(0) @map("messages_this_month")
  lastMessageAt     DateTime? @map("last_message_at")
  lastError         String?   @map("last_error")
  lastErrorAt       DateTime? @map("last_error_at")
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @default(now()) @updatedAt

  @@map("whatsapp_config")
}
```

### 4.2 `whatsapp_connections` — phone-number → user mapping

The identity table. When a message arrives from `+923XXXXXXXXX`, we look
here to find which user of your app that is. Multiple rows per user is
OK and required — one for the real phone, others for `@lid` aliases.

```prisma
model WhatsAppConnection {
  id           Int      @id @default(autoincrement())
  userId       Int      @map("user_id")
  phoneNumber  String   @map("phone_number")     // E.164 with +
  waId         String?  @map("wa_id")             // Optional: WhatsApp's internal ID
  status       String   @default("active")        // 'active' | 'inactive'
  provider     String?  @default("webjs")
  clientNumber String?  @map("client_number")
  displayName  String?  @map("display_name")
  connectedAt  DateTime @default(now()) @map("connected_at")
  updatedAt    DateTime @default(now()) @updatedAt @map("updated_at")

  @@index([userId, phoneNumber])
  @@index([phoneNumber])
  @@map("whatsapp_connections")
}
```

### 4.3 `whatsapp_messages` — audit log of every in/out message

```prisma
model WhatsAppMessage {
  id           Int      @id @default(autoincrement())
  clientNumber String   @map("client_number")
  userId       Int      @map("user_id")           // resolved sender/recipient user
  direction    String                              // 'inbound' | 'outbound'
  fromNumber   String   @map("from_number")
  toNumber     String   @map("to_number")
  content      String
  messageType  String   @default("text") @map("message_type") // text | voice | image | doc
  status       String   @default("sent")           // 'sent' | 'received' | 'failed'
  waMessageId  String?  @map("wa_message_id")
  errorMessage String?  @map("error_message")
  createdAt    DateTime @default(now())

  @@index([clientNumber, direction, createdAt])
  @@map("whatsapp_messages")
}
```

---

## 5. Provider Class — Owns the `Client` Lifecycle

```typescript
// services/whatsapp/WebjsProvider.ts

import fs from 'fs';
import path from 'path';
import prisma from '../db/prisma';

// Per-tenant state kept IN-MEMORY. Lost on restart, restored from
// LocalAuth session on next initialize().
const clients = new Map<string, any>();          // clientNumber → wwebjs Client
const qrCodes = new Map<string, string>();       // clientNumber → data-URL QR
const statusMap = new Map<string, string>();     // clientNumber → status

// Reconnect coordination — prevents thundering-herd when WA drops
const initFlight = new Set<string>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const reconnectAttempts = new Map<string, number>();
const RECONNECT_BACKOFF_MS = [10_000, 30_000, 120_000, 300_000, 600_000];

// Message-event dedup — WA sometimes fires both 'message' and
// 'message_create' for the same inbound. Track by wa message id.
const seenMessageIds = new Map<string, number>();
const SEEN_TTL_MS = 60 * 1000;
function markSeen(msgId: string): boolean {
  const now = Date.now();
  if (seenMessageIds.size > 200) {
    for (const [k, t] of seenMessageIds) if (now - t > SEEN_TTL_MS) seenMessageIds.delete(k);
  }
  if (seenMessageIds.has(msgId)) return true;
  seenMessageIds.set(msgId, now);
  return false;
}

export class WebjsProvider {
  async initialize(clientNumber: string): Promise<void> {
    if (initFlight.has(clientNumber)) return;         // idempotency
    const current = statusMap.get(clientNumber);
    if ((current === 'connected' || current === 'connecting') && clients.has(clientNumber)) return;

    initFlight.add(clientNumber);
    try {
      // Clean previous client if any
      if (clients.has(clientNumber)) {
        try { await clients.get(clientNumber).destroy(); } catch {}
        clients.delete(clientNumber);
      }

      // Chromium can leave stale SingletonLock files on hard-kills.
      // If we don't clean these, the next launch hangs and the QR
      // never appears. Delete only when the PID inside is dead.
      const sessionPath = process.env.WHATSAPP_SESSION_PATH || './whatsapp-sessions';
      cleanStaleSingletonLocks(path.join(sessionPath, `session-${clientNumber}`));

      // Dynamic import so app boots even if package isn't installed.
      const { Client, LocalAuth } = await import('whatsapp-web.js' as string);
      const QRCode = await import('qrcode' as string);

      const executablePath =
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        process.env.CHROME_PATH ||
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : process.platform === 'win32'
          ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
          : '/usr/bin/google-chrome-stable');

      const client = new Client({
        authStrategy: new LocalAuth({ clientId: clientNumber, dataPath: sessionPath }),
        restartOnAuthFail: true,
        puppeteer: {
          headless: true,
          executablePath,
          args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
            '--disable-gpu',
          ],
        },
      });

      statusMap.set(clientNumber, 'connecting');
      clients.set(clientNumber, client);

      client.on('qr', async (qr: string) => {
        const qrImage = await QRCode.toDataURL(qr);
        qrCodes.set(clientNumber, qrImage);
        await prisma.whatsAppConfig.update({
          where: { clientNumber },
          data: { qrCode: qrImage, qrExpiresAt: new Date(Date.now() + 60_000), status: 'connecting' },
        }).catch(() => {});
      });

      client.on('ready', async () => {
        statusMap.set(clientNumber, 'connected');
        qrCodes.delete(clientNumber);
        reconnectAttempts.delete(clientNumber);
        const number = '+' + client.info.wid.user;
        await prisma.whatsAppConfig.update({
          where: { clientNumber },
          data: {
            status: 'connected', connectedNumber: number, connectedAt: new Date(),
            qrCode: null, qrExpiresAt: null, lastError: null,
          },
        }).catch(() => {});
      });

      // The message flow — see Section 6.
      client.on('message', (msg) => handleInbound(clientNumber, msg));

      // Newer library versions fire 'message_create' instead of 'message'
      // for some cases. Handle both, dedup via wa msg id.
      client.on('message_create', (msg) => {
        if (msg.fromMe) return;   // outbound already handled by our own send path
        handleInbound(clientNumber, msg);
      });

      // Incoming voice calls — auto-reject (webjs can't answer).
      client.on('call', async (call) => {
        try { await call.reject(); } catch {}
      });

      client.on('disconnected', async (reason: string) => {
        statusMap.set(clientNumber, 'disconnected');
        clients.delete(clientNumber);
        await prisma.whatsAppConfig.update({
          where: { clientNumber },
          data: { status: 'disconnected', lastError: `disconnected: ${reason}`, lastErrorAt: new Date() },
        }).catch(() => {});

        // Don't reconnect on LOGOUT / CONFLICT / UNPAIRED — WhatsApp
        // is telling us another session took over, and reconnecting
        // would just kick that one out. Surface to user instead.
        const NO_RECONNECT = ['LOGOUT', 'CONFLICT', 'UNPAIRED', 'UNLAUNCHED'];
        if (NO_RECONNECT.includes(String(reason).toUpperCase())) return;

        // Exponential backoff reconnect.
        const attempt = reconnectAttempts.get(clientNumber) ?? 0;
        if (attempt >= RECONNECT_BACKOFF_MS.length) {
          // Circuit breaker open — stop and require manual QR re-pair.
          reconnectAttempts.delete(clientNumber);
          return;
        }
        const delay = RECONNECT_BACKOFF_MS[attempt];
        reconnectAttempts.set(clientNumber, attempt + 1);
        const timer = setTimeout(async () => {
          reconnectTimers.delete(clientNumber);
          try { await new WebjsProvider().initialize(clientNumber); } catch {}
        }, delay);
        timer.unref();
        reconnectTimers.set(clientNumber, timer);
      });

      client.on('auth_failure', async (msg) => {
        statusMap.set(clientNumber, 'error');
        await prisma.whatsAppConfig.update({
          where: { clientNumber },
          data: { status: 'error', lastError: msg, lastErrorAt: new Date() },
        }).catch(() => {});
      });

      await client.initialize();
    } finally {
      initFlight.delete(clientNumber);
    }
  }

  async getQRCode(clientNumber: string): Promise<string | null> {
    return qrCodes.get(clientNumber) ?? null;
  }

  async testConnection(clientNumber: string): Promise<{ success: boolean; error?: string; connectedNumber?: string }> {
    const client = clients.get(clientNumber);
    const status = statusMap.get(clientNumber);
    if (!client || status !== 'connected') {
      return { success: false, error: `Status: ${status ?? 'not initialized'}` };
    }
    return { success: true, connectedNumber: '+' + client.info.wid.user };
  }

  async sendMessage(params: { clientNumber: string; to: string; message: string })
    : Promise<{ success: boolean; messageId?: string; error?: string }>
  {
    const client = clients.get(params.clientNumber);
    if (!client || statusMap.get(params.clientNumber) !== 'connected') {
      return { success: false, error: 'WhatsApp not connected' };
    }
    try {
      const chatId = params.to.replace('+', '') + '@c.us';
      const msg = await client.sendMessage(chatId, params.message);
      return { success: true, messageId: msg.id.id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async sendVoiceMessage(clientNumber: string, to: string, audio: Buffer)
    : Promise<{ success: boolean; messageId?: string; error?: string }>
  {
    const client = clients.get(clientNumber);
    if (!client || statusMap.get(clientNumber) !== 'connected') {
      return { success: false, error: 'WhatsApp not connected' };
    }
    try {
      const wwebjs = await import('whatsapp-web.js' as string);
      const MessageMedia = wwebjs.MessageMedia;
      const chatId = to.replace('+', '') + '@c.us';
      const media = new MessageMedia('audio/ogg; codecs=opus', audio.toString('base64'), `voice-${Date.now()}.ogg`);
      const msg = await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
      return { success: true, messageId: msg.id.id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async disconnect(clientNumber: string): Promise<void> {
    const client = clients.get(clientNumber);
    if (client) {
      try { await client.destroy(); } catch {}
      clients.delete(clientNumber);
      statusMap.delete(clientNumber);
      qrCodes.delete(clientNumber);
    }
    await prisma.whatsAppConfig.update({
      where: { clientNumber },
      data: { status: 'disconnected', qrCode: null },
    }).catch(() => {});
  }
}

function cleanStaleSingletonLocks(sessionDir: string): void {
  if (!fs.existsSync(sessionDir)) return;
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(sessionDir, name);
    try {
      const target = fs.readlinkSync(p);
      const m = /-(\d+)$/.exec(target);
      const pid = m ? Number(m[1]) : NaN;
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, 0); continue; }  // alive — leave alone
        catch (err: any) { if (err.code !== 'ESRCH') continue; }
      }
      fs.unlinkSync(p);
    } catch { /* ignore missing */ }
  }
}
```

---

## 6. Inbound Message Flow

```
message event
    │
    ▼
[skip status/group/broadcast]
    │
    ▼
[dedup via wa msg id]
    │
    ▼
[extract phone from raw @c.us or @lid]
    │      ↳ if @lid: try getContact() to resolve real phone
    │      ↳ if getContact fails: use synthetic "+lid_digits"
    ▼
[audit log inbound]  (whatsapp_messages row, direction='inbound')
    │
    ▼
[lookup user_id from whatsapp_connections by phone variants]
    │      ↳ variants: as-is, digits-only, +digits, 0-local
    │      ↳ NOT FOUND → drop silently (unregistered)
    ▼
[hand off to your app logic] (LLM / triage / whatever)
    │
    ▼
[compose reply] → provider.sendMessage()
```

Code:

```typescript
// services/whatsapp/inboundHandler.ts

export async function handleInbound(clientNumber: string, message: any): Promise<void> {
  const rawFrom = message.from || '';

  // Skip non-chat traffic
  if (rawFrom === 'status@broadcast') return;
  if (rawFrom.includes('@g.us')) return;             // groups
  if (rawFrom.includes('@newsletter')) return;
  if (!message.body?.trim() && !message.hasMedia) return;

  // Type whitelist — WA emits e2e_notification, ciphertext, call_log,
  // gp2, etc. through the same handler. Their body is often the chatId
  // or a security token, NOT a real message. Drop them.
  const REAL_TYPES = new Set([
    'chat', 'ptt', 'audio', 'image', 'video', 'document',
    'sticker', 'location', 'vcard', 'multi_vcard',
  ]);
  const msgType = String(message.type ?? 'chat').toLowerCase();
  if (!REAL_TYPES.has(msgType)) return;

  // Dedup — 'message' and 'message_create' can both fire
  const msgId = message.id?._serialized || message.id?.id || `${rawFrom}:${message.timestamp}`;
  if (markSeen(msgId)) return;

  // ─── Phone extraction ─────────────────────────────────────────
  let fromNumber = '';
  let synthLidPhone: string | null = null;

  if (rawFrom.includes('@c.us')) {
    fromNumber = '+' + rawFrom.replace('@c.us', '');
  } else if (rawFrom.includes('@lid')) {
    // @lid = "linked device ID". Doesn't map directly to a phone.
    // Try getContact() to resolve real phone. If it fails, use the
    // synthetic +lid_digits as a stable identity for this device.
    synthLidPhone = '+' + rawFrom.replace('@lid', '');
    try {
      const contact = await message.getContact();
      const contactNum = contact?.number || contact?.id?.user || '';
      if (contactNum && !contactNum.includes('@')) {
        fromNumber = '+' + contactNum;
      } else {
        fromNumber = synthLidPhone;
      }
    } catch {
      fromNumber = synthLidPhone;
    }
  } else {
    fromNumber = '+' + rawFrom.replace(/@.*$/, '');
  }

  // ─── AUTO-HEAL @lid alias (self-healing identity) ─────────────
  // If getContact returned a real phone AND we have a synthetic,
  // register the synthetic as an additional alias for the same user.
  // Future messages from the same @lid then match via the phone-
  // variants lookup below without needing getContact — which is
  // reliability-critical because getContact can flake on @lid.
  if (synthLidPhone && fromNumber !== synthLidPhone) {
    void (async () => {
      try {
        const owner = await prisma.whatsAppConnection.findFirst({
          where: { phoneNumber: fromNumber, status: 'active' },
          select: { userId: true, clientNumber: true },
        });
        if (!owner) return;
        const existing = await prisma.whatsAppConnection.findFirst({
          where: { userId: owner.userId, phoneNumber: synthLidPhone },
        });
        if (existing) return;
        await prisma.whatsAppConnection.create({
          data: {
            userId: owner.userId, phoneNumber: synthLidPhone,
            status: 'active', provider: 'webjs',
            clientNumber: owner.clientNumber,
            displayName: `auto-learned LID alias (${synthLidPhone.slice(-6)})`,
          },
        });
      } catch { /* best effort */ }
    })();
  }

  // ─── User identity lookup ─────────────────────────────────────
  const digits = fromNumber.replace(/[^\d]/g, '');
  const variants = [
    fromNumber,
    digits,
    '+' + digits,
    '0' + digits.slice(digits.startsWith('92') ? 2 : 0),  // adjust country prefix
  ];
  const connection = await prisma.whatsAppConnection.findFirst({
    where: {
      clientNumber, status: 'active',
      phoneNumber: { in: variants },
    },
    select: { userId: true },
  });

  if (!connection) {
    // Unregistered sender — drop silently. Do not save, do not reply.
    // Otherwise:
    //   1. Every scraper hitting your number gets confirmation you're a bot
    //   2. Storage bloats with spam
    //   3. Reply quota burns
    return;
  }

  const userId = connection.userId;

  // ─── Audit log inbound ────────────────────────────────────────
  await prisma.whatsAppMessage.create({
    data: {
      clientNumber, userId, direction: 'inbound',
      fromNumber, toNumber: '',
      content: message.body || '(media)',
      messageType: msgType === 'ptt' || msgType === 'audio' ? 'voice'
        : msgType === 'image' ? 'image'
        : msgType === 'document' ? 'doc'
        : 'text',
      status: 'received',
    },
  });

  // ─── Hand off to your app logic ────────────────────────────────
  const replyText = await yourAppReplyFn(userId, message.body || '');

  // ─── Reply back ────────────────────────────────────────────────
  const provider = new WebjsProvider();
  const result = await provider.sendMessage({
    clientNumber, to: fromNumber, message: replyText,
  });

  await prisma.whatsAppMessage.create({
    data: {
      clientNumber, userId, direction: 'outbound',
      fromNumber: '', toNumber: fromNumber,
      content: replyText,
      status: result.success ? 'sent' : 'failed',
      waMessageId: result.messageId ?? null,
      errorMessage: result.error ?? null,
    },
  });
}
```

---

## 7. The "Receiving Works But Sending Fails" Gotcha

This is the #1 issue when building this. Root causes, ordered by frequency:

### 7.1 Client not ready

`client.info` is undefined during the tiny window between `qr` scan and
`ready`. `sendMessage` throws obscurely.

**Fix:** always gate on `statusMap.get(cn) === 'connected'` before sending.
Return `{ success: false, error: 'not connected' }` if not — don't throw.

### 7.2 Wrong chatId format

`sendMessage(to, ...)` needs `to = "<digits>@c.us"` — NOT `+<digits>` and
NOT `<digits>@lid`. The `+` prefix MUST be stripped. Groups use `@g.us`.

```typescript
// WRONG
await client.sendMessage('+923226288256', text);
// RIGHT
await client.sendMessage('923226288256@c.us', text);
```

### 7.3 Sending to a number the paired phone has never seen

Some versions of webjs error with "Chat not found" on the first send to a
brand-new contact. Workaround:

```typescript
const chatId = to.replace('+', '') + '@c.us';
const numberId = await client.getNumberId(to.replace('+', ''));
if (!numberId) return { success: false, error: 'Not a WhatsApp user' };
await client.sendMessage(numberId._serialized, text);
```

### 7.4 Reply on `@lid` chat

If inbound came from `@lid`, reply MUST go back via the SAME chat, not the
resolved real phone. Otherwise WhatsApp doesn't route it. Do:

```typescript
const chat = await message.getChat();
await chat.sendMessage(replyText);
```

Using `chat.sendMessage` (instead of `client.sendMessage(chatId, ...)`)
reuses the chat context and works for `@lid`. This is the pattern our
production code uses for auto-replies.

### 7.5 WhatsApp daily rate limit hit

WA silently drops sends when you exceed ~80-100 messages/minute or a few
thousand per day. Symptom: `sendMessage` returns success but message
never arrives, and the account may get flagged.

**Fix:** enforce your own daily cap (see `whatsapp_config.dailyLimit`).
Increment `messagesToday` on every send; refuse if over cap. Reset via a
cron at midnight in the tenant's timezone.

### 7.6 Chromium crashed silently

Chromium can OOM or crash without `disconnected` firing. `sendMessage`
then hangs or throws `Session closed`.

**Fix:** run an active watchdog every 60s that calls `testConnection`.
If it fails but DB says `status='connected'`, call `initialize()` to
re-attach from LocalAuth. Recovery is usually <10 sec.

```typescript
setInterval(async () => {
  const cfgs = await prisma.whatsAppConfig.findMany({ where: { status: 'connected' } });
  for (const cfg of cfgs) {
    const t = await new WebjsProvider().testConnection(cfg.clientNumber);
    if (!t.success) {
      await new WebjsProvider().initialize(cfg.clientNumber);
    }
  }
}, 60_000);
```

### 7.7 Multiple Client instances for the same tenant

Two `Client` objects for the same LocalAuth session fight for the same
Chromium user-data dir → both crash. Guard with `initFlight` Set:

```typescript
const initFlight = new Set<string>();
async initialize(cn: string) {
  if (initFlight.has(cn)) return;
  initFlight.add(cn);
  try { /* do init */ } finally { initFlight.delete(cn); }
}
```

---

## 8. Session Persistence — Why `LocalAuth` Matters

`LocalAuth` saves the paired-session state to disk (default:
`./whatsapp-sessions/session-<clientId>`). On restart, `initialize()`
reads this dir and reconnects to the SAME WhatsApp account with no QR.

If the dir is deleted OR the phone logs out from Linked Devices, the
next `initialize()` triggers a fresh QR event.

**Practical implication:** never delete `whatsapp-sessions/` casually. If
you want to change numbers, do it via a "Reset Pairing" flow:

```typescript
async resetPairing(clientNumber: string): Promise<void> {
  await this.disconnect(clientNumber);  // destroys in-memory client
  const sessionDir = path.join(sessionPath, `session-${clientNumber}`);
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true });
  await prisma.whatsAppConfig.update({
    where: { clientNumber },
    data: {
      status: 'disconnected', connectedNumber: null,
      qrCode: null, qrExpiresAt: null,
    },
  });
  await this.initialize(clientNumber);  // shows fresh QR
}
```

---

## 9. Voice Notes (Both Directions)

### 9.1 Receive voice note → transcribe → reply

```typescript
if (message.type === 'ptt' || message.type === 'audio') {
  const media = await message.downloadMedia();
  if (media?.data) {
    const audioBuffer = Buffer.from(media.data, 'base64');
    // Use Google Cloud Speech / OpenAI Whisper / any STT
    const transcript = await transcribeAudio(audioBuffer, media.mimetype);
    // Now process transcript.text same as a text message
  }
}
```

### 9.2 Send voice note

The `sendAudioAsVoice: true` flag is what renders the file as a playable
voice bubble in WhatsApp (instead of a generic audio attachment):

```typescript
const audio: Buffer = await textToSpeech(replyText);  // any TTS
const media = new MessageMedia('audio/ogg; codecs=opus',
  audio.toString('base64'), `voice-${Date.now()}.ogg`);
await chat.sendMessage(media, { sendAudioAsVoice: true });
```

Format matters: `audio/ogg; codecs=opus` renders as voice; other formats
show as generic audio files.

---

## 10. Config Endpoints (Admin API)

Minimum surface for the admin UI:

| Method | Path | Purpose |
|---|---|---|
| GET  | `/admin/whatsapp/status` | Current status + connected number |
| POST | `/admin/whatsapp/connect` | Start `initialize()` for tenant |
| GET  | `/admin/whatsapp/qr` | Poll every 3s while status='connecting'; returns data-URL QR |
| POST | `/admin/whatsapp/disconnect` | Destroy in-memory client (keep session) |
| POST | `/admin/whatsapp/reset-pairing` | disconnect + delete session dir + reinitialize |
| POST | `/admin/whatsapp/test` | Send test message to admin's own number |
| GET  | `/admin/whatsapp/messages` | Paginated audit log |

---

## 11. Failure Modes & Mitigations Summary

| Failure | Detect via | Auto-recover? | Manual action |
|---|---|---|---|
| Chromium OOM / crash | `testConnection` returns fail | Yes — watchdog re-inits | None if <10s |
| WA session logout from phone | `disconnected` event with `LOGOUT` | No — needs QR re-pair | Admin scans new QR |
| Multiple devices conflict | `disconnected` with `CONFLICT` | No | Log out other device |
| `@lid` chat identity mismatch | Auto-heal on next inbound with getContact success | Yes | None |
| WA daily rate limit hit | Send returns success but message never arrives | No | Wait / raise cap / rotate number |
| Library breaks on WA protocol update | All sends/receives silently fail | No | Upgrade lib version |
| Host reboot / SIGKILL | Stale SingletonLock on next boot | Yes — cleanup on init | None |

---

## 12. Minimum Boot Sequence

```typescript
// app.ts entry
async function boot() {
  // 1. Initialize every tenant that DB says should be connected.
  const cfgs = await prisma.whatsAppConfig.findMany({
    where: { status: { in: ['connected', 'connecting'] } },
  });
  for (const cfg of cfgs) {
    new WebjsProvider().initialize(cfg.clientNumber).catch((e) => {
      console.warn(`init failed for ${cfg.clientNumber}:`, e.message);
    });
  }

  // 2. Start the watchdog.
  setInterval(watchdogTick, 60_000);

  // 3. Start HTTP server for admin API.
  app.listen(process.env.PORT ?? 4002);
}
```

---

## 13. What NOT to Do

- **Don't** run multiple `Client` objects for the same paired phone.
- **Don't** delete `whatsapp-sessions/` unless you explicitly want to re-pair.
- **Don't** poll `client.info` before the `ready` event fires.
- **Don't** send more than ~60 messages/minute — WhatsApp rate-limits and can ban.
- **Don't** trust `whatsapp_config.status` as ground truth of health — always verify with `testConnection()` when it matters.
- **Don't** silently swallow `disconnected` events — log them; some (LOGOUT/CONFLICT) mean the session is dead until admin intervention.
- **Don't** call `sendMessage` from module top level before `ready`.
- **Don't** rely on `getContact()` for `@lid` — it's flaky. Cache alias mappings once resolved (see §6 auto-heal).

---

## 14. Testing Checklist Before Shipping

Run each of these and confirm the outcome:

- [ ] Fresh install: no QR → click Connect → QR appears → scan → status becomes `connected`
- [ ] Send a text FROM the paired phone → server receives event → audit row created → reply arrives on phone
- [ ] Send a voice note → transcription runs → text reply arrives
- [ ] Server restart → `initialize` runs from saved session → status returns to `connected` without QR
- [ ] Kill `pm2` / `node` with SIGKILL → restart → still reconnects (stale-lock cleanup works)
- [ ] Log out from phone → server sees `disconnected: LOGOUT` → no reconnect attempted → admin surface shows "needs re-pair"
- [ ] Send from unregistered number → dropped silently, no reply, PM2 log line only
- [ ] Send from user with `@lid` chat → reply arrives → next message from same `@lid` uses direct lookup (alias auto-learned)
- [ ] Hit daily limit → subsequent sends return `daily_limit_reached` cleanly
- [ ] Incoming voice call → auto-rejected

---

## 15. Estimated Effort for a New App

Rough numbers for a Node/TS shop:

| Component | Effort |
|---|---|
| WebjsProvider class (init, reconnect, QR, disconnect) | 4-6 hr |
| Inbound handler with dedup + @lid + auto-heal | 3-4 hr |
| Send path (text + voice + media) | 2-3 hr |
| DB schema + migrations | 1 hr |
| Admin API endpoints (7 routes) | 2 hr |
| Admin UI (QR display + status + Reset button + audit log) | 4-6 hr |
| Watchdog cron + tests + edge cases | 3-4 hr |
| **Total** | **~1 week for one dev** |

Meta migration when you're ready: another 2-3 days on top, since the
inbound / outbound / audit shapes stay the same — only the transport
swaps.

---

## 16. Where to Look in Nexeo's Code (Reference)

For deeper detail beyond this doc:

| Concern | File |
|---|---|
| Provider class | `server/src/services/whatsapp/WebjsProvider.ts` |
| Inbound handler | `server/src/services/whatsapp/WhatsAppInbound.ts` |
| Personal-WA (per-user pairing) | `server/src/services/whatsapp/UserWebjsProvider.ts` |
| Connection sync (additive; @lid safe) | `server/src/services/whatsapp/connectionSync.ts` |
| Watchdog + health metrics | `server/src/services/whatsapp/connectionWatchdog.ts` |
| Admin routes | `server/src/routes/admin/whatsappAdminRoutes.ts` |
| Admin UI (React) | `client/src/pages/admin/WhatsAppTab.jsx` |

These are all production code, battle-tested. Copy patterns from them
directly — the doc above is the extract; those files are the reference
implementation.

---

*End of document. When in doubt, prefer resilience over cleverness —
`whatsapp-web.js` is an unofficial layer; assume it will break in
weird ways and design your recovery paths first.*
