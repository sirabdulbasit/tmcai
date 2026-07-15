import { describe, it, expect, vi, beforeEach } from 'vitest';

// Staging-readiness rework (2026-07-14, items #3/#4): durable lease
// mutual exclusion + restart-proof atomic counters + honest crash
// evidence. The fake below emulates the two migrated tables so the
// EXACT SQL semantics (atomic increments, fenced lease upsert) are
// exercised, not just mocked away.

process.env.JOB_BACKOFF_BASE_MS = '5';

interface LeaseRow { owner: string; fence: number; expiresAt: number }
interface RunRow {
  job_class: string; last_started_at: Date | null; last_completed_at: Date | null;
  last_status: string | null; last_error: string | null; last_duration_ms: number | null;
  consecutive_failures: number; runs_completed: number; attempts_total: number;
}
const leases = new Map<string, LeaseRow>();
const runs = new Map<string, RunRow>();
let schemaMissing = false;

function fakeSql(sql: string, ...a: any[]): any {
  if (schemaMissing) throw new Error('relation "job_runs" does not exist (42P01)');
  if (sql.includes('INSERT INTO job_leases')) {
    const [name, owner, ttlMs] = a;
    const existing = leases.get(name);
    if (!existing) {
      leases.set(name, { owner, fence: 1, expiresAt: Date.now() + ttlMs });
      return [{ fence: 1n }];
    }
    if (existing.expiresAt < Date.now() || existing.owner === owner) {
      const next = { owner, fence: existing.fence + 1, expiresAt: Date.now() + ttlMs };
      leases.set(name, next);
      return [{ fence: BigInt(next.fence) }];
    }
    return []; // held by a live other owner
  }
  if (sql.includes('SELECT owner, fence FROM job_leases')) {
    const r = leases.get(a[0]);
    return r ? [{ owner: r.owner, fence: BigInt(r.fence) }] : [];
  }
  if (sql.includes('DELETE FROM job_leases')) {
    const r = leases.get(a[0]);
    if (r && r.owner === a[1] && BigInt(r.fence) === BigInt(a[2])) leases.delete(a[0]);
    return 1;
  }
  if (sql.includes('INSERT INTO job_runs')) {
    const [name, jobClass] = a;
    const r = runs.get(name) ?? {
      job_class: jobClass, last_started_at: null, last_completed_at: null, last_status: null,
      last_error: null, last_duration_ms: null, consecutive_failures: 0, runs_completed: 0, attempts_total: 0,
    };
    r.job_class = jobClass; r.last_started_at = new Date(); r.last_status = 'running';
    runs.set(name, r);
    return 1;
  }
  if (sql.includes("last_status = 'ok'")) {
    const r = runs.get(a[0])!;
    r.last_completed_at = new Date(); r.last_status = 'ok'; r.last_error = null;
    r.last_duration_ms = a[1]; r.consecutive_failures = 0;
    r.runs_completed += 1; r.attempts_total += a[2];
    return 1;
  }
  if (sql.includes("last_status = 'failed'") && sql.includes('RETURNING consecutive_failures')) {
    const r = runs.get(a[0])!;
    r.last_status = 'failed'; r.last_error = a[1]; r.last_duration_ms = a[2];
    r.consecutive_failures += 1; r.attempts_total += a[3];
    return [{ consecutive_failures: r.consecutive_failures }];
  }
  if (sql.includes('SET last_status = $2')) {
    const r = runs.get(a[0]);
    if (r) { r.last_status = a[1]; if (a[2]) r.last_error = a[2]; }
    return 1;
  }
  if (sql.includes('SELECT name, last_completed_at FROM job_runs')) {
    return [...runs.entries()]
      .filter(([n]) => (a[0] as string[]).includes(n))
      .map(([name, r]) => ({ name, last_completed_at: r.last_completed_at }));
  }
  if (sql.includes('FROM job_runs ORDER BY name')) {
    return [...runs.entries()].map(([name, r]) => ({ name, ...r }));
  }
  throw new Error(`fake DB: unhandled SQL: ${sql.slice(0, 60)}`);
}

