/**
 * C3 — Cluster-safe leader election for cron jobs.
 *
 * The scheduler uses in-process node-cron to fire jobs. When the API runs
 * with N worker replicas, every cron tick fires N times — duplicate emails,
 * duplicate engine runs, duplicate decision-outcome assessments. The fix
 * is a Postgres advisory lock keyed by job name: the first replica to grab
 * the lock runs the job; the others see `false` from `pg_try_advisory_lock`
 * and skip.
 *
 * Advisory locks are held by the session that took them (so an `EXECUTE`
 * via Prisma's $queryRaw needs `pg_advisory_lock` + `pg_advisory_unlock`
 * on the same connection — we do both inside `$transaction` to ensure
 * connection affinity). We use the txn-scoped `pg_try_advisory_xact_lock`
 * variant which auto-releases on COMMIT/ROLLBACK, eliminating the leak
 * window if the worker dies mid-job.
 */
import crypto from 'crypto';
import prisma from '../db/prisma';
import createLogger from './logger';

const log = createLogger('leader-lock');

/**
 * Hash a string job key into the (int4, int4) pair pg_try_advisory_lock
 * expects. Two ints give 64 bits of namespace, plenty for our cron jobs.
 */
function hashKey(key: string): { k1: number; k2: number } {
  const h = crypto.createHash('sha256').update(key).digest();
  // signed int4 range: -2^31 .. 2^31-1
  const k1 = h.readInt32BE(0);
  const k2 = h.readInt32BE(4);
  return { k1, k2 };
}

/**
 * Run `fn` on at most one cluster node per `key`. Other nodes log and skip.
 *
 * Uses `pg_try_advisory_xact_lock` inside a transaction — the lock is held
 * for the duration of `fn` and auto-released on commit/rollback, so a
 * worker crash never strands the lock.
 */
export async function runWithLeaderLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false; reason: 'not_leader' | 'error'; error?: string }> {
  const { k1, k2 } = hashKey(key);
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
        `SELECT pg_try_advisory_xact_lock(${k1}, ${k2}) AS locked`,
      );
      const locked = rows[0]?.locked === true;
      if (!locked) {
        return { ran: false as const, reason: 'not_leader' as const };
      }
      const result = await fn();
      return { ran: true as const, result };
    }, { timeout: 600_000 }); // 10 min — long enough for the heaviest cron
  } catch (err: any) {
    log.error('Leader-lock execution failed', { key, error: err.message });
    return { ran: false as const, reason: 'error' as const, error: err.message };
  }
}

/**
 * Convenience: schedule-friendly wrapper. Call inside a `cron.schedule`
 * callback. Logs whether this replica was leader for the tick.
 */
export async function leaderOnly(key: string, fn: () => Promise<void>): Promise<void> {
  const r = await runWithLeaderLock(key, fn);
  if (r.ran === false && r.reason === 'not_leader') {
    log.debug('Skipping cron tick — another replica is leader', { key });
  }
}
