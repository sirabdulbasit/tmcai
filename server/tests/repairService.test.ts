import { describe, it, expect, vi, beforeEach } from 'vitest';

// Self-heal framework — staging-readiness rework (item #12):
// audit-first (no mutation without a ledger row), scope-correct
// budgets, visible detect failures, deduped exhaustion escalation.

interface AuditRow {
  id: number; rule_id: string; scope: string; client_number: string | null;
  outcome: string; created_at: Date;
}
const auditRows: AuditRow[] = [];
let nextId = 1;
let ledgerDown = false;

function fakeSql(sql: string, ...a: any[]): any {
  if (ledgerDown && sql.includes('self_heal_log')) throw new Error('relation "self_heal_log" does not exist');
  if (sql.includes('INSERT INTO self_heal_log')) {
    const row: AuditRow = { id: nextId++, rule_id: a[0], scope: a[1], client_number: a[2], outcome: a[3], created_at: new Date() };
    auditRows.push(row);
    return [{ id: BigInt(row.id) }];
  }
  if (sql.includes('UPDATE self_heal_log SET outcome')) {
    const row = auditRows.find((r) => BigInt(r.id) === BigInt(a[0]));
    if (row) row.outcome = a[1];
    return 1;
  }
  if (sql.includes('FROM self_heal_log') && sql.includes('FILTER')) {
    const dayAgo = Date.now() - 24 * 3600_000;
    const scopeGlobal = sql.includes('client_number IS NULL');
    const hits = auditRows.filter((r) =>
      r.rule_id === a[0] &&
      (scopeGlobal ? r.client_number === null : r.client_number === a[1]) &&
      r.created_at.getTime() >= dayAgo);
    const attempts = hits.filter((r) => ['healed', 'verify_failed', 'apply_failed'].includes(r.outcome));
    return [{
      n: attempts.length,
      last_at: attempts.length ? attempts[attempts.length - 1].created_at : null,
      notified: hits.filter((r) => r.outcome === 'skipped_exhausted').length,
    }];
  }
  throw new Error(`fake DB: unhandled SQL: ${sql.slice(0, 60)}`);
}

