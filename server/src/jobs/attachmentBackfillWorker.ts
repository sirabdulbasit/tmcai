/**
 * attachmentBackfillWorker — drains the historical backlog of Gmail
 * feed_events whose attachments never got processed (because they were
 * ingested before the attachment hook existed).
 *
 * Scale properties (designed for 600+ users):
 *   - Per-user cursor in system_config: resumable across restarts.
 *   - Bounded per-cycle work: K users × N events per tick.
 *   - Per-user rate limit: sleep between attachment downloads to stay
 *     under Gmail's 250 quota-units/second/user cap.
 *   - Idempotent: `ingestMessageAttachments` upserts by attachment_id,
 *     so rerunning is safe.
 *   - Self-terminating: a user is marked complete when their cursor
 *     reaches the activation timestamp; worker skips completed users
 *     on future cycles.
 *   - New users joining AFTER activation: their ingest hook handles
 *     attachments live; backfill is a no-op for them.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { ingestMessageAttachments } from '../services/knowledge/attachmentWikiService';

const log = createLogger('attachment-backfill-worker');

const ACTIVATION_KEY = 'attachment_wiki_activated_at';
const CURSOR_PREFIX = 'attachment_backfill_cursor';
const DONE_PREFIX = 'attachment_backfill_done';
const STATUS_PREFIX = 'attachment_backfill_status';
/** Rough throughput used for ETA estimates. Measured at ~6 msg/sec with the
 *  150ms per-message pause and typical attachment size. */
const ESTIMATED_MSG_PER_SEC = 6;

const USERS_PER_CYCLE = 20;              // how many users we touch per tick
const EVENTS_PER_USER_PER_CYCLE = 30;    // bounded per tick so the worker never blocks too long
const PER_MSG_DELAY_MS = 150;             // gentle rate-limit per Gmail message

interface TenantUser { clientNumber: string; userId: number; email: string | null; }

async function getOrSetActivationTs(clientNumber: string): Promise<Date> {
  // Activation is stamped per tenant the first time the worker touches
  // it. Events older than the stamp are backfill candidates; events
  // newer than the stamp are handled live by the ingest hook.
  // system_config.client_number has an FK to tenants, so we can't use
  // a global sentinel — stamp it inside each tenant instead.
  const row = await prisma.systemConfig.findUnique({
    where: { clientNumber_key: { clientNumber, key: ACTIVATION_KEY } },
  }).catch(() => null);
  if (row?.value) return new Date(row.value);
  const now = new Date();
  await prisma.systemConfig.upsert({
    where: { clientNumber_key: { clientNumber, key: ACTIVATION_KEY } },
    update: { value: now.toISOString() },
    create: { clientNumber, key: ACTIVATION_KEY, value: now.toISOString() },
  }).catch(() => {});
  log.info('tenant activation stamp set', { clientNumber, activatedAt: now.toISOString() });
  return now;
}

async function getUserCursor(clientNumber: string, userId: number): Promise<{ cursor: Date | null; done: boolean }> {
  const [cursorRow, doneRow] = await Promise.all([
    prisma.systemConfig.findUnique({
      where: { clientNumber_key: { clientNumber, key: `${CURSOR_PREFIX}:${userId}` } },
    }).catch(() => null),
    prisma.systemConfig.findUnique({
      where: { clientNumber_key: { clientNumber, key: `${DONE_PREFIX}:${userId}` } },
    }).catch(() => null),
  ]);
  return {
    cursor: cursorRow?.value ? new Date(cursorRow.value) : null,
    done: doneRow?.value === 'true',
  };
}

async function setUserCursor(clientNumber: string, userId: number, cursor: Date): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { clientNumber_key: { clientNumber, key: `${CURSOR_PREFIX}:${userId}` } },
    update: { value: cursor.toISOString() },
    create: { clientNumber, key: `${CURSOR_PREFIX}:${userId}`, value: cursor.toISOString() },
  }).catch(() => {});
}

async function markUserDone(clientNumber: string, userId: number): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { clientNumber_key: { clientNumber, key: `${DONE_PREFIX}:${userId}` } },
    update: { value: 'true' },
    create: { clientNumber, key: `${DONE_PREFIX}:${userId}`, value: 'true' },
  }).catch(() => {});
  log.info('user marked complete', { clientNumber, userId });
}

