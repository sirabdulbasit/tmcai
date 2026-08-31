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
 *
 * THE WRITE ITSELF IS NOW GONE (2026-08-31) — see the second describe block. The guard tests
 * below are kept because they still describe real behaviour (a tenant-less call touches no
 * config), and the tenant-path tests are inverted into a guard against the blob returning.
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

/**
 * RESOLVED BY DELETION, 2026-08-31 — and these assertions are inverted rather than removed.
 *
 * DEF-112 guarded a write that should not have existed at all. The legacy `system_config` JSON
 * rollup was a SECOND COPY of the spend data, read-modify-written on every LLM call: load a
 * ~21 KB blob, bump one counter, write the whole row back. A grep for its `llm_spend`
 * system_config key found exactly one reader — the function that had just written it.
 *
 * It was also the store that UNDER-REPORTED, because it pruned to 62 days: the owner's
 * Jan-to-Aug monthly query returned ONE row, and the blob disagreed with the table by half on
 * the month they both covered ($289.98 against $587.19).
 *
 * So the tenant guard is moot — there is no rollup write left to guard. What still matters is
 * that the blob never comes BACK, because reintroducing it would reintroduce both the halved
 * number and the per-call write amplification. That is what these now assert. Deleting the two
 * obsolete tests instead would have left nothing watching the space they occupied.
 */
describe('the legacy system_config rollup stays gone', () => {
  it('writes NOTHING to system_config, even for a real tenant', async () => {
    await recordLlmSpend({ ...CALL, clientNumber: 'TMC-0001' });
    expect(configUpsert).not.toHaveBeenCalled();
    expect(configFindUnique).not.toHaveBeenCalled();
  });

  it('still records the primary row for a tenant call — the real record is untouched', async () => {
    await recordLlmSpend({ ...CALL, clientNumber: 'TMC-0001' });
    expect(spendCreate).toHaveBeenCalledTimes(1);
    expect(spendCreate.mock.calls[0][0].data.clientNumber).toBe('TMC-0001');
  });

  it('names no system_config key in the source, so the blob cannot creep back in', () => {
    const SRC = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'llmSpendService.ts'), 'utf8');
    // Comments explaining the removal are fine and wanted; executable references are not.
    const code = SRC.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toContain('systemConfig');
    expect(code).not.toContain("key: 'llm_spend'");
  });
});
