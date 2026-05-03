/**
 * MyOS — tenant-level WhatsApp Notifier (outbound).
 *
 * Brain uses this single sender per tenant when it needs to message a user
 * mid-day (e.g. "should I send this reply to CFO?"). Each user receives from
 * the SAME tenant number. Inbound WhatsApp stays per-user via user_connectors.
 *
 * Credentials (access token) are stored encrypted in tenant_whatsapp_notifier.
 * Encryption reuses ENCRYPTION_KEY from env — same key used elsewhere for PII.
 */
import crypto from 'crypto';
import prisma from '../../db/prisma';

const META_GRAPH = 'https://graph.facebook.com/v18.0';

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY ?? '';
  if (raw.length < 16) {
    throw new Error('ENCRYPTION_KEY not set (need ≥16 chars)');
  }
  // Normalise to 32 bytes (AES-256)
  return crypto.createHash('sha256').update(raw).digest();
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, encB64] = payload.split('.');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export async function getNotifier(clientNumber: string) {
  return prisma.tenantWhatsappNotifier.findUnique({ where: { clientNumber } });
}

export async function saveNotifier(
  clientNumber: string,
  input: { displayNumber: string; phoneNumberId: string; accessToken: string; appId?: string; wabaId?: string },
) {
  const encrypted = encrypt(input.accessToken);
  return prisma.tenantWhatsappNotifier.upsert({
    where: { clientNumber },
    update: {
      displayNumber: input.displayNumber,
      phoneNumberId: input.phoneNumberId,
      accessTokenEncrypted: encrypted,
      appId: input.appId,
      wabaId: input.wabaId,
      updatedAt: new Date(),
    },
    create: {
      clientNumber,
      displayNumber: input.displayNumber,
      phoneNumberId: input.phoneNumberId,
      accessTokenEncrypted: encrypted,
      appId: input.appId,
      wabaId: input.wabaId,
      isActive: true,
      verifiedAt: new Date(),
    },
  });
}

