/**
 * REQ-009 — SHARED WhatsApp identity resolution (@lid ⇄ phone).
 *
 * WHY THIS FILE EXISTS (recurrence post-mortem, 2026-07-28):
 * Modern WhatsApp delivers 1:1 chats under two interchangeable identities
 * for the SAME human: a phone Wid (`<digits>@c.us`) and a LID Wid
 * (`<digits>@lid`). whatsapp-web.js accepts one in some APIs and the
 * other in others, so any module that compares raw id strings — or that
 * calls a Chat/Message helper with the "wrong" identity — breaks.
 *
 * Chat 12 (2026-07-17) fixed this ONCE, inside a private
 * `resolvePhoneChat` in inboundActivity.ts. Because the fix was never
 * shared, every module written afterwards reopened the same hole:
 *   - §34's liveness probe compared `msg.to` against `wid._serialized`
 *     with no @lid awareness, so its self-chat echo never matched, every
 *     probe failed, and the tenant channel wedged `degraded` for 4 days
 *     (07-24 → 07-28) with outbound sends withheld.
 *   - PTT media download had no phone-chat retry limb.
 *
 * So: ONE resolver, used by the activity layer, the media layer, and the
 * liveness probe. New modules MUST use this rather than comparing raw
 * ids. That is the actual fix — the per-call-site patches were symptoms.
 *
 * Every function here is defensive by construction: an unavailable
 * library method, a null client, or a rejected page evaluation returns a
 * neutral value instead of throwing. Identity resolution is a helper on
 * the side of real work; it must never be the thing that breaks a turn.
 */
import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:identity');

/** Cache of resolved id ⇄ id pairs. WhatsApp's LID↔phone binding for an
 *  account is stable for the life of the pairing, and each miss costs a
 *  Puppeteer page evaluation, so caching matters on the probe path
 *  (every heartbeat) and the activity path (every inbound message). */
const identityCache = new Map<string, string[]>();

export function __resetWaIdentityCacheForTests(): void {
  identityCache.clear();
}

export function isLidId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.endsWith('@lid');
}

/**
 * Canonical comparison form for a Wid.
 *
 * Two things vary without changing WHO is addressed, and both have
 * produced false mismatches in this codebase:
 *   1. device suffix — `92300@c.us` vs `92300:12@c.us` (multi-device)
 *   2. case
 *
 * The domain is deliberately PRESERVED: `x@c.us` and `x@lid` carry
 * different numeric namespaces (a LID is not a phone number), so
 * collapsing them here would let one account's LID compare equal to
 * another account's phone. Cross-domain equivalence is established only
 * by asking the library — see resolveIdentityIds.
 */
export function normalizeWid(id: string | null | undefined): string {
  if (typeof id !== 'string' || id.length === 0) return '';
  const trimmed = id.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 0) return trimmed;
  const user = trimmed.slice(0, at).split(':')[0];
  return `${user}${trimmed.slice(at)}`;
}

/** True when both ids denote the same address, ignoring device/case. */
export function sameWid(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeWid(a);
  const nb = normalizeWid(b);
  return na.length > 0 && na === nb;
}

/**
 * All ids that denote the same human as `rawId`, normalized and
 * deduped — `[rawId]` plus its counterpart identity when the library can
 * supply one. Used for identity COMPARISON (does this event concern that
 * address?), which is the check §34's probe got wrong.
 */
export async function resolveIdentityIds(client: any, rawId: string | null | undefined): Promise<string[]> {
  const base = normalizeWid(rawId);
  if (!base) return [];
  const cached = identityCache.get(base);
  if (cached) return cached;

  const ids = [base];
  try {
    if (typeof client?.getContactLidAndPhone === 'function') {
      const mappings = await client.getContactLidAndPhone([base]);
      for (const candidate of [mappings?.[0]?.lid, mappings?.[0]?.pn]) {
        const normalized = normalizeWid(candidate);
        if (normalized && !ids.includes(normalized)) ids.push(normalized);
      }
    }
  } catch (error: any) {
    // A failed mapping must not widen OR break matching — fall back to
    // the single known id and let the caller decide.
    log.warn('identity mapping unavailable', { rawId: base, error: error?.message });
    return ids;
  }
  // Only cache once the library actually answered; caching a lone id
  // after a transient failure would make the miss permanent.
  if (ids.length > 1) identityCache.set(base, ids);
  return ids;
}

