/**
 * DEF-112 — the legacy spend rollup wrote to a tenant that does not exist.
 *
 * Production, 2026-08-10, four times inside one owner turn (11:39:01, :03, :05,
 * :07 — once per LLM call), all day:
 *
 *   llm-spend: "spend record (legacy) failed"
 *     -> Invalid prisma.systemConfig.upsert()
 *     -> Foreign key constraint violated: system_config_client_number_fkey
 *
 * recordLlmSpend defaults clientNumber to the string 'SYSTEM'.
 * system_config.client_number references tenants(client_number), and tenants
 * holds exactly one row: TMC-0001. So every tenant-less call attempted a rollup
 * under a non-existent tenant and was rejected.
 *
 * Nothing was lost — the primary llm_spend row (write 1) succeeds — but the
 * failure was four log lines per conversation turn, and it is what made this FK
 * look like a feature-flag problem on first inspection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const spendCreate = vi.fn();
const configUpsert = vi.fn();
const configFindUnique = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    llmSpend: { create: (...a: any[]) => spendCreate(...a) },
    systemConfig: {
      upsert: (...a: any[]) => configUpsert(...a),
      findUnique: (...a: any[]) => configFindUnique(...a),
    },
  },
}));

import { recordLlmSpend } from '../src/services/llmSpendService';

const CALL = { provider: 'gemini', purpose: 'criticality_fuse', inputTokens: 100, outputTokens: 50 } as any;

beforeEach(() => {
  spendCreate.mockReset().mockResolvedValue({});
  configUpsert.mockReset().mockResolvedValue({});
  configFindUnique.mockReset().mockResolvedValue(null);
});

describe('a tenant-less call no longer writes an impossible rollup', () => {
  it('does NOT touch system_config when no clientNumber is given', async () => {
    await recordLlmSpend({ ...CALL });
    expect(configUpsert).not.toHaveBeenCalled();
  });

  it('still records the primary spend row — no data is lost', async () => {
    await recordLlmSpend({ ...CALL });
    expect(spendCreate).toHaveBeenCalledTimes(1);
    expect(spendCreate.mock.calls[0][0].data.provider).toBe('gemini');
  });
});

describe('a real tenant still gets its rollup', () => {
  it('writes system_config for TMC-0001', async () => {
    await recordLlmSpend({ ...CALL, clientNumber: 'TMC-0001' });
    expect(configUpsert).toHaveBeenCalledTimes(1);
    const arg = configUpsert.mock.calls[0][0];
    expect(arg.where.clientNumber_key.clientNumber).toBe('TMC-0001');
    expect(arg.where.clientNumber_key.key).toBe('llm_spend');
  });

  it('records the primary row for a tenant call too', async () => {
    await recordLlmSpend({ ...CALL, clientNumber: 'TMC-0001' });
    expect(spendCreate).toHaveBeenCalledTimes(1);
  });
});

describe('the guard is a real early return, not a swallowed error', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'llmSpendService.ts'), 'utf8');

  it('returns before the upsert rather than catching its failure', () => {
    const guardAt = SRC.indexOf('if (!p.clientNumber) return;');
    const upsertAt = SRC.indexOf('await prisma.systemConfig.upsert(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(upsertAt);
  });
});
