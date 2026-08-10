/**
 * Step 5 — Brain tells the owner what it found, instead of waiting to be asked.
 *
 * Owner, 2026-08-07: *"i don't want to send screenshots of my whatsapp again and
 * again"*, and later *"will you inform me? how?"*.
 *
 * Until now the loop stopped one step short. Findings were recorded, scored and
 * visible on the watcher — and then sat in a table until someone opened a
 * session. That is `gapDetectionJob` with better plumbing: it has persisted "gap
 * candidates for admin review" for months and there has never been a reviewer.
 *
 * Two channels, deliberately different in urgency, because one firehose gets
 * muted and then nothing is monitored at all:
 *
 *   IMMEDIATE — something reached a real person badly, or is actively broken.
 *               Sent as it happens, subject to quiet hours.
 *   DIGEST    — one message a day: what stalled, what was healed, how Brain
 *               scored. Routine self-heals that worked are NOT reported
 *               individually; a repair that verified is not news.
 *
 * `notified_at` is stamped only after a CONFIRMED send, never at enqueue. That
 * is the whole DEF-081 discipline applied to the mechanism that exists because
 * of DEF-081.
 */

import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { unnotifiedFindings, markNotified } from './healthFindingService';

const log = createLogger('finding-notifier');

/** Severities that interrupt rather than wait for the digest. */
const IMMEDIATE_SEVERITIES = ['error', 'critical'];

interface NotifyOutcome { sent: number; findings: number }

/**
 * Send anything severe the owner has not been told about.
 *
 * Batched into ONE message per user rather than one per finding: three
 * separate WhatsApps about the same bad ten minutes is how a person learns to
 * ignore the channel.
 */
export async function notifySevereFindings(clientNumber: string): Promise<NotifyOutcome> {
  const open = await unnotifiedFindings(clientNumber, 20).catch(() => []);
  const severe = open.filter((f) => IMMEDIATE_SEVERITIES.includes(f.severity));
  if (severe.length === 0) return { sent: 0, findings: 0 };

  // Group by user: a finding belongs to whoever it happened to, and a tenant
  // may have several. No global "the owner" (owner instruction, 2026-08-07).
  const byUser = new Map<number, typeof severe>();
  for (const f of severe) {
    if (f.userId == null) continue;
    const list = byUser.get(f.userId) ?? [];
    list.push(f);
    byUser.set(f.userId, list);
  }

  const { brainContactsUser } = await import('../notifications/brainOutboundService');
  let sent = 0;
  const stamped: string[] = [];

  for (const [userId, items] of byUser) {
    const lines = items.slice(0, 5).map((f) => `• ${f.summary}`).join('\n');
    const more = items.length > 5 ? `\n…and ${items.length - 5} more.` : '';
    const result = await brainContactsUser({
      userId,
      kind: 'brain_health_alert',
      summary: `${items.length} problem(s) I found on my own`,
      body: `I found ${items.length === 1 ? 'a problem' : `${items.length} problems`} with my own behaviour:\n\n${lines}${more}\n\nI'm not asking you to do anything — I'm telling you because you shouldn't have to find these yourself.`,
      urgency: 'normal',
      channel: 'text',
      // One alert per user per hour at most. The dedup key deliberately does
      // not include the finding ids: the point is to cap interruptions, not to
      // send a fresh message every time the set changes by one.
      dedupKey: `health_alert:${userId}:${new Date().toISOString().slice(0, 13)}`,
    }).catch((err) => {
      log.warn('severe finding alert failed', { userId, err: err?.message });
      return { sent: false } as any;
    });

    if (result?.sent) {
      sent += 1;
      stamped.push(...items.map((f) => f.id));
    }
  }

  // Only what actually went out. A finding stamped without a confirmed send is
  // a finding nobody will ever be told about again.
  if (stamped.length) await markNotified(stamped);
  return { sent, findings: stamped.length };
}

/**
 * The daily digest — SUPERSEDED 2026-08-10 by `brainMaturityReport`.
 *
 * Kept because it is a working fallback if the maturity report cannot build a
 * snapshot, and deleting a path that still has a caller is how silent gaps
 * appear. Not scheduled.
 *
 * Deliberately includes the good news. A report that only ever arrives when
 * something is wrong trains the reader to dread it; one that says "12 asks
 * tracked, all answered, nothing stalled" is how he learns the system is
 * actually working without opening anything.
 */
