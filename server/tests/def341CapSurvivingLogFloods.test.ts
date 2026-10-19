/**
 * DEF-341 — the two surviving uncapped log floods now log through the ONE
 * shared gate (DEF-334 (2) extended to the chokepoints it did not cover).
 *
 * Measured while uncapped (analyst, 10-16→10-19):
 *  - `[fetchThreadContext] no client in user map` — ~960/day (899/963/960),
 *    ~40x/hour around the clock from the logged-out WhatsApp session
 *    (DEF-317). The single largest surviving log source after D-122.
 *  - `repair applied but verification FAILED — not claiming healed` — ~23/day,
 *    hourly forever, same rule + tenant (stuck_queued_prompt).
 *
 * Both say the same thing after the first few lines; only volume grows. The
 * cap bounds EMISSION only: fetchThreadContext still returns [], every repair
 * attempt still lands in self_heal_log, and the count survives in
 * occurrences/suppressedLastWindow. Deliberately the SAME windowedLogGate as
 * DEF-334 (2) — a second gate implementation would be the 11th
 * `protection-with-two-implementations`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const state = vi.hoisted(() => ({
  logs: [] as Array<{ name: string; level: string; msg: string; meta?: any }>,
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: (name: string) => {
    const mk = (level: string) => (msg: string, meta?: any) => state.logs.push({ name, level, msg, meta });
    return { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') };
  },
}));
vi.mock('../src/db/prisma', () => {
  let nextId = 1;
  const p: any = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('INSERT INTO self_heal_log')) return [{ id: BigInt(nextId++) }];
      if (sql.includes('FROM self_heal_log')) return [{ n: 0, last_at: null, notified: 0 }];
      return [];
    },
    $executeRawUnsafe: async () => 1,
  };
  return { __esModule: true, default: p, prisma: p };
});

import { runRepairRule, type RepairRule } from '../src/services/selfheal/repairService';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const VERIFY_FAILED_MSG = 'repair applied but verification FAILED — not claiming healed';

beforeEach(() => { state.logs = []; });

describe('DEF-341 — surviving floods are bounded, counting preserved', () => {
  it('a repair that NEVER verifies logs at most 5 lines per rule+scope per window while every attempt stays ledgered', async () => {
    const applies: number[] = [];
    const rule: RepairRule = {
      id: 'def341_never_verifies', description: 'test rule', scope: 'tenant',
      maxAttemptsPerDay: 50, cooldownMin: 0,
      detect: async () => ({ summary: 'one stuck row', before: {} }),
      apply: async () => { applies.push(1); return {}; },
      verify: async () => false,
    };
    for (let i = 0; i < 8; i++) {
      const outcome = await runRepairRule(rule, { clientNumber: 'TMC-0001' });
      expect(outcome).toBe('verify_failed'); // behaviour untouched — only emission is gated
    }
    expect(applies).toHaveLength(8); // the repair itself still ran every time
    const lines = state.logs.filter((l) => l.msg === VERIFY_FAILED_MSG);
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => l.meta.occurrences)).toEqual([1, 2, 3, 4, 5]);
  });

  it('distinct rules and tenants are gated independently — a new failure is never hidden behind an old one', async () => {
    const mkRule = (id: string): RepairRule => ({
      id, description: 'test rule', scope: 'tenant',
      maxAttemptsPerDay: 50, cooldownMin: 0,
      detect: async () => ({ summary: 'stuck', before: {} }),
      apply: async () => ({}),
      verify: async () => false,
    });
    for (let i = 0; i < 6; i++) await runRepairRule(mkRule('def341_rule_a'), { clientNumber: 'TMC-0001' });
    await runRepairRule(mkRule('def341_rule_b'), { clientNumber: 'TMC-0001' });
    await runRepairRule(mkRule('def341_rule_a'), { clientNumber: 'TMC-0002' });
    const lines = state.logs.filter((l) => l.msg === VERIFY_FAILED_MSG);
    // rule_a@TMC-0001 capped at 5; rule_b and the other tenant each logged their first
    expect(lines).toHaveLength(7);
    expect(lines[5].meta.rule).toBe('def341_rule_b');
    expect(lines[6].meta.clientNumber).toBe('TMC-0002');
  });

  it('fetchThreadContext no-client (~960/day from the dead session) is gated per user per hour at the call site', () => {
    const src = read('../src/services/whatsapp/UserWebjsProvider.ts');
    expect(src).toContain("import { windowedLogGate } from '../../utils/boundedLog'");
    expect(src).toMatch(/const gate = noClientLogGate\(String\(userId\)\);\s*\n\s*if \(gate\.log\)/);
    expect(src).toMatch(/windowedLogGate\(NO_CLIENT_LOG_CAP, 60 \* 60 \* 1000\)/);
    // the ungated call is gone — nothing in the no-client branch logs outside the gate
    expect(src).not.toMatch(/log\.warn\('\[fetchThreadContext\] no client in user map', \{ userId, chatId \}\);/);
  });

  it('both sites use the ONE shared gate from utils/boundedLog — no second implementation', () => {
    for (const rel of ['../src/services/whatsapp/UserWebjsProvider.ts', '../src/services/selfheal/repairService.ts']) {
      const src = read(rel);
      expect(src).toContain("from '../../utils/boundedLog'");
      expect(src).not.toMatch(/windowStart:\s*number;\s*count:\s*number/); // no inline re-implementation
    }
  });
});
