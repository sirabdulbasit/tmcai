/**
 * openItemsSettings — typed reader for the per-user Open Items
 * preferences stored under user.notificationPreferences.open_items.
 *
 * One place that knows the schema + defaults + clamping rules, so
 * every consumer (draft-ask job, backlog cleanup, gate, follow-up
 * job, /open-items page) sees the same values for the same user.
 *
 * Cached for 60s per (tenant, user) — the prefs barely change and the
 * consumer jobs hit this once per tick per user; a Redis or DB
 * round-trip per item would be wasteful.
 *
 * DEF-188 (Codex iteration-1 carried CRITICAL) — the caller DECLARES the
 * tenant it is acting for, and the declaration CONSTRAINS the resolution
 * query itself (`id + clientNumber`, the DEF-179 pattern): a foreign or
 * mismatched pair resolves to NO row — unread — and gets pure defaults,
 * never another tenant's preferences. A bare userId was an authorization,
 * which is invariant #1's recorded failure shape.
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

/**
 * DEF-190 (Codex iteration-3 HIGH 4 / directive 4) — WHO holds the
 * preference is part of the answer, not an implementation detail:
 *
 *   'found'               a confirmed user row in this tenant, with an
 *                         open_items block — `value` is his real preference.
 *   'absent_preferences'  a confirmed user row, no open_items block — the
 *                         defined absence: defaults are AUTHORIZED because
 *                         the user exists and simply never set them.
 *   'no_user'             the (tenant, user) pair reads as NO row — foreign,
 *                         deleted, or inactive. There is no authority here
 *                         and `value` is null: a caller mutating data on the
 *                         strength of settings must HOLD, not default.
 *
 * A DATABASE ERROR is none of these — it THROWS (DEF-189).
 */
export type OpenItemsSettingsAuthority = 'found' | 'absent_preferences' | 'no_user';

export interface ResolvedOpenItemsSettings {
  authority: OpenItemsSettingsAuthority;
  /** Coerced settings for 'found'/'absent_preferences'; null for 'no_user'. */
  value: OpenItemsSettings | null;
}

const cache = new Map<string, { value: ResolvedOpenItemsSettings; expiresAt: number }>();
const TTL_MS = 60 * 1000;
const cacheKey = (userId: number, clientNumber: string) => `${clientNumber}|${userId}`;

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

export async function resolveOpenItemsSettings(
  userId: number,
  clientNumber: string,
): Promise<ResolvedOpenItemsSettings> {
  const now = Date.now();
  const key = cacheKey(userId, clientNumber);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  // The tenant declaration constrains the query (DEF-188): a pair that does
  // not exist in this tenant reads nothing.
  //
  // DEF-189 (Codex iteration-2 HIGH) — a DATABASE ERROR is not an absence and
  // must THROW. Nothing is cached on the error path; every consumer sits in a
  // try/catch whose fail direction is "do less" (cleanup holds, the gate
  // falls through to creating visibly, the follow-up job skips a tick).
  const u = await prisma.user.findFirst({
    where: { id: userId, clientNumber },
    select: { notificationPreferences: true },
  });

  let resolved: ResolvedOpenItemsSettings;
  if (!u) {
    resolved = { authority: 'no_user', value: null };
  } else {
    const raw = (u.notificationPreferences as any)?.open_items;
    resolved = {
      authority: raw && typeof raw === 'object' ? 'found' : 'absent_preferences',
      value: coerce(raw),
    };
  }
  cache.set(key, { value: resolved, expiresAt: now + TTL_MS });
  return resolved;
}

/**
 * Convenience for callers whose userId comes from an AUTHENTICATED context
 * (the gate, the follow-up job, the profile route): the pair is known to
 * exist, so 'no_user' is a not-in-practice branch and defaults are a safe
 * read-side answer. Callers that MUTATE on the strength of settings must use
 * `resolveOpenItemsSettings` and hold on 'no_user' (DEF-190).
 */
export async function getOpenItemsSettings(userId: number, clientNumber: string): Promise<OpenItemsSettings> {
  const resolved = await resolveOpenItemsSettings(userId, clientNumber);
  return resolved.value ?? DEFAULTS;
}

/** Clear cache for a user — call this from the PUT /profile/open-items
 *  handler so a settings change takes effect on the next tick instead
 *  of waiting 60s. */
export function invalidateOpenItemsSettings(userId: number, clientNumber: string): void {
  cache.delete(cacheKey(userId, clientNumber));
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