/**
 * Every id that denotes THIS logged-in account — its phone Wid and its
 * LID Wid. The liveness probe sends a self-chat message and must accept
 * the echo under whichever identity WhatsApp stamps on it; comparing
 * against `client.info.wid._serialized` alone is what failed.
 */
export async function resolveSelfIds(client: any): Promise<string[]> {
  const self = normalizeWid(client?.info?.wid?._serialized);
  if (!self) return [];
  return resolveIdentityIds(client, self);
}

/**
 * Real E.164-ish phone (`+<digits>`) for a LID sender, or null.
 *
 * The inbound door needs the COUNTERPART's real number: registration
 * lookup, delegation-thread correlation and the audit log all key on it.
 * `message.getContact()` was the door's only resolver and it broke with
 * the same upstream class as chat-state/media — so every `@lid` sender
 * degraded to a synthetic phone (`+<lid-digits>`) that matches nothing,
 * and their messages were dropped as "Unregistered number". That is how
 * a delegatee's answer ("Working boss", 2026-08-03 07:01Z) vanished
 * while the follow-up worker kept pinging him daily.
 */
export async function lidToPhone(client: any, rawId: string | null | undefined): Promise<string | null> {
  if (!isLidId(rawId)) return null;
  const ids = await resolveIdentityIds(client, rawId!);
  const pn = ids.find((id) => id.endsWith('@c.us'));
  return pn ? `+${pn.slice(0, -'@c.us'.length)}` : null;
}

/**
 * The phone-Wid `Chat` equivalent of a possibly-LID chat, or null.
 *
 * Some Chat state helpers (sendStateTyping / sendStateRecording /
 * clearState) reject a LID Wid. Callers use this as a RETRY target after
 * the direct attempt throws — never as the first attempt, since the
 * direct object is correct whenever it works.
 */
export async function resolvePhoneChat(client: any, rawId: string | null | undefined): Promise<any | null> {
  if (!isLidId(rawId) || typeof client?.getChatById !== 'function') return null;
  try {
    const mappings = await client.getContactLidAndPhone?.([rawId]);
    const phoneId = mappings?.[0]?.pn;
    if (!phoneId) return null;
    return await client.getChatById(phoneId);
  } catch (error: any) {
    log.warn('phone-chat resolution failed', { rawId, error: error?.message });
    return null;
  }
}

/**
 * Re-fetch a message through its phone-Wid chat.
 *
 * PTT media on a LID chat can stay unresolvable on the originally
 * emitted object while the same message is downloadable via the
 * phone-identity chat. This is the media analogue of resolvePhoneChat
 * and the limb Chat 12's retry ladder was missing.
 */
export async function resolveMessageViaPhoneChat(message: any): Promise<any | null> {
  const client = message?.client;
  const rawId: string = message?.from || '';
  if (!isLidId(rawId)) return null;
  const targetId = normalizeWid(message?.id?._serialized);
  if (!targetId) return null;
  const chat = await resolvePhoneChat(client, rawId);
  if (!chat || typeof chat.fetchMessages !== 'function') return null;
  try {
    const recent = await chat.fetchMessages({ limit: 20 });
    return (recent ?? []).find((m: any) => sameWid(m?.id?._serialized, targetId)) ?? null;
  } catch (error: any) {
    log.warn('message re-fetch via phone chat failed', { rawId, error: error?.message });
    return null;
  }
}
