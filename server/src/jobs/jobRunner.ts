/**
 * jobRunner — reliability wrapper for background jobs (hardening audit
 * 2026-07-14 #4; reworked same day for staging-readiness items #2–#4).
 *
 * What every protected job gets:
 *
 *   - DURABLE LEASE mutual exclusion (job_leases table, migration
 *     20260714_ops_hardening). Replaces the transaction-held pg
 *     advisory lock: job bodies call slow external providers, and
 *     holding a Prisma transaction (and its pooled connection) open
 *     across those calls was unbounded. A lease row is acquired in ONE
 *     atomic upsert, carries owner + monotonic fence + expiry, is
 *     reclaimable after expiry, and is re-verified after the body runs
 *     — an owner that lost its lease mid-run records 'lease_lost'
 *     instead of claiming a protected completion.
 *
 *   - PERSISTED, RESTART-PROOF state (job_runs): counters are mutated
 *     with atomic SQL (`runs_completed = runs_completed + 1`), never
 *     overwritten from in-memory zeros, so `runs_completed` is
 *     monotonic across restarts and `consecutive_failures` keeps
 *     accumulating toward escalation after a crash. A run writes
 *     'running' + started stamp BEFORE the body executes; completion
 *     is written only on terminal success/failure — a crash leaves an
 *     honest 'running' row that health reports as stale.
 *
 *   - ATTEMPT SEMANTICS (documented + tested): MAX_ATTEMPTS is the
 *     TOTAL number of tries per tick, first attempt included —
 *     maintenance 1, important 3, critical 4 — with exponential
 *     backoff between attempts. attempts_total counts every attempt;
 *     runs_completed counts successful ticks only.
 *
 *   - ESCALATION: the tick that moves consecutive_failures onto the
 *     threshold (3) escalates to system_logs exactly once per crossing
 *     (the atomic RETURNING value decides — replica-safe).
 *
 *   - NO RUNTIME DDL (#2): schema comes from the migration. If the
 *     tables are missing, that is a LOUD operational failure — the
 *     body still runs (an outage of day-brief because a ledger table
 *     is absent would be worse), but every tick logs an error, the
 *     run is recorded nowhere, and getJobsHealth() reports
 *     schemaAvailable:false with status 'unknown' — never healthy.
 */
import os from 'os';
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('job-runner');

export type JobClass = 'maintenance' | 'important' | 'critical';

/** TOTAL attempts per tick (first attempt included). */
export const MAX_ATTEMPTS: Record<JobClass, number> = { maintenance: 1, important: 3, critical: 4 };
// Read at call time so tests can shrink it (ESM import hoisting runs
// module constants before test-file env assignments).
const backoffBaseMs = () => Number(process.env.JOB_BACKOFF_BASE_MS ?? 5_000);
export const FAILURE_ESCALATION_THRESHOLD = 3;
const DEFAULT_LEASE_TTL_MS = 10 * 60_000;
const STALE_RUNNING_AFTER_MS = 30 * 60_000;

/** Stable per-process owner identity for leases. */
const OWNER = `${os.hostname()}:${process.pid}:${Date.now().toString(36)}`;

interface LocalJobState { jobClass: JobClass; running: boolean }
const jobs = new Map<string, LocalJobState>();

/** Flips false on the first undefined_table error — health then reports
 *  'unknown', never healthy-by-absence. */
let schemaAvailable: boolean | null = null; // null = not yet probed

function isMissingSchemaError(e: any): boolean {
  const msg = String(e?.message ?? e ?? '');
  return e?.code === 'P2010' && /42P01/.test(JSON.stringify(e?.meta ?? {}))
    || /relation "(job_runs|job_leases)" does not exist/i.test(msg)
    || /42P01/.test(msg);
}

// ── Lease primitives (one atomic statement each) ────────────────────

async function acquireLease(name: string, ttlMs: number): Promise<{ fence: bigint } | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ fence: bigint }>>(
    `INSERT INTO job_leases (name, owner, expires_at)
     VALUES ($1, $2, NOW() + make_interval(secs => $3::float / 1000))
     ON CONFLICT (name) DO UPDATE
       SET owner = $2,
           fence = job_leases.fence + 1,
           acquired_at = NOW(),
           expires_at = NOW() + make_interval(secs => $3::float / 1000)
       WHERE job_leases.expires_at < NOW() OR job_leases.owner = $2
     RETURNING fence`,
    `job:${name}`, OWNER, ttlMs,
  );
  return rows[0] ?? null; // no row = another live owner holds it
}

async function leaseStillOurs(name: string, fence: bigint): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ owner: string; fence: bigint }>>(
    `SELECT owner, fence FROM job_leases WHERE name = $1`, `job:${name}`,
  ).catch(() => []);
  const r = rows[0];
  return Boolean(r && r.owner === OWNER && BigInt(r.fence) === BigInt(fence));
}

