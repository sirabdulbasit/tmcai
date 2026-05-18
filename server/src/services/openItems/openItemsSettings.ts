/**
 * openItemsSettings — typed reader for the per-user Open Items
 * preferences stored under user.notificationPreferences.open_items.
 *
 * One place that knows the schema + defaults + clamping rules, so
 * every consumer (draft-ask job, backlog cleanup, gate, follow-up
 * job, /open-items page) sees the same values for the same user.
 *
 * Cached for 60s per userId — the prefs barely change and the
 * consumer jobs hit this once per tick per user; a Redis or DB
 * round-trip per item would be wasteful.
 */
import prisma from '../../db/prisma';

export interface OpenItemsSettings {
  followUpDays: number;
  autoArchiveClosedAfterDays: number;
  staleThresholdDays: number;
  draftExpiryDays: number;
  draftAskChannel: 'whatsapp' | 'email' | 'both';
  autoCreateFromEmail: boolean;
  autoCreateFromWhatsapp: boolean;
  autoCreateFromVoice: boolean;
  autoCreateCriticalityFloor: 'all' | 'medium' | 'high';
  defaultSort: 'priority' | 'deadline' | 'recent' | 'oldest';
}

export const DEFAULTS: OpenItemsSettings = {
  followUpDays: 3,
  autoArchiveClosedAfterDays: 30,
  staleThresholdDays: 14,
  draftExpiryDays: 6,
  draftAskChannel: 'whatsapp',
  autoCreateFromEmail: true,
  autoCreateFromWhatsapp: true,
  autoCreateFromVoice: true,
  autoCreateCriticalityFloor: 'all',
  defaultSort: 'priority',
};

const cache = new Map<number, { value: OpenItemsSettings; expiresAt: number }>();
const TTL_MS = 60 * 1000;

function coerce(raw: any): OpenItemsSettings {
  const out: any = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;

  if (Number.isFinite(raw.followUpDays)) out.followUpDays = Math.min(30, Math.max(1, Math.round(raw.followUpDays)));
  if (Number.isFinite(raw.autoArchiveClosedAfterDays)) out.autoArchiveClosedAfterDays = Math.min(365, Math.max(0, Math.round(raw.autoArchiveClosedAfterDays)));
  if (Number.isFinite(raw.staleThresholdDays)) out.staleThresholdDays = Math.min(90, Math.max(0, Math.round(raw.staleThresholdDays)));
  if (Number.isFinite(raw.draftExpiryDays)) out.draftExpiryDays = Math.min(30, Math.max(2, Math.round(raw.draftExpiryDays)));
  if (['whatsapp', 'email', 'both'].includes(raw.draftAskChannel)) out.draftAskChannel = raw.draftAskChannel;
  if (typeof raw.autoCreateFromEmail === 'boolean') out.autoCreateFromEmail = raw.autoCreateFromEmail;
  if (typeof raw.autoCreateFromWhatsapp === 'boolean') out.autoCreateFromWhatsapp = raw.autoCreateFromWhatsapp;
  if (typeof raw.autoCreateFromVoice === 'boolean') out.autoCreateFromVoice = raw.autoCreateFromVoice;
  if (['all', 'medium', 'high'].includes(raw.autoCreateCriticalityFloor)) out.autoCreateCriticalityFloor = raw.autoCreateCriticalityFloor;
  if (['priority', 'deadline', 'recent', 'oldest'].includes(raw.defaultSort)) out.defaultSort = raw.defaultSort;
  return out;
}

export async function getOpenItemsSettings(userId: number): Promise<OpenItemsSettings> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > now) return hit.value;

  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPreferences: true },
  }).catch(() => null);

  const raw = (u?.notificationPreferences as any)?.open_items;
  const value = coerce(raw);
  cache.set(userId, { value, expiresAt: now + TTL_MS });
  return value;
}

/** Clear cache for a user — call this from the PUT /profile/open-items
 *  handler so a settings change takes effect on the next tick instead
 *  of waiting 60s. */
export function invalidateOpenItemsSettings(userId: number): void {
  cache.delete(userId);
}

/** Map criticality floor → numeric for comparison. */
const CRIT_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const FLOOR_ORDER: Record<OpenItemsSettings['autoCreateCriticalityFloor'], number> = {
  all: 0, medium: 1, high: 2,
};

/** Returns true if an item with the given priority passes the user's
 *  criticality floor. Unknown priorities pass (we don't gate on a
 *  signal we don't have). */
export function meetsCriticalityFloor(
  priority: string | null | undefined,
  floor: OpenItemsSettings['autoCreateCriticalityFloor'],
): boolean {
  if (!priority) return true;
  const p = CRIT_ORDER[priority.toLowerCase()];
  if (p === undefined) return true;
  return p >= FLOOR_ORDER[floor];
}

/** Map a feed_events.sourceType value to the corresponding setting
 *  toggle. Returns null when the source isn't gateable (e.g. ERP,
 *  manual, calendar) — caller treats null as "pass through".
 *
 *  Note: voice notes today arrive inside whatsapp threads (no
 *  dedicated source_type), so the WhatsApp toggle effectively
 *  governs them too. When voice gets its own source_type (or
 *  becomes a sub-channel on Gmail via attachments), point the
 *  'voice' branch at that value. */
export function sourceToggleKey(
  source: string | null | undefined,
): 'autoCreateFromEmail' | 'autoCreateFromWhatsapp' | 'autoCreateFromVoice' | null {
  if (!source) return null;
  const s = source.toLowerCase();
  if (s === 'gmail' || s === 'email') return 'autoCreateFromEmail';
  if (s === 'whatsapp' || s === 'wa' || s === 'gchat') return 'autoCreateFromWhatsapp';
  if (s === 'voice' || s === 'voicenote') return 'autoCreateFromVoice';
  return null;
}
