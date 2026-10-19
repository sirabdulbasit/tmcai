/**
 * DEF-342 `self-heal-repair-never-verifies` — a repair loop that never once
 * verifies escalates to an owner-visible finding, and the finding resolves on
 * the rule's first verified heal.
 *
 * Measured live (analyst, 10-16→10-19): `stuck_queued_prompt` applied its
 * repair hourly for DAYS on the same tenant (~23 verify-failures/day, zero
 * heals), correctly refusing to claim healed — and told nobody. Its budget
 * (24/day) allows its cadence, so the existing exhaustion escalation never
 * fires: inside-budget failure loops were structurally invisible.
 *
 * Under test:
 *  - at REPAIR_INEFFECTIVE_AFTER_VERIFY_FAILS verify-failures in 24h with
 *    ZERO heals in the window, an owner-visible `self_heal_repair_ineffective`
 *    finding is recorded (tenant-scoped for tenant rules, GLOBAL for global);
 *  - intermittent rules (any heal in the window) never escalate;
 *  - the first verified heal RESOLVES the open finding (the DEF-340 lesson
 *    applied at birth — no open "repair is not working" outlives the repair
 *    starting to work);
 *  - an unreadable ledger never escalates and never changes the outcome.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  logs: [] as Array<{ level: string; msg: string; meta?: any }>,
  vf: 0,
  healed: 0,
  streakThrows: false,
  findings: [] as any[],
  resolved: [] as any[],
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => {
    const mk = (level: string) => (msg: string, meta?: any) => state.logs.push({ level, msg, meta });
    return { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') };
  },
}));
vi.mock('../src/db/prisma', () => {
  let nextId = 1;
  const p: any = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('INSERT INTO self_heal_log')) return [{ id: BigInt(nextId++) }];
      if (sql.includes("FILTER (WHERE outcome = 'verify_failed')")) {
        if (state.streakThrows) throw new Error('ledger down');
        return [{ vf: state.vf, healed: state.healed }];
      }
      if (sql.includes('FROM self_heal_log')) return [{ n: 0, last_at: null, notified: 0 }];
      return [];
    },
    $executeRawUnsafe: async () => 1,
  };
  return { __esModule: true, default: p, prisma: p };
});
vi.mock('../src/services/selfheal/healthFindingService', () => ({
  recordFinding: async (input: any) => { state.findings.push(input); return 'finding-id'; },
  resolveOpenFindings: async (input: any) => { state.resolved.push(input); return 1; },
  SYSTEM_SCOPE: 'GLOBAL',
}));

import {
  runRepairRule, REPAIR_INEFFECTIVE_AFTER_VERIFY_FAILS, REPAIR_INEFFECTIVE_KIND,
  type RepairRule,
} from '../src/services/selfheal/repairService';

const mkRule = (over: Partial<RepairRule> = {}): RepairRule => ({
  id: 'def342_rule', description: 'test rule', scope: 'tenant',
  maxAttemptsPerDay: 50, cooldownMin: 0,
  detect: async () => ({ summary: '1 question queued over 30 min and never asked', before: {} }),
  apply: async () => ({}),
  verify: async () => false,
  ...over,
});

beforeEach(() => {
  state.logs = []; state.findings = []; state.resolved = [];
  state.vf = 0; state.healed = 0; state.streakThrows = false;
});

describe('DEF-342 — an inside-budget failure loop becomes an owner-visible finding', () => {
  it('at the threshold with ZERO heals in the window, a tenant-scoped finding is recorded with the counts on the record', async () => {
    state.vf = REPAIR_INEFFECTIVE_AFTER_VERIFY_FAILS;
    const outcome = await runRepairRule(mkRule(), { clientNumber: 'TMC-0001' });
    expect(outcome).toBe('verify_failed'); // the honest outcome is unchanged
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]).toMatchObject({
      clientNumber: 'TMC-0001',
      kind: REPAIR_INEFFECTIVE_KIND,
      severity: 'error',
      source: 'self-heal',
      subjectType: 'repair_rule',
      subjectId: 'def342_rule',
    });
    expect(state.findings[0].evidence.verifyFailed24h).toBe(REPAIR_INEFFECTIVE_AFTER_VERIFY_FAILS);
    expect(state.findings[0].summary).toContain('without one verified heal');
  });

  it('below the threshold nothing escalates — a few failures are retrying, not a loop', async () => {
    state.vf = REPAIR_INEFFECTIVE_AFTER_VERIFY_FAILS - 1;
    await runRepairRule(mkRule(), { clientNumber: 'TMC-0001' });
    expect(state.findings).toHaveLength(0);
  });

  it('an INTERMITTENT rule (any heal in the window) never escalates, however many failures', async () => {
    state.vf = REPAIR_INEFFECTIVE_AFTER_VERIFY_FAILS + 5;
    state.healed = 1;
    await runRepairRule(mkRule(), { clientNumber: 'TMC-0001' });
    expect(state.findings).toHaveLength(0);
  });

  it('the first verified heal RESOLVES the open finding — the DEF-340 lesson at birth', async () => {
    const outcome = await runRepairRule(mkRule({ verify: async () => true }), { clientNumber: 'TMC-0001' });
    expect(outcome).toBe('healed');
    expect(state.findings).toHaveLength(0);
    expect(state.resolved).toHaveLength(1);
    expect(state.resolved[0]).toMatchObject({
      clientNumber: 'TMC-0001',
      kind: REPAIR_INEFFECTIVE_KIND,
      subjectId: 'def342_rule',
    });
  });

  it('a GLOBAL rule escalates under the GLOBAL scope — never under a tenant it does not belong to', async () => {
    state.vf = REPAIR_INEFFECTIVE_AFTER_VERIFY_FAILS;
    await runRepairRule(mkRule({ id: 'def342_global', scope: 'global' }), {});
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0].clientNumber).toBe('GLOBAL');
  });

  it('an unreadable ledger never escalates on a guess and never changes the repair outcome', async () => {
    state.vf = REPAIR_INEFFECTIVE_AFTER_VERIFY_FAILS;
    state.streakThrows = true;
    const outcome = await runRepairRule(mkRule(), { clientNumber: 'TMC-0001' });
    expect(outcome).toBe('verify_failed');
    expect(state.findings).toHaveLength(0);
  });
});
