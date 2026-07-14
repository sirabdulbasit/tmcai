/**
 * jobRunner — reliability wrapper for background jobs (hardening audit
 * 2026-07-14, item #4).
 *
 * The ~45 raw setInterval jobs in server.ts had: no cross-replica
 * protection (safe only because PM2 runs instances:1), no persisted
 * run history ("did day-brief fire today?" was unanswerable), and
 * near-universally swallowed errors. This wrapper gives any job:
 *
 *   - LEADER LOCK: pg advisory xact-lock (utils/leaderLock) so two
 *     replicas can never execute the same protected tick concurrently.
 *     Crash-safe: xact-scoped locks vanish with the session.
 *   - PERSISTED STATE: one row per job in `job_runs` (unmanaged raw
 *     table, same pattern as system_logs) — last started/completed,
 *     status, duration, consecutive failures, total runs. A crash
 *     mid-run leaves status='running' with no completed stamp — an
 *     honest record, never a false completion.
 *   - BOUNDED RETRIES: important=2, critical=3 attempts with
 *     exponential backoff inside the tick; maintenance never retries.
 *   - FAILURE VISIBILITY: 3+ consecutive failures → system_logs entry
 *     (surfaces in the admin health endpoint + escalation sweep).
 *   - NO CRASHES: a throwing job can never take the process down.
 *
 * Usage (wrap the BODY, keep existing interval wiring):
 *   setInterval(() => { protectedTick('day_brief_dispatch', 'critical',
 *     () => runDayBriefDispatch()); }, 60_000);
 *
 * Jobs stay idempotent by their own design (dedup keys, idempotency
 * logs) — the runner adds mutual exclusion and bookkeeping, it does
 * not change job semantics.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { runWithLeaderLock } from '../utils/leaderLock';

const log = createLogger('job-runner');

export type JobClass = 'maintenance' | 'important' | 'critical';

const RETRIES: Record<JobClass, number> = { maintenance: 0, important: 2, critical: 3 };
const BACKOFF_BASE_MS = 5_000;
const FAILURE_ESCALATION_THRESHOLD = 3;

interface JobState {
  jobClass: JobClass;
  running: boolean;
  lastStartedAt?: Date;
  lastCompletedAt?: Date;
  lastStatus?: 'ok' | 'failed' | 'skipped_no_lock' | 'running';
  lastError?: string;
  lastDurationMs?: number;
  consecutiveFailures: number;
  runsCompleted: number;
}

const jobs = new Map<string, JobState>();

let tableEnsured = false;
async function ensureJobRunsTable(): Promise<void> {
  if (tableEnsured) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS job_runs (
      name TEXT PRIMARY KEY,
      job_class TEXT NOT NULL DEFAULT 'maintenance',
      last_started_at TIMESTAMPTZ,
      last_completed_at TIMESTAMPTZ,
      last_status TEXT,
      last_error TEXT,
      last_duration_ms INTEGER,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      runs_completed BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  tableEnsured = true;
}

async function persist(name: string, s: JobState): Promise<void> {
  try {
    await ensureJobRunsTable();
    await prisma.$executeRawUnsafe(
      `INSERT INTO job_runs (name, job_class, last_started_at, last_completed_at, last_status, last_error, last_duration_ms, consecutive_failures, runs_completed, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (name) DO UPDATE SET
         job_class = EXCLUDED.job_class,
         last_started_at = EXCLUDED.last_started_at,
         last_completed_at = EXCLUDED.last_completed_at,
         last_status = EXCLUDED.last_status,
         last_error = EXCLUDED.last_error,
         last_duration_ms = EXCLUDED.last_duration_ms,
         consecutive_failures = EXCLUDED.consecutive_failures,
         runs_completed = EXCLUDED.runs_completed,
         updated_at = NOW()`,
      name, s.jobClass,
      s.lastStartedAt ?? null, s.lastCompletedAt ?? null,
      s.lastStatus ?? null, (s.lastError ?? '').slice(0, 500) || null,
      s.lastDurationMs ?? null, s.consecutiveFailures, s.runsCompleted,
    );
  } catch (e: any) {
    log.warn('job state persist failed (non-fatal)', { name, error: e?.message });
  }
}

/** Run one protected tick of a named job. Never throws. Returns the
 *  outcome so callers can log if they care. */
