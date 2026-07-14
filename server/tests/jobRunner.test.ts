import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hardening audit 2026-07-14, item #4 — protectedTick semantics:
// leader-locked, persisted, bounded retries by class, failure
// escalation, never throws.

const executed: string[] = [];
let lockAvailable = true;

vi.mock('../src/db/prisma', () => ({
  default: {
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));

vi.mock('../src/utils/leaderLock', () => ({
  runWithLeaderLock: vi.fn(async (_key: string, fn: () => Promise<any>) => {
    if (!lockAvailable) return { ran: false, reason: 'not_leader' };
    return { ran: true, result: await fn() };
  }),
}));

const sysLogCalls: any[] = [];
vi.mock('../src/services/systemLogService', () => ({
  log: vi.fn(async (entry: any) => { sysLogCalls.push(entry); }),
}));

import { protectedTick, getJobsHealth, resetJobRunner } from '../src/jobs/jobRunner';

beforeEach(() => {
  resetJobRunner();
  executed.length = 0;
  sysLogCalls.length = 0;
  lockAvailable = true;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe('protectedTick', () => {
  it('runs the job and reports ok', async () => {
    const r = await protectedTick('t1', 'critical', async () => { executed.push('ran'); });
    expect(r).toBe('ok');
    expect(executed).toEqual(['ran']);
  });

  it('maintenance jobs never retry; a single failure is final', async () => {
    let attempts = 0;
    const r = await protectedTick('t2', 'maintenance', async () => { attempts++; throw new Error('boom'); });
    expect(r).toBe('failed');
    expect(attempts).toBe(1);
  });

  it('critical jobs retry with backoff and can recover', async () => {
    vi.useRealTimers(); // backoff sleeps for real; keep failures to 1 (5s)
    let attempts = 0;
    const r = await protectedTick('t3', 'critical', async () => {
      attempts++;
      if (attempts < 2) throw new Error('flaky');
    });
    expect(r).toBe('ok');
    expect(attempts).toBe(2);
  }, 20_000);

  it('does not run when another replica holds the lease', async () => {
    lockAvailable = false;
    const r = await protectedTick('t4', 'critical', async () => { executed.push('should-not-run'); });
    expect(r).toBe('skipped_no_lock');
    expect(executed).toEqual([]);
  });

  it('a tick that outlives its interval is not re-entered in-process', async () => {
    vi.useRealTimers();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const slow = protectedTick('t5', 'maintenance', async () => { await gate; });
    const second = await protectedTick('t5', 'maintenance', async () => { executed.push('reentrant'); });
    expect(second).toBe('skipped_already_running');
    release();
    await slow;
    expect(executed).toEqual([]);
  });

  it('3 consecutive failures escalate to system_logs', async () => {
    for (let i = 0; i < 3; i++) {
      await protectedTick('t6', 'maintenance', async () => { throw new Error('persistent'); });
    }
    expect(sysLogCalls.length).toBe(1);
    expect(sysLogCalls[0].category).toBe('job_failure');
    expect(sysLogCalls[0].message).toContain('t6');
    expect(sysLogCalls[0].message).toContain('3 consecutive');
  });

  it('a throwing job never propagates — the server cannot crash', async () => {
    await expect(
      protectedTick('t7', 'maintenance', async () => { throw new Error('unhandled'); }),
    ).resolves.toBe('failed');
  });

  it('health snapshot exposes per-job state', async () => {
    await protectedTick('good', 'important', async () => {});
    await protectedTick('bad', 'maintenance', async () => { throw new Error('x'); });
    const health = await getJobsHealth();
    const byName = new Map(health.map((h: any) => [h.name, h]));
    expect((byName.get('good') as any).last_status).toBe('ok');
    expect((byName.get('good') as any).runs_completed).toBe(1);
    expect((byName.get('bad') as any).last_status).toBe('failed');
    expect((byName.get('bad') as any).consecutive_failures).toBe(1);
  });
});
