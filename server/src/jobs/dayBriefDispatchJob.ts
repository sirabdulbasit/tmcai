/**
 * dayBriefDispatchJob — fires each user's Day Brief on WhatsApp at
 * their configured local time.
 *
 * Per user 2026-05-16: "include Day Brief time where brain will sent
 * message to user on daily basis" — and earlier "as per setting user
 * can set time of day brief, so at that time brain will send day
 * brief to user on whatsapp".
 *
 * Settings live under user.notificationPreferences.brain_channel:
 *   dayBriefTime: 'HH:MM' (24h, in user's tz; default '08:30')
 *   timezone:     IANA zone (default 'Asia/Karachi')
 *   outboundEnabled: must be true (opt-in)
 *
 * Cadence: cron ticks every minute. For each opted-in user we compute
 * their local wall-clock from a single `now` and fire if (a) the local
 * date has rolled over since last fire, and (b) the local time is at
 * or past their configured dayBriefTime. Cron jitter / a skipped tick
 * never causes a miss — if 09:01 ticks fine but 08:30 didn't, the
 * 09:01 tick still fires (time has crossed configured time and today
 * hasn't fired yet).
 *
 * Once-per-local-day enforcement: Redis key
 *   day_brief_fired:<userId>:<YYYY-MM-DD-local>
 * with 36h TTL. brainContactsUser's content-fingerprint dedup is a
 * second layer of protection (1h window).
 *
 * Body: answerAsBrain(userId, 'brief my day', channel='whatsapp')
 * — same composer that drives /brain/ask, but rendered for WA (terse,
 * no markdown, ~600 char cap). Per user 2026-05-15 unified-Brain-Chat
 * decision: web and WhatsApp share one composer; only the renderer
 * differs.
 *
 * Bypasses quiet hours — user chose this time explicitly, so they
 * want the brief then regardless of quiet-window settings.
 *
 * Sender identity: Nexeo (tenant notifier number) via
 * brainContactsUser. Never sends from the user's paired WhatsApp.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { brainContactsUser } from '../services/notifications/brainOutboundService';
import { getRedis } from '../utils/redisClient';

const log = createLogger('day-brief-dispatch');

interface RunResult {
  scanned: number;
  fired: number;
  skipped: number;
  errors: number;
}

/** Get a user's wall-clock HH:MM and YYYY-MM-DD in their IANA tz. */
function wallClockInZone(now: Date, timezone: string): { hhmm: string; ymd: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    // Some Node/ICU builds report '24' for midnight — normalise.
    const hour = get('hour') === '24' ? '00' : get('hour');
    const min = get('minute');
    const y = get('year'); const m = get('month'); const d = get('day');
    if (!y || !m || !d || !hour || !min) return null;
    return { hhmm: `${hour}:${min}`, ymd: `${y}-${m}-${d}` };
  } catch {
    // Unknown timezone — silently skip rather than blow up the tick.
    return null;
  }
}

/** "08:30" → 510. Returns null if malformed. */
function hhmmToMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

export async function runDayBriefDispatch(): Promise<RunResult> {
  const result: RunResult = { scanned: 0, fired: 0, skipped: 0, errors: 0 };
  const now = new Date();
  const redis = getRedis();

  // Pull every user with outbound enabled. Filtering via JSON-path
  // would let Postgres prune, but the user count is small (<100 for
  // TMC today) and the filter is cheap in app code. Re-evaluate if
  // this grows past a few thousand.
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, clientNumber: true, notificationPreferences: true },
  });

  for (const u of users) {
    const prefs = (u.notificationPreferences as any) ?? {};
    const bc = prefs.brain_channel ?? {};
    if (bc.outboundEnabled !== true) continue;
    if (bc.outboundPaused === true) continue;

    const configured = typeof bc.dayBriefTime === 'string' ? bc.dayBriefTime : '08:30';
    const timezone = typeof bc.timezone === 'string' && bc.timezone.length > 0 ? bc.timezone : 'Asia/Karachi';
    const configuredMinutes = hhmmToMinutes(configured);
    if (configuredMinutes === null) continue;

    const wall = wallClockInZone(now, timezone);
    if (!wall) continue;

    const nowMinutes = hhmmToMinutes(wall.hhmm);
    if (nowMinutes === null) continue;

    result.scanned += 1;

    // Hasn't reached configured time yet today.
    if (nowMinutes < configuredMinutes) continue;

    // Already fired today's local-day? Use Redis as the source of
    // truth so a server restart between 06:00 and 08:30 doesn't
    // double-fire. If Redis is down, fall through and rely on
    // brainContactsUser's content/dedupKey dedup as a backstop —
    // worst case is a duplicate body fingerprint dropped inside an
    // hour, well short of a 24h cycle.
    const firedKey = `day_brief_fired:${u.id}:${wall.ymd}`;
    if (redis) {
      try {
        const already = await redis.get(firedKey);
        if (already) { result.skipped += 1; continue; }
      } catch { /* fall through */ }
    }

    // Compose the brief via the unified Brain composer. channel=whatsapp
    // gives us the WA-rendered terse body. Empty history — Day Brief
    // is a fresh ask, not a continuation of any conversation.
    try {
      const { answerAsBrain } = await import('../routes/brainAskRoutes');
      const out = await answerAsBrain(u.clientNumber, u.id, 'brief my day', [], { channel: 'whatsapp' });
      const body = (out.answer || '').trim();
      if (!body) {
        // Composer returned empty — don't mark fired so tomorrow tries
        // again. Log so we can investigate.
        log.warn('day brief composer returned empty', { userId: u.id });
        result.errors += 1;
        continue;
      }

      // Dispatch via Nexeo. dedupKey scoped to local-YMD so the daily
      // cap doesn't conflate two days, and the content-fingerprint
      // window can't drop a fresh brief simply because yesterday's
      // happened to be similar.
      const dispatch = await brainContactsUser({
        userId: u.id,
        kind: 'day_brief',
        summary: `Day Brief — ${wall.ymd}`,
        body,
        urgency: 'normal',
        bypassQuietHours: true, // user explicitly chose this time
        dedupKey: `day_brief:${u.id}:${wall.ymd}`,
        metadata: { localDate: wall.ymd, localTime: wall.hhmm, timezone, configured },
      });

      if (!dispatch.sent) {
        // Common legitimate reasons: opt_in_required (race vs settings
        // change), user_paused_outbound, daily_cap. Don't mark fired —
        // a transient block today shouldn't permanently skip the user.
        log.warn('day brief not sent', { userId: u.id, reason: dispatch.reason });
        result.errors += 1;
        continue;
      }

      // Mark fired. 36h TTL — covers DST shifts and timezone changes
      // without leaving stale keys around forever.
      if (redis) {
        try { await redis.set(firedKey, '1', 'EX', 36 * 60 * 60); }
        catch { /* non-critical — content dedup is the backstop */ }
      }
      result.fired += 1;
    } catch (err: any) {
      log.warn('day brief dispatch failed', { userId: u.id, error: err.message });
      result.errors += 1;
    }
  }

  return result;
}