vi.mock('../src/db/prisma', () => ({
  default: {
    $queryRawUnsafe: vi.fn(async (sql: string, ...a: any[]) => fakeSql(sql, ...a)),
    $executeRawUnsafe: vi.fn(async (sql: string, ...a: any[]) => fakeSql(sql, ...a)),
  },
}));

const sysLogCalls: any[] = [];
vi.mock('../src/services/systemLogService', () => ({
  log: vi.fn(async (e: any) => { sysLogCalls.push(e); }),
}));

import { protectedTick, getJobsHealth, evaluateMissedRuns, resetJobRunner, MAX_ATTEMPTS } from '../src/jobs/jobRunner';

beforeEach(() => {
  resetJobRunner();
  leases.clear();
  runs.clear();
  sysLogCalls.length = 0;
  schemaMissing = false;
});

describe('attempt semantics (documented: MAX_ATTEMPTS = TOTAL tries)', () => {
  it('maintenance = 1 total attempt, no retry', async () => {
    let n = 0;
    expect(await protectedTick('m', 'maintenance', async () => { n++; throw new Error('x'); })).toBe('failed');
    expect(n).toBe(1);
    expect(runs.get('m')!.attempts_total).toBe(1);
  });
  it('important = 3 total attempts and can recover on the 3rd', async () => {
    let n = 0;
    expect(await protectedTick('i', 'important', async () => { n++; if (n < 3) throw new Error('flaky'); })).toBe('ok');
    expect(n).toBe(3);
    expect(runs.get('i')!.attempts_total).toBe(3);
    expect(runs.get('i')!.runs_completed).toBe(1);
  });
  it('critical = 4 total attempts', async () => {
    expect(MAX_ATTEMPTS.critical).toBe(4);
    let n = 0;
    await protectedTick('c', 'critical', async () => { n++; throw new Error('down'); });
    expect(n).toBe(4);
  });
});

describe('restart-proof persisted counters (#3)', () => {
  it('runs_completed=42 persisted before restart stays monotonic', async () => {
    runs.set('day_brief', {
      job_class: 'critical', last_started_at: null, last_completed_at: new Date(),
      last_status: 'ok', last_error: null, last_duration_ms: 5,
      consecutive_failures: 0, runs_completed: 42, attempts_total: 50,
    });
    resetJobRunner(); // simulate process restart (in-memory wiped)
    await protectedTick('day_brief', 'critical', async () => {});
    expect(runs.get('day_brief')!.runs_completed).toBe(43); // never zeroed
  });

  it('persisted consecutive_failures=2 then one more failure = 3 and escalates exactly once', async () => {
    runs.set('j', {
      job_class: 'maintenance', last_started_at: null, last_completed_at: null,
      last_status: 'failed', last_error: 'old', last_duration_ms: 1,
      consecutive_failures: 2, runs_completed: 7, attempts_total: 9,
    });
    resetJobRunner();
    await protectedTick('j', 'maintenance', async () => { throw new Error('still down'); });
    expect(runs.get('j')!.consecutive_failures).toBe(3);
    expect(sysLogCalls).toHaveLength(1); // the crossing tick
    await protectedTick('j', 'maintenance', async () => { throw new Error('still down'); });
    expect(runs.get('j')!.consecutive_failures).toBe(4);
    expect(sysLogCalls).toHaveLength(1); // no re-escalation past the crossing
  });

  it('success resets the failure count', async () => {
    await protectedTick('r', 'maintenance', async () => { throw new Error('x'); });
    expect(runs.get('r')!.consecutive_failures).toBe(1);
    await protectedTick('r', 'maintenance', async () => {});
    expect(runs.get('r')!.consecutive_failures).toBe(0);
  });

  it('a crash/throw never records success; the running stamp is honest', async () => {
    await protectedTick('crash', 'maintenance', async () => { throw new Error('boom'); });
    const r = runs.get('crash')!;
    expect(r.last_status).toBe('failed');
    expect(r.runs_completed).toBe(0);
    expect(r.last_completed_at).toBeNull();
  });
});