async function releaseLease(name: string, fence: bigint): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM job_leases WHERE name = $1 AND owner = $2 AND fence = $3`,
    `job:${name}`, OWNER, fence,
  ).catch(() => { /* expiry reclaims it */ });
}

// ── Run-ledger writes (all atomic; counters never overwritten) ──────

async function markStarted(name: string, jobClass: JobClass): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO job_runs (name, job_class, last_started_at, last_status, updated_at)
     VALUES ($1, $2, NOW(), 'running', NOW())
     ON CONFLICT (name) DO UPDATE
       SET job_class = $2, last_started_at = NOW(), last_status = 'running', updated_at = NOW()`,
    name, jobClass,
  );
}

async function markSuccess(name: string, durationMs: number, attempts: number): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE job_runs SET
       last_completed_at = NOW(), last_status = 'ok', last_error = NULL,
       last_duration_ms = $2,
       consecutive_failures = 0,
       runs_completed = runs_completed + 1,
       attempts_total = attempts_total + $3,
       updated_at = NOW()
     WHERE name = $1`,
    name, durationMs, attempts,
  );
}

/** Returns the NEW consecutive_failures value (drives exactly-once
 *  escalation at the crossing, replica-safe). */
async function markFailure(name: string, durationMs: number, attempts: number, error: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ consecutive_failures: number }>>(
    `UPDATE job_runs SET
       last_status = 'failed', last_error = $2, last_duration_ms = $3,
       consecutive_failures = consecutive_failures + 1,
       attempts_total = attempts_total + $4,
       updated_at = NOW()
     WHERE name = $1
     RETURNING consecutive_failures`,
    name, error.slice(0, 500), durationMs, attempts,
  );
  return rows[0]?.consecutive_failures ?? 0;
}

async function markStatus(name: string, status: string, error?: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE job_runs SET last_status = $2, last_error = COALESCE($3, last_error), updated_at = NOW() WHERE name = $1`,
    name, status, error?.slice(0, 500) ?? null,
  ).catch(() => {});
}

// ── The protected tick ──────────────────────────────────────────────

export interface ProtectedTickOpts {
  /** Lease TTL — set above the job's worst-case duration. Default 10 min. */
  leaseTtlMs?: number;
  /** Per-attempt timeout. Default: leaseTtl − 60s (min 60s). NOTE: JS
   *  cannot cancel the underlying work — on timeout the attempt is
   *  recorded failed and the lease expiry lets another replica take
   *  over; if the orphaned body later finishes, the post-run lease
   *  check records 'lease_lost' instead of success. */
  timeoutMs?: number;
}

export type TickOutcome =
  | 'ok' | 'failed' | 'skipped_no_lock' | 'skipped_already_running'
  | 'lease_lost' | 'ran_unprotected_schema_missing';

export async function protectedTick(
  name: string,
  jobClass: JobClass,
  fn: () => Promise<unknown>,
  opts: ProtectedTickOpts = {},
): Promise<TickOutcome> {
  const state = jobs.get(name) ?? { jobClass, running: false };
  jobs.set(name, state);
  state.jobClass = jobClass;

  // In-process re-entrancy guard: a tick outliving its interval is
  // skipped VISIBLY (debug log + distinct outcome), never overlapped.
  if (state.running) {
    log.warn('tick overlap — previous tick still running, skipping', { name });
    return 'skipped_already_running';
  }
  state.running = true;

  const ttl = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? Math.max(60_000, ttl - 60_000);

  try {
    let lease: { fence: bigint } | null;
    try {
      lease = await acquireLease(name, ttl);
      schemaAvailable = true;
    } catch (e: any) {
      if (isMissingSchemaError(e)) {
        // #2 failure behavior: schema missing is a LOUD operational
        // failure. The body still runs (job outage would compound the
        // problem) but nothing pretends to be protected or persisted.
        schemaAvailable = false;
        log.error('JOB SCHEMA MISSING — migration 20260714_ops_hardening not applied. Running UNPROTECTED (no lease, no ledger). Apply migrations.', { name, error: e?.message });
        try { await fn(); } catch (err: any) {
          log.error('unprotected job body failed', { name, error: err?.message });
        }
        return 'ran_unprotected_schema_missing';
      }
      log.warn('lease acquisition failed (DB unavailable) — skipping tick', { name, error: e?.message });
      return 'failed';
    }
    if (!lease) return 'skipped_no_lock'; // another live replica holds the lease

    try {
      await markStarted(name, jobClass);

      const started = Date.now();
      const maxAttempts = MAX_ATTEMPTS[jobClass];
      let lastErr: any;
      let attempts = 0;
      let succeeded = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        try {
          await Promise.race([
            fn(),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`job timeout after ${timeoutMs}ms`)), timeoutMs).unref?.()),
          ]);
          succeeded = true;
          break;
        } catch (e: any) {
          lastErr = e;
          if (attempt < maxAttempts) {
            const backoff = backoffBaseMs() * 2 ** (attempt - 1);
            log.warn('job attempt failed — retrying', { name, attempt, maxAttempts, backoffMs: backoff, error: e?.message });
            await new Promise((r) => setTimeout(r, backoff));
          }
        }
      }
      const durationMs = Date.now() - started;

      // Fenced post-check: if the lease expired (or was reclaimed)
      // while the body ran, this owner must not record a protected
      // completion — the work may have overlapped a successor.
      if (!(await leaseStillOurs(name, lease.fence))) {
        log.error('lease lost during run — outcome recorded as lease_lost, not success', { name, durationMs });
        await markStatus(name, 'lease_lost', 'lease expired mid-run; possible overlap with another replica');
        return 'lease_lost';
      }

      if (succeeded) {
        await markSuccess(name, durationMs, attempts);
        return 'ok';
      }

      const failures = await markFailure(name, durationMs, attempts, String(lastErr?.message ?? lastErr));
      log.error('job failed after all attempts', { name, jobClass, attempts, consecutiveFailures: failures, error: String(lastErr?.message ?? lastErr).slice(0, 200) });
      if (failures === FAILURE_ESCALATION_THRESHOLD) {
        try {
          const { log: sysLog } = await import('../services/systemLogService');
          await sysLog({
            level: 'error', category: 'job_failure', source: `jobRunner:${name}`,
            message: `background job "${name}" (${jobClass}) has failed ${failures} consecutive times: ${String(lastErr?.message ?? lastErr).slice(0, 200)}`,
          } as any);
        } catch { /* ledger row still shows it */ }
      }
      return 'failed';
    } finally {
      await releaseLease(name, lease.fence);
    }
  } catch (e: any) {
    // Absolute backstop — a job wrapper must never crash the server.
    log.error('protected tick wrapper error', { name, error: e?.message });
    return 'failed';
  } finally {
    state.running = false;
  }
}