/** Pick up to K users who have gmail connected and are not yet marked done. */
async function selectUsersForThisCycle(): Promise<TenantUser[]> {
  // Users with an active gmail connector; exclude ones flagged done in
  // system_config. Prioritize those with the oldest cursor (or no cursor).
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT u.id AS "userId", u.client_number AS "clientNumber", u.email,
            COALESCE(
              (SELECT value FROM system_config
                WHERE client_number = u.client_number
                  AND key = 'attachment_backfill_cursor:' || u.id),
              '1970-01-01T00:00:00Z'
            ) AS cursor_val,
            COALESCE(
              (SELECT value FROM system_config
                WHERE client_number = u.client_number
                  AND key = 'attachment_backfill_done:' || u.id),
              'false'
            ) AS done_val
       FROM users u
       JOIN user_connectors uc ON uc.user_id = u.id AND uc.client_number = u.client_number
       JOIN connector_types ct ON ct.id = uc.connector_type_id
      WHERE u.is_active = true
        AND ct.slug = 'gmail'
        AND uc.status = 'connected'
      ORDER BY done_val ASC, cursor_val ASC
      LIMIT $1`,
    USERS_PER_CYCLE,
  ).catch(() => []);

  return rows
    .filter((r) => r.done_val !== 'true')
    .map((r) => ({ clientNumber: r.clientNumber, userId: r.userId, email: r.email }));
}

async function processOneUser(
  user: TenantUser,
  activationTs: Date,
): Promise<{ processed: number; messagesWithAttachments: number; reachedCompletion: boolean }> {
  const { cursor } = await getUserCursor(user.clientNumber, user.userId);
  const startFrom = cursor ?? new Date(0);

  const events = await prisma.feedEvent.findMany({
    where: {
      clientNumber: user.clientNumber,
      userId: user.userId,
      sourceType: 'gmail',
      createdAt: { gt: startFrom, lt: activationTs },
    },
    select: { id: true, sourceId: true, rawPayload: true, senderEmail: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: EVENTS_PER_USER_PER_CYCLE,
  }).catch(() => [] as any[]);

  if (events.length === 0) {
    // No more events under the activation cutoff → this user is done.
    await markUserDone(user.clientNumber, user.userId);
    return { processed: 0, messagesWithAttachments: 0, reachedCompletion: true };
  }

  let messagesWithAttachments = 0;
  let processed = 0;
  for (const ev of events) {
    const p: any = ev.rawPayload ?? {};
    const messageId = p.messageId ?? p.gmailMessageId ?? ev.sourceId;
    if (!messageId) { processed++; continue; }
    try {
      const r = await ingestMessageAttachments({
        clientNumber: user.clientNumber,
        userId: user.userId,
        senderEmail: ev.senderEmail ?? null,
        gmailMessageId: messageId,
        feedEventId: ev.id,
        subject: p.subject ?? null,
        receivedAt: ev.createdAt,
      });
      if (r.total > 0) messagesWithAttachments += 1;
    } catch (err: any) {
      log.warn('attachment ingest failed', { feedEventId: ev.id, error: err.message });
    }
    processed++;
    // Gentle per-message pause to respect per-user Gmail quota.
    if (PER_MSG_DELAY_MS > 0) await new Promise((r) => setTimeout(r, PER_MSG_DELAY_MS));
  }

  // Advance cursor to the last event's createdAt.
  const last = events[events.length - 1].createdAt;
  await setUserCursor(user.clientNumber, user.userId, last);
  return { processed, messagesWithAttachments, reachedCompletion: false };
}

/** One backfill cycle: pick K users, process N events per user, update cursors. */
export async function runAttachmentBackfillCycle(): Promise<{
  users: number; processed: number; messagesWithAttachments: number; completed: number;
}> {
  const users = await selectUsersForThisCycle();
  if (users.length === 0) return { users: 0, processed: 0, messagesWithAttachments: 0, completed: 0 };

  let totalProcessed = 0;
  let totalMsgsWithAttachments = 0;
  let completed = 0;
  for (const u of users) {
    try {
      const activationTs = await getOrSetActivationTs(u.clientNumber);
      const r = await processOneUser(u, activationTs);
      totalProcessed += r.processed;
      totalMsgsWithAttachments += r.messagesWithAttachments;
      if (r.reachedCompletion) completed++;
    } catch (err: any) {
      log.warn('user cycle failed', { userId: u.userId, error: err.message });
    }
  }

  if (totalProcessed > 0 || completed > 0) {
    log.info('backfill cycle complete', {
      usersTouched: users.length,
      processed: totalProcessed,
      messagesWithAttachments: totalMsgsWithAttachments,
      completedThisCycle: completed,
    });
  }
  return {
    users: users.length,
    processed: totalProcessed,
    messagesWithAttachments: totalMsgsWithAttachments,
    completed,
  };
}

/** Kick off (or re-arm) the backfill for a single user immediately after
 *  they connect a source connector. Clears the done flag, stamps the
 *  tenant activation if missing, estimates an ETA, kicks off the first
 *  cycle in the background, and returns the ETA so the connect flow UI
 *  can show "~N minutes remaining". Safe to call multiple times. */
export async function triggerBackfillForUser(
  clientNumber: string,
  userId: number,
  opts?: { reason?: string },
): Promise<{ totalEvents: number; etaSeconds: number; startedAt: string }> {
  // Clear completion so the worker re-picks this user
  await prisma.systemConfig.upsert({
    where: { clientNumber_key: { clientNumber, key: `${DONE_PREFIX}:${userId}` } },
    update: { value: 'false' },
    create: { clientNumber, key: `${DONE_PREFIX}:${userId}`, value: 'false' },
  }).catch(() => {});

  const activationTs = await getOrSetActivationTs(clientNumber);

  const totalEvents = await prisma.feedEvent.count({
    where: {
      clientNumber, userId,
      sourceType: 'gmail',
      createdAt: { lt: activationTs },
    },
  }).catch(() => 0);

  const etaSeconds = totalEvents > 0 ? Math.ceil(totalEvents / ESTIMATED_MSG_PER_SEC) : 0;
  const status = {
    state: totalEvents > 0 ? 'queued' : 'complete',
    totalEvents,
    processed: 0,
    etaSeconds,
    startedAt: new Date().toISOString(),
    reason: opts?.reason ?? 'connector_connected',
  };

  await prisma.systemConfig.upsert({
    where: { clientNumber_key: { clientNumber, key: `${STATUS_PREFIX}:${userId}` } },
    update: { value: JSON.stringify(status) },
    create: { clientNumber, key: `${STATUS_PREFIX}:${userId}`, value: JSON.stringify(status) },
  }).catch(() => {});

  log.info('backfill triggered for user', { clientNumber, userId, totalEvents, etaSeconds, reason: status.reason });

  // Fire-and-forget immediate cycle — don't block the OAuth callback.
  if (totalEvents > 0) {
    void (async () => {
      try {
        await processOneUser({ clientNumber, userId, email: null }, activationTs);
      } catch (err: any) {
        log.warn('immediate cycle failed', { userId, error: err.message });
      }
    })();
  }

  return { totalEvents, etaSeconds, startedAt: status.startedAt };
}

export interface BackfillStatus {
  state: 'queued' | 'running' | 'complete' | 'unknown';
  totalEvents: number;
  processed: number;
  etaSeconds: number;
  startedAt: string | null;
  done: boolean;
}

/** Return the current backfill state for a user — used by the UI progress pill. */
export async function getBackfillStatusForUser(
  clientNumber: string,
  userId: number,
): Promise<BackfillStatus> {
  const [statusRow, doneRow, cursorRow] = await Promise.all([
    prisma.systemConfig.findUnique({
      where: { clientNumber_key: { clientNumber, key: `${STATUS_PREFIX}:${userId}` } },
    }).catch(() => null),
    prisma.systemConfig.findUnique({
      where: { clientNumber_key: { clientNumber, key: `${DONE_PREFIX}:${userId}` } },
    }).catch(() => null),
    prisma.systemConfig.findUnique({
      where: { clientNumber_key: { clientNumber, key: `${CURSOR_PREFIX}:${userId}` } },
    }).catch(() => null),
  ]);

  const done = doneRow?.value === 'true';
  let parsed: any = null;
  try { parsed = statusRow?.value ? JSON.parse(statusRow.value) : null; } catch {}

  if (done) {
    return {
      state: 'complete',
      totalEvents: parsed?.totalEvents ?? 0,
      processed: parsed?.totalEvents ?? 0,
      etaSeconds: 0,
      startedAt: parsed?.startedAt ?? null,
      done: true,
    };
  }

  if (!parsed) {
    return { state: 'unknown', totalEvents: 0, processed: 0, etaSeconds: 0, startedAt: null, done: false };
  }

  // Running: estimate "processed" from how far the cursor advanced.
  // Cheap proxy — exact count would require a db query per status check.
  const activationIso = (await prisma.systemConfig.findUnique({
    where: { clientNumber_key: { clientNumber, key: ACTIVATION_KEY } },
  }).catch(() => null))?.value;
  let processedEstimate = 0;
  if (cursorRow?.value && activationIso) {
    const cursorMs = new Date(cursorRow.value).getTime();
    const activationMs = new Date(activationIso).getTime();
    const startMs = new Date(parsed.startedAt).getTime();
    const span = Math.max(1, activationMs - startMs);
    const progressed = Math.max(0, cursorMs - startMs);
    processedEstimate = Math.min(parsed.totalEvents, Math.round((progressed / span) * parsed.totalEvents));
  }
  const remaining = Math.max(0, parsed.totalEvents - processedEstimate);
  const etaSeconds = Math.ceil(remaining / ESTIMATED_MSG_PER_SEC);

  return {
    state: cursorRow?.value ? 'running' : 'queued',
    totalEvents: parsed.totalEvents,
    processed: processedEstimate,
    etaSeconds,
    startedAt: parsed.startedAt,
    done: false,
  };
}

/** Schedule the worker — first tick 60s after start, then every 10 minutes. */
export function startAttachmentBackfillWorker(): void {
  const FIRST_TICK_MS = 60_000;
  const INTERVAL_MS = 10 * 60_000;
  setTimeout(() => {
    runAttachmentBackfillCycle().catch((e) => log.warn('first cycle failed', { error: e.message }));
    setInterval(() => {
      runAttachmentBackfillCycle().catch((e) => log.warn('cycle failed', { error: e.message }));
    }, INTERVAL_MS);
  }, FIRST_TICK_MS);
  log.info('attachment backfill worker scheduled', { firstTickMs: FIRST_TICK_MS, intervalMs: INTERVAL_MS });
}