export async function sendViaNotifier(
  clientNumber: string,
  toPhone: string,
  body: string,
): Promise<{ ok: boolean; waMessageId?: string; error?: string }> {
  const n = await getNotifier(clientNumber);
  if (!n || !n.isActive || !n.phoneNumberId || !n.accessTokenEncrypted) {
    return { ok: false, error: 'no active WhatsApp notifier for tenant' };
  }
  let token: string;
  try {
    token = decrypt(n.accessTokenEncrypted);
  } catch {
    return { ok: false, error: 'notifier token decrypt failed' };
  }
  const phone = toPhone.replace(/^\+/, '');
  try {
    const r = await fetch(`${META_GRAPH}/${n.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: body.slice(0, 4096) },
      }),
    });
    const j: any = await r.json();
    await prisma.tenantWhatsappNotifier.update({
      where: { clientNumber },
      data: { lastSendAt: new Date(), lastError: r.ok ? null : JSON.stringify(j).slice(0, 500) },
    });
    if (!r.ok) return { ok: false, error: `Meta ${r.status}: ${j?.error?.message ?? 'unknown'}` };
    return { ok: true, waMessageId: j?.messages?.[0]?.id };
  } catch (err: any) {
    await prisma.tenantWhatsappNotifier.update({
      where: { clientNumber },
      data: { lastError: err.message?.slice(0, 500) },
    }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

/**
 * Upload a media buffer to Meta and return the media id.
 * Used for voice notes (audio/ogg) but works for images, video, docs too.
 *
 * Voice note path expects OGG/Opus (the format Google TTS produces and the
 * format WhatsApp natively renders as a "voice message" instead of an
 * audio attachment). Other audio formats render as a generic file.
 */
async function uploadMedia(
  clientNumber: string,
  buffer: Buffer,
  mimeType: string,
): Promise<{ ok: true; mediaId: string } | { ok: false; error: string }> {
  const n = await getNotifier(clientNumber);
  if (!n || !n.isActive || !n.phoneNumberId || !n.accessTokenEncrypted) {
    return { ok: false, error: 'no active WhatsApp notifier for tenant' };
  }
  let token: string;
  try { token = decrypt(n.accessTokenEncrypted); }
  catch { return { ok: false, error: 'notifier token decrypt failed' }; }

  // Meta /media expects multipart/form-data with fields:
  //   messaging_product=whatsapp, type=<mime>, file=<binary>
  const ext = mimeType === 'audio/ogg' ? 'ogg'
            : mimeType === 'audio/mp4' ? 'm4a'
            : mimeType === 'audio/mpeg' ? 'mp3'
            : 'bin';
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  // Convert Node Buffer → Uint8Array so the DOM Blob constructor accepts it.
  // Buffer is no longer a valid BlobPart in @types/node ≥20 / DOM types ≥4.
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), `voice.${ext}`);

  try {
    const r = await fetch(`${META_GRAPH}/${n.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form as any,
    });
    const j: any = await r.json();
    if (!r.ok || !j?.id) {
      return { ok: false, error: `Meta media ${r.status}: ${j?.error?.message ?? 'unknown'}` };
    }
    return { ok: true, mediaId: String(j.id) };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send a voice note via the tenant notifier.
 *
 * Flow: upload audio → send WhatsApp message of type=audio with voice=true
 * (the `voice: true` flag is what makes WhatsApp render the file as a
 * playable voice bubble rather than a generic audio attachment).
 *
 * Buffer should be OGG/Opus (Brain's voiceService.ts already produces this
 * via Google TTS). Any other format falls back to a regular audio
 * attachment — still works, just renders less naturally.
 */
export async function sendVoiceNoteViaNotifier(
  clientNumber: string,
  toPhone: string,
  audio: Buffer,
  mimeType: string = 'audio/ogg',
): Promise<{ ok: boolean; waMessageId?: string; error?: string }> {
  const upload = await uploadMedia(clientNumber, audio, mimeType);
  if (!upload.ok) return { ok: false, error: upload.error };

  const n = await getNotifier(clientNumber);
  if (!n) return { ok: false, error: 'notifier vanished mid-send' };
  let token: string;
  try { token = decrypt(n.accessTokenEncrypted!); }
  catch { return { ok: false, error: 'notifier token decrypt failed' }; }

  const phone = toPhone.replace(/^\+/, '');
  try {
    const r = await fetch(`${META_GRAPH}/${n.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'audio',
        audio: { id: upload.mediaId, voice: true },
      }),
    });
    const j: any = await r.json();
    await prisma.tenantWhatsappNotifier.update({
      where: { clientNumber },
      data: { lastSendAt: new Date(), lastError: r.ok ? null : JSON.stringify(j).slice(0, 500) },
    });
    if (!r.ok) return { ok: false, error: `Meta audio ${r.status}: ${j?.error?.message ?? 'unknown'}` };
    return { ok: true, waMessageId: j?.messages?.[0]?.id };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send a "Brain wants you on a call" nudge — text message with the tenant
 * display number rendered so WhatsApp's auto-link makes it tap-to-call.
 *
 * Why this exists alongside `initiateBusinessCall`: Meta's Business Calling
 * API is gated behind enrollment per phone number. Until the tenant gets
 * approved, the user still needs a fast path to talk to Brain — this one
 * works on every WhatsApp account today, no enrollment needed.
 *
 * The user taps the number → WhatsApp opens its native call dialler →
 * places an outbound call FROM the user TO the tenant business number,
 * which Brain answers via voice-bot pipeline (separate workstream).
 */
export async function sendCallNudgeViaNotifier(
  clientNumber: string,
  toPhone: string,
  preamble: string,
): Promise<{ ok: boolean; waMessageId?: string; error?: string }> {
  const n = await getNotifier(clientNumber);
  if (!n?.displayNumber) {
    return { ok: false, error: 'notifier display number not set — cannot render call CTA' };
  }
  // WhatsApp auto-detects E.164 numbers in message bodies and renders a
  // tap-to-call affordance. Putting the number on its own line + an emoji
  // prefix maximises detection across iOS/Android clients.
  const body = `${preamble.trim()}\n\n📞 Call back: ${n.displayNumber}`;
  return sendViaNotifier(clientNumber, toPhone, body);
}

/**
 * Initiate a WhatsApp Business Calling API call.
 *
 * Meta endpoint: POST /{phone-number-id}/calls
 *   { messaging_product: 'whatsapp', to: <e164>, action: 'connect' }
 *
 * Requires: tenant phone number enrolled in WhatsApp Business Calling
 * (an explicit Meta program — not enabled by default). When the tenant
 * isn't enrolled, this returns `not_enrolled` so callers can fall back
 * to `sendCallNudgeViaNotifier` cleanly.
 */
export async function initiateBusinessCall(
  clientNumber: string,
  toPhone: string,
): Promise<{ ok: boolean; callId?: string; error?: string; notEnrolled?: boolean }> {
  const n = await getNotifier(clientNumber);
  if (!n || !n.isActive || !n.phoneNumberId || !n.accessTokenEncrypted) {
    return { ok: false, error: 'no active WhatsApp notifier for tenant' };
  }
  if (!n.callingEnabled) {
    return { ok: false, notEnrolled: true, error: 'WhatsApp Business Calling not enabled for this tenant. Toggle it on after Meta approves the number.' };
  }
  let token: string;
  try { token = decrypt(n.accessTokenEncrypted); }
  catch { return { ok: false, error: 'notifier token decrypt failed' }; }
  const phone = toPhone.replace(/^\+/, '');
  const url = n.callingApiUrl
    ? `${n.callingApiUrl}/${n.phoneNumberId}/calls`
    : `${META_GRAPH}/${n.phoneNumberId}/calls`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, action: 'connect' }),
    });
    const j: any = await r.json();
    await prisma.tenantWhatsappNotifier.update({
      where: { clientNumber },
      data: { lastCallAt: new Date(), lastCallError: r.ok ? null : JSON.stringify(j).slice(0, 500) },
    });
    if (!r.ok) {
      // Common case: 400 with code 100/131 = number not enrolled.
      const code = j?.error?.code;
      const notEnrolled = code === 100 || code === 131 || /not.*enroll|not.*supported/i.test(j?.error?.message ?? '');
      return { ok: false, notEnrolled, error: `Meta call ${r.status}: ${j?.error?.message ?? 'unknown'}` };
    }
    return { ok: true, callId: j?.calls?.[0]?.id ?? j?.messages?.[0]?.id };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Probe the notifier (no send) — used by the admin UI to verify config.
 */
export async function pingNotifier(clientNumber: string): Promise<{ ok: boolean; detail: string }> {
  const n = await getNotifier(clientNumber);
  if (!n) return { ok: false, detail: 'not configured' };
  if (!n.isActive) return { ok: false, detail: 'inactive' };
  if (!n.accessTokenEncrypted || !n.phoneNumberId) return { ok: false, detail: 'missing token or phone_number_id' };
  try {
    const token = decrypt(n.accessTokenEncrypted);
    const r = await fetch(`${META_GRAPH}/${n.phoneNumberId}?fields=display_phone_number,verified_name`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return { ok: false, detail: `Meta ${r.status}` };
    const j: any = await r.json();
    return { ok: true, detail: `${j.verified_name ?? ''} ${j.display_phone_number ?? ''}`.trim() };
  } catch (err: any) {
    return { ok: false, detail: err.message };
  }
}