// ── Health ──────────────────────────────────────────────────────────

/** Ledger snapshot for /admin/system-health. Rows persisted by a
 *  previous process appear immediately (no in-memory zeros). A row
 *  stuck in 'running' past STALE_RUNNING_AFTER_MS is surfaced as
 *  'stale_running' (crash evidence, #3). Missing schema → explicit
 *  schemaAvailable:false + 'unknown', never healthy-by-absence. */
export async function getJobsHealth(): Promise<{ schemaAvailable: boolean; jobs: Array<Record<string, unknown>> }> {
  let rows: any[] = [];
  try {
    rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT name, job_class, last_started_at, last_completed_at, last_status,
              last_error, last_duration_ms, consecutive_failures, runs_completed, attempts_total
         FROM job_runs ORDER BY name`,
    );
    schemaAvailable = true;
  } catch (e: any) {
    if (isMissingSchemaError(e)) schemaAvailable = false;
    return { schemaAvailable: false, jobs: [...jobs.keys()].map((name) => ({ name, status: 'unknown', reason: 'job_runs schema unavailable' })) };
  }
  const now = Date.now();
  return {
    schemaAvailable: true,
    jobs: rows.map((r) => ({
      ...r,
      runs_completed: Number(r.runs_completed),
      attempts_total: Number(r.attempts_total),
      status: r.last_status === 'running' && r.last_started_at && now - new Date(r.last_started_at).getTime() > STALE_RUNNING_AFTER_MS
        ? 'stale_running'
        : r.last_status ?? 'unknown',
    })),
  };
}

/** #6 — boot-time missed-run scan. Compares each registered job's last
 *  successful completion against its cadence and LOGS the missed
 *  window; the actual catch-up execution is each job's own first tick
 *  (every registered job runs shortly after boot, and outbound jobs
 *  carry durable dedup keys, so "run the normal tick now" IS the safe
 *  bounded catch-up). Policy per job is documented in
 *  docs/background_jobs_inventory.md. */
export async function evaluateMissedRuns(
  expected: Array<{ name: string; cadenceMs: number; policy: 'none' | 'run_once_if_missed' }>,
): Promise<Array<{ name: string; missedMs: number }>> {
  const missed: Array<{ name: string; missedMs: number }> = [];
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT name, last_completed_at FROM job_runs WHERE name = ANY($1::text[])`,
      expected.map((e) => e.name),
    );
    const byName = new Map(rows.map((r) => [r.name, r.last_completed_at ? new Date(r.last_completed_at).getTime() : null]));
    for (const e of expected) {
      if (e.policy === 'none') continue;
      const last = byName.get(e.name);
      if (last == null) continue; // never ran — first tick covers it
      const gap = Date.now() - last;
      if (gap > e.cadenceMs * 2) {
        missed.push({ name: e.name, missedMs: gap });
        log.warn('missed-run detected — first post-boot tick will catch up (dedup-bounded)', {
          name: e.name, missedMinutes: Math.round(gap / 60_000), policy: e.policy,
        });
      }
    }
  } catch { /* schema missing already reported elsewhere */ }
  return missed;
}

/** Test hook. */
export function resetJobRunner(): void {
  jobs.clear();
  schemaAvailable = null;
}