describe('durable lease mutual exclusion (#4)', () => {
  it('a live lease held by another owner → skipped_no_lock, counters untouched', async () => {
    leases.set('job:x', { owner: 'other-host:1:abc', fence: 5, expiresAt: Date.now() + 60_000 });
    let ran = false;
    expect(await protectedTick('x', 'critical', async () => { ran = true; })).toBe('skipped_no_lock');
    expect(ran).toBe(false);
    expect(runs.has('x')).toBe(false); // non-leader skip does not mutate state
  });

  it('an EXPIRED lease from a crashed owner is reclaimed with a higher fence', async () => {
    leases.set('job:x', { owner: 'dead-host:9:zzz', fence: 5, expiresAt: Date.now() - 1000 });
    expect(await protectedTick('x', 'critical', async () => {})).toBe('ok');
    expect(runs.get('x')!.runs_completed).toBe(1);
  });

  it('losing the lease mid-run records lease_lost, never success', async () => {
    const outcome = await protectedTick('slow', 'critical', async () => {
      // Simulate expiry + takeover while the body runs.
      leases.set('job:slow', { owner: 'usurper:2:qqq', fence: 99, expiresAt: Date.now() + 60_000 });
    });
    expect(outcome).toBe('lease_lost');
    const r = runs.get('slow')!;
    expect(r.last_status).toBe('lease_lost');
    expect(r.runs_completed).toBe(0);
  });

  it('overlapping local ticks are skipped visibly', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const first = protectedTick('o', 'maintenance', async () => gate);
    expect(await protectedTick('o', 'maintenance', async () => {})).toBe('skipped_already_running');
    release();
    await first;
  });

  it('per-attempt timeout produces an honest failure', async () => {
    const outcome = await protectedTick('t', 'maintenance',
      () => new Promise((res) => setTimeout(res, 5_000)),
      { timeoutMs: 20, leaseTtlMs: 60_000 });
    expect(outcome).toBe('failed');
    expect(runs.get('t')!.last_error).toContain('timeout');
  }, 10_000);
});

describe('missing schema (#2 failure behavior)', () => {
  it('runs the body UNPROTECTED with a loud distinct outcome — never silent', async () => {
    schemaMissing = true;
    let ran = false;
    expect(await protectedTick('s', 'critical', async () => { ran = true; })).toBe('ran_unprotected_schema_missing');
    expect(ran).toBe(true);
  });

  it('health reports schemaAvailable:false and unknown, never healthy-by-absence', async () => {
    schemaMissing = true;
    await protectedTick('s', 'critical', async () => {});
    const h = await getJobsHealth();
    expect(h.schemaAvailable).toBe(false);
    expect((h.jobs[0] as any).status).toBe('unknown');
  });
});

describe('health + stale-running + catch-up scan', () => {
  it('a row stuck in running past the threshold surfaces as stale_running', async () => {
    runs.set('stuck', {
      job_class: 'critical', last_started_at: new Date(Date.now() - 45 * 60_000),
      last_completed_at: null, last_status: 'running', last_error: null, last_duration_ms: null,
      consecutive_failures: 0, runs_completed: 3, attempts_total: 3,
    });
    const h = await getJobsHealth();
    expect((h.jobs.find((j: any) => j.name === 'stuck') as any).status).toBe('stale_running');
  });

  it('evaluateMissedRuns flags a job whose last completion exceeds 2× cadence', async () => {
    runs.set('daily', {
      job_class: 'critical', last_started_at: null,
      last_completed_at: new Date(Date.now() - 3 * 24 * 3600_000),
      last_status: 'ok', last_error: null, last_duration_ms: 1,
      consecutive_failures: 0, runs_completed: 10, attempts_total: 10,
    });
    const missed = await evaluateMissedRuns([
      { name: 'daily', cadenceMs: 24 * 3600_000, policy: 'run_once_if_missed' },
      { name: 'daily', cadenceMs: 24 * 3600_000, policy: 'none' }, // policy none → ignored
    ]);
    expect(missed).toHaveLength(1);
    expect(missed[0].name).toBe('daily');
  });
});