export async function protectedTick(
  name: string,
  jobClass: JobClass,
  fn: () => Promise<unknown>,
): Promise<'ok' | 'failed' | 'skipped_no_lock' | 'skipped_already_running'> {
  const state = jobs.get(name) ?? {
    jobClass, running: false, consecutiveFailures: 0, runsCompleted: 0,
  };
  jobs.set(name, state);
  state.jobClass = jobClass;

  // In-process re-entrancy guard (a slow tick outliving its interval).
  if (state.running) return 'skipped_already_running';
  state.running = true;

  try {
    const res = await runWithLeaderLock(`job:${name}`, async () => {
      state.lastStartedAt = new Date();
      state.lastStatus = 'running';
      await persist(name, state);

      const started = Date.now();
      const maxAttempts = RETRIES[jobClass] + 1;
      let lastErr: any;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await fn();
          state.lastCompletedAt = new Date();
          state.lastStatus = 'ok';
          state.lastError = undefined;
          state.lastDurationMs = Date.now() - started;
          state.consecutiveFailures = 0;
          state.runsCompleted += 1;
          await persist(name, state);
          return 'ok' as const;
        } catch (e: any) {
          lastErr = e;
          if (attempt < maxAttempts) {
            const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1);
            log.warn('job attempt failed — retrying', { name, attempt, backoffMs: backoff, error: e?.message });
            await new Promise((r) => setTimeout(r, backoff));
          }
        }
      }
      state.lastStatus = 'failed';
      state.lastError = String(lastErr?.message ?? lastErr);
      state.lastDurationMs = Date.now() - started;
      state.consecutiveFailures += 1;
      await persist(name, state);
      log.error('job failed after retries', { name, jobClass, failures: state.consecutiveFailures, error: state.lastError });
      if (state.consecutiveFailures >= FAILURE_ESCALATION_THRESHOLD) {
        try {
          const { log: sysLog } = await import('../services/systemLogService');
          await sysLog({
            level: 'error', category: 'job_failure', source: `jobRunner:${name}`,
            message: `background job "${name}" (${jobClass}) has failed ${state.consecutiveFailures} consecutive times: ${state.lastError}`,
          } as any);
        } catch { /* health endpoint still shows it */ }
      }
      return 'failed' as const;
    });
    if (!res.ran) {
      // Another replica holds the lease (fine) or the lock layer errored.
      return res.reason === 'not_leader' ? 'skipped_no_lock' : 'failed';
    }
    return res.result;
  } catch (e: any) {
    // Lock acquisition itself failed (DB down) — never crash the server.
    log.warn('protected tick could not run', { name, error: e?.message });
    return 'failed';
  } finally {
    state.running = false;
  }
}

/** In-memory snapshot merged with persisted rows — for the admin
 *  health endpoint. Rows persisted by a previous process appear even
 *  before this process has ticked them. */
export async function getJobsHealth(): Promise<Array<Record<string, unknown>>> {
  let rows: any[] = [];
  try {
    await ensureJobRunsTable();
    rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT name, job_class, last_started_at, last_completed_at, last_status,
              last_error, last_duration_ms, consecutive_failures, runs_completed
         FROM job_runs ORDER BY name`,
    );
  } catch { /* fall back to in-memory only */ }
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const [name, s] of jobs) {
    if (!byName.has(name)) {
      byName.set(name, {
        name, job_class: s.jobClass,
        last_started_at: s.lastStartedAt ?? null,
        last_completed_at: s.lastCompletedAt ?? null,
        last_status: s.lastStatus ?? null, last_error: s.lastError ?? null,
        last_duration_ms: s.lastDurationMs ?? null,
        consecutive_failures: s.consecutiveFailures, runs_completed: s.runsCompleted,
      });
    }
  }
  return [...byName.values()];
}

/** Test hook. */
export function resetJobRunner(): void {
  jobs.clear();
}