export async function sendDailyDigest(clientNumber: string, userId: number): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 3600_000);

  const [openFindings, healed, evals, stalledAsks] = await Promise.all([
    prisma.brainHealthFinding.count({ where: { clientNumber, status: 'open' } }).catch(() => 0),
    prisma.brainHealthFinding.count({
      where: { clientNumber, status: 'healed', healedAt: { gte: since } },
    }).catch(() => 0),
    prisma.brainResponseEvaluation.findMany({
      where: { clientNumber, userId, evaluatedAt: { gte: since } },
      select: { overallScore: true, weakCriteria: true },
    }).catch(() => [] as Array<{ overallScore: number; weakCriteria: string[] }>),
    prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM delegation_threads
        WHERE client_number = $1 AND owner_notified_at IS NULL
          AND EXISTS (SELECT 1 FROM delegation_thread_events e
                       WHERE e.thread_id = delegation_threads.id AND e.event_type = 'inbound_received')`,
      clientNumber,
    ).then((r) => r[0]?.n ?? 0).catch(() => 0),
  ]);

  // Nothing happened and nothing is wrong — say nothing. A daily message with
  // no content is how a channel becomes noise.
  if (evals.length === 0 && openFindings === 0 && healed === 0 && stalledAsks === 0) return false;

  const avg = evals.length
    ? Math.round(evals.reduce((a, e) => a + e.overallScore, 0) / evals.length)
    : null;
  const weak = evals.filter((e) => e.overallScore < 70).length;

  // Which criterion is costing the most, by count. This is the single most
  // actionable line in the digest — it names the behaviour to fix.
  const criterionCounts = new Map<string, number>();
  for (const e of evals) for (const c of e.weakCriteria) criterionCounts.set(c, (criterionCounts.get(c) ?? 0) + 1);
  const worst = [...criterionCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  const lines = [
    evals.length ? `${evals.length} replies, average ${avg}/100${weak ? `, ${weak} below standard` : ' — all in band'}` : null,
    worst ? `weakest area: ${worst[0]} (${worst[1]}×)` : null,
    stalledAsks ? `${stalledAsks} ask(s) answered but not yet passed to you` : null,
    healed ? `${healed} problem(s) I fixed myself` : null,
    openFindings ? `${openFindings} still open` : null,
  ].filter(Boolean).join('\n');

  const { brainContactsUser } = await import('../notifications/brainOutboundService');
  const r = await brainContactsUser({
    userId,
    kind: 'brain_daily_digest',
    summary: 'Daily check on how I did',
    body: `How I did in the last 24 hours:\n\n${lines}\n\nAsk me about any of these if you want the detail.`,
    urgency: 'low',
    channel: 'text',
    dedupKey: `digest:${userId}:${new Date().toISOString().slice(0, 10)}`,
  }).catch((err) => {
    log.warn('daily digest failed', { userId, err: err?.message });
    return { sent: false } as any;
  });

  return !!r?.sent;
}

/**
 * One pass across active tenants. Registered on the job runner's lease so it
 * runs once per cluster, not once per replica.
 */
export async function runFindingNotifyPass(digestHourPkt: number): Promise<{ alerts: number; digests: number }> {
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true } as any,
    select: { clientNumber: true },
  }).catch(() => [] as Array<{ clientNumber: string }>);

  // PKT is UTC+5. The digest fires in the hour that matches locally, and the
  // dedup key is date-stamped so a second pass inside the same hour cannot
  // send it twice.
  const hourPkt = (new Date().getUTCHours() + 5) % 24;
  const digestDue = hourPkt === digestHourPkt;

  let alerts = 0;
  let digests = 0;

  for (const t of tenants) {
    const r = await notifySevereFindings(t.clientNumber).catch(() => ({ sent: 0, findings: 0 }));
    alerts += r.sent;

    if (digestDue) {
      // Per active user of the tenant — the digest is about THEIR conversation,
      // and pooling users would report one person's replies to another.
      const users = await prisma.user.findMany({
        where: { clientNumber: t.clientNumber, isActive: true },
        select: { id: true },
      }).catch(() => [] as Array<{ id: number }>);
      for (const u of users) {
        // The maturity report supersedes the plain digest (owner ruling
        // 2026-08-10). It compares yesterday with the day before — never a
        // partial today — and is NEVER silent: "nothing changed" is itself the
        // message, because a heartbeat that only beats on change is not a
        // heartbeat.
        const { sendMaturityReport } = await import('./brainMaturityReport');
        if (await sendMaturityReport(t.clientNumber, u.id).catch(() => false)) digests += 1;
      }
    }
  }
  return { alerts, digests };
}