vi.mock('../src/db/prisma', () => ({
  default: {
    $queryRawUnsafe: vi.fn(async (sql: string, ...a: any[]) => fakeSql(sql, ...a)),
    $executeRawUnsafe: vi.fn(async (sql: string, ...a: any[]) => fakeSql(sql, ...a)),
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
  scope: 'global',
  maxAttemptsPerDay: 3,
  cooldownMin: 0,
  detect: async () => ({ summary: 'thing broken', before: { broken: 1 } }),
  apply: async () => ({ fixed: true }),
  verify: async () => true,
  ...over,
});

beforeEach(() => { auditRows.length = 0; nextId = 1; ledgerDown = false; sysLogCalls.length = 0; });

describe('runRepairRule — safety semantics', () => {
  it('healthy system: detect() null → nothing mutated, nothing logged', async () => {
    const apply = vi.fn();
    const r = await runRepairRule(mkRule({ detect: async () => null, apply: apply as any }), {});
    expect(r).toBe('nothing_to_repair');
    expect(apply).not.toHaveBeenCalled();
    expect(auditRows).toEqual([]);
  });

  it('detect() THROWING is a visible detect_failed, never "nothing to repair"', async () => {
    const apply = vi.fn();
    const r = await runRepairRule(mkRule({ detect: async () => { throw new Error('detector broke'); }, apply: apply as any }), {});
    expect(r).toBe('detect_failed');
    expect(apply).not.toHaveBeenCalled();
    expect(auditRows[0].outcome).toBe('detect_failed');
  });

  it('AUDIT-FIRST: the ledger row exists before apply(), pessimistically apply_failed', async () => {
    let outcomeAtApplyTime = '';
    const r = await runRepairRule(mkRule({
      apply: async () => { outcomeAtApplyTime = auditRows[0]?.outcome; return { ok: 1 }; },
    }), {});
    expect(r).toBe('healed');
    expect(outcomeAtApplyTime).toBe('apply_failed'); // crash mid-apply leaves honest evidence
    expect(auditRows[0].outcome).toBe('healed');     // finalized after verify
  });

  it('ledger unavailable → audit_unavailable and NO mutation', async () => {
    ledgerDown = true;
    const apply = vi.fn();
    const r = await runRepairRule(mkRule({ apply: apply as any }), {});
    expect(r).toBe('audit_unavailable');
    expect(apply).not.toHaveBeenCalled();
  });

  it("failed verification is 'verify_failed' — NEVER healed", async () => {
    const r = await runRepairRule(mkRule({ verify: async () => false }), {});
    expect(r).toBe('verify_failed');
    expect(auditRows[0].outcome).toBe('verify_failed');
  });

  it('a throwing verify() counts as failed verification', async () => {
    expect(await runRepairRule(mkRule({ verify: async () => { throw new Error('x'); } }), {})).toBe('verify_failed');
  });

  it('stops at the attempt cap and escalates ONCE per 24h window', async () => {
    const rule = mkRule({ maxAttemptsPerDay: 2, verify: async () => false });
    await runRepairRule(rule, {});
    await runRepairRule(rule, {});
    expect(await runRepairRule(rule, {})).toBe('skipped_exhausted');
    expect(await runRepairRule(rule, {})).toBe('skipped_exhausted'); // again next hour…
    expect(sysLogCalls).toHaveLength(1); // …but the human is pinged once
  });

  it('cooldown suppresses immediate re-attempts', async () => {
    const rule = mkRule({ cooldownMin: 60, verify: async () => false });
    await runRepairRule(rule, {});
    expect(await runRepairRule(rule, {})).toBe('skipped_cooldown');
  });

  it('TENANT budgets are isolated: tenant A cannot consume tenant B\'s', async () => {
    const rule = mkRule({ scope: 'tenant', maxAttemptsPerDay: 1, verify: async () => false });
    expect(await runRepairRule(rule, { clientNumber: 'TMC-0001' })).toBe('verify_failed');
    expect(await runRepairRule(rule, { clientNumber: 'TMC-0002' })).toBe('verify_failed'); // own budget
    expect(await runRepairRule(rule, { clientNumber: 'TMC-0001' })).toBe('skipped_exhausted');
    expect(await runRepairRule(rule, { clientNumber: 'TMC-0002' })).toBe('skipped_exhausted');
  });

  it('a tenant-scoped rule without a tenant does nothing', async () => {
    const apply = vi.fn();
    expect(await runRepairRule(mkRule({ scope: 'tenant', apply: apply as any }), {})).toBe('nothing_to_repair');
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('the allowlist itself', () => {
  it('contains only the three known reversible repairs, each capped and scoped', () => {
    expect(REPAIR_RULES.map((r) => r.id).sort()).toEqual([
      'feed_dlq_replay', 'stale_connector_error_metadata', 'stuck_scribe_markers',
    ]);
    for (const r of REPAIR_RULES) {
      expect(['global', 'tenant']).toContain(r.scope);
      expect(r.maxAttemptsPerDay).toBeGreaterThan(0);
      expect(r.maxAttemptsPerDay).toBeLessThanOrEqual(24);
      expect(r.cooldownMin).toBeGreaterThanOrEqual(30);
    }
  });

  it('DLQ replay is tenant-scoped, claims atomically (SKIP LOCKED) and verifies exact ids', () => {
    const dlq = REPAIR_RULES.find((r) => r.id === 'feed_dlq_replay')!;
    expect(dlq.scope).toBe('tenant');
    const src = dlq.apply.toString() + dlq.verify.toString();
    expect(src).toContain('FOR UPDATE SKIP LOCKED');
    expect(src).toContain('requeuedIds');
    expect(src).toContain('ANY($2::int[])'); // id-exact verification
  });

  it('DLQ verify returns false when nothing was claimed (empty claim ≠ healed)', async () => {
    const dlq = REPAIR_RULES.find((r) => r.id === 'feed_dlq_replay')!;
    expect(await dlq.verify({ clientNumber: 'TMC-0001' }, { summary: '', before: {} }, { requeuedIds: [] })).toBe(false);
  });
});
