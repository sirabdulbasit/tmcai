import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hardening audit 2026-07-14, item #5 — allowlisted self-healing.
// These tests drive the EXECUTOR (runRepairRule) with fake rules and a
// mocked audit table, locking the safety semantics: precondition-first,
// attempt caps, cooldown, verify-or-it-didn't-happen, escalation.

interface FakeRow { rule_id: string; client_number: string | null; outcome: string; created_at: Date }
const auditRows: FakeRow[] = [];

vi.mock('../src/db/prisma', () => ({
  default: {
    $executeRawUnsafe: vi.fn(async (sql: string, ...args: any[]) => {
      if (sql.includes('INSERT INTO self_heal_log')) {
        auditRows.push({ rule_id: args[0], client_number: args[1], outcome: args[2], created_at: new Date() });
      }
      return 0;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string, ...args: any[]) => {
      if (sql.includes('COUNT(*)') && sql.includes('self_heal_log')) {
        const dayAgo = Date.now() - 24 * 3600_000;
        const hits = auditRows.filter((r) =>
          r.rule_id === args[0] &&
          (args[1] == null || r.client_number === args[1]) &&
          ['healed', 'verify_failed', 'apply_failed'].includes(r.outcome) &&
          r.created_at.getTime() >= dayAgo);
        return [{ n: hits.length, last_at: hits.length ? hits[hits.length - 1].created_at : null }];
      }
      return [];
    }),
    tenant: { findMany: vi.fn(async () => [{ clientNumber: 'TMC-0001' }]) },
    userConnector: { findMany: vi.fn(async () => []) },
  },
}));

const sysLogCalls: any[] = [];
vi.mock('../src/services/systemLogService', () => ({
  log: vi.fn(async (e: any) => { sysLogCalls.push(e); }),
}));

import { runRepairRule, REPAIR_RULES, type RepairRule } from '../src/services/selfheal/repairService';

const mkRule = (over: Partial<RepairRule>): RepairRule => ({
  id: 'fake_rule',
  description: 'test rule',
  tenantScoped: false,
  maxAttemptsPerDay: 3,
  cooldownMin: 0,
  detect: async () => ({ summary: 'thing broken', before: { broken: 1 } }),
  apply: async () => ({ fixed: true }),
  verify: async () => true,
  ...over,
});

beforeEach(() => { auditRows.length = 0; sysLogCalls.length = 0; });

describe('runRepairRule — safety semantics', () => {
  it('healthy system: detect() null → nothing mutated, nothing logged', async () => {
    const apply = vi.fn();
    const r = await runRepairRule(mkRule({ detect: async () => null, apply: apply as any }), {});
    expect(r).toBe('nothing_to_repair');
    expect(apply).not.toHaveBeenCalled();
    expect(auditRows).toEqual([]);
  });

  it('successful repair records precondition, change, and verified outcome', async () => {
    const r = await runRepairRule(mkRule({}), { clientNumber: 'TMC-0001' });
    expect(r).toBe('healed');
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].outcome).toBe('healed');
  });

  it("failed verification is 'verify_failed' — NEVER reported healed", async () => {
    const r = await runRepairRule(mkRule({ verify: async () => false }), {});
    expect(r).toBe('verify_failed');
    expect(auditRows[0].outcome).toBe('verify_failed');
  });

  it('a throwing verify() counts as failed verification, not success', async () => {
    const r = await runRepairRule(mkRule({ verify: async () => { throw new Error('cannot check'); } }), {});
    expect(r).toBe('verify_failed');
  });

  it('apply() failure is recorded and does not claim healing', async () => {
    const r = await runRepairRule(mkRule({ apply: async () => { throw new Error('mutation failed'); } }), {});
    expect(r).toBe('apply_failed');
    expect(auditRows[0].outcome).toBe('apply_failed');
  });

  it('stops at the attempt cap and escalates to system_logs for a human', async () => {
    const rule = mkRule({ maxAttemptsPerDay: 2, verify: async () => false });
    expect(await runRepairRule(rule, {})).toBe('verify_failed');
    expect(await runRepairRule(rule, {})).toBe('verify_failed');
    const third = await runRepairRule(rule, {});
    expect(third).toBe('skipped_exhausted');
    expect(sysLogCalls).toHaveLength(1);
    expect(sysLogCalls[0].level).toBe('error');
    expect(sysLogCalls[0].message).toContain('Human action required');
  });

  it('cooldown suppresses immediate re-attempts', async () => {
    const rule = mkRule({ cooldownMin: 60, verify: async () => false });
    await runRepairRule(rule, {});
    expect(await runRepairRule(rule, {})).toBe('skipped_cooldown');
  });

  it('fails CLOSED when attempt bookkeeping is unavailable (counts as exhausted)', async () => {
    const prisma = (await import('../src/db/prisma')).default as any;
    prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('db down'));
    const apply = vi.fn();
    const r = await runRepairRule(mkRule({ apply: apply as any }), {});
    expect(r).toBe('skipped_exhausted');
    expect(apply).not.toHaveBeenCalled();
  });

  it('tenant-scoped attempts are counted per tenant', async () => {
    const rule = mkRule({ tenantScoped: true, maxAttemptsPerDay: 1, verify: async () => false });
    expect(await runRepairRule(rule, { clientNumber: 'TMC-0001' })).toBe('verify_failed');
    expect(await runRepairRule(rule, { clientNumber: 'TMC-0002' })).toBe('verify_failed'); // own budget
    expect(await runRepairRule(rule, { clientNumber: 'TMC-0001' })).toBe('skipped_exhausted');
  });
});

describe('the allowlist itself', () => {
  it('contains only the three known reversible repairs, each capped', () => {
    expect(REPAIR_RULES.map((r) => r.id).sort()).toEqual([
      'feed_dlq_replay', 'stale_connector_error_metadata', 'stuck_scribe_markers',
    ]);
    for (const r of REPAIR_RULES) {
      expect(r.maxAttemptsPerDay).toBeGreaterThan(0);
      expect(r.maxAttemptsPerDay).toBeLessThanOrEqual(24);
      expect(r.cooldownMin).toBeGreaterThanOrEqual(30);
    }
  });

  it('tenant-scoped DLQ replay refuses to run without a tenant', async () => {
    const dlq = REPAIR_RULES.find((r) => r.id === 'feed_dlq_replay')!;
    expect(await dlq.detect({})).toBeNull();
  });
});
