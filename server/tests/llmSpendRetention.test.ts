/**
 * llm_spend retention — OPT-001. The table was 561 MB of an 811 MB database, 91% of it older
 * than 30 days.
 *
 * WHY THESE TESTS ASSERT SQL TEXT, when llmSpendRange.test.ts deliberately does not.
 *
 * Its reasoning is right for shaping: pinning the text of a GROUP BY only restates the
 * implementation. But two things here are not implementation details, they are the contract that
 * makes retention safe, and both fail SILENTLY and PLAUSIBLY when broken:
 *
 *   1. READING `llm_spend` INSTEAD OF `llm_spend_unified`. The bare table no longer holds
 *      anything older than the retention window. A reader pointed at it returns a smaller number,
 *      not an error — the cost page would simply show less spend than happened, which is the
 *      precise defect OPT-001 is named after and which already shipped once (a JSON blob that
 *      under-reported by half, $289.98 against $587.19).
 *
 *   2. `COUNT(*)` INSTEAD OF `SUM(calls)`. Each view row over an archived day stands for ~2110
 *      calls, so COUNT(*) counts dimension tuples. Measured on the real backfill: 2,382,156 raw
 *      calls collapse to 1,129 rows. A page reporting 1,129 calls where 2.4M happened is wrong by
 *      three orders of magnitude and looks entirely reasonable on screen.
 *
 * Neither mistake is caught by a mocked-at-the-boundary shaping test, because the mock returns
 * whatever rows the test hands it regardless of the query. So the query itself is the assertion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const raw = vi.fn();
const exec = vi.fn();
const tx = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: {
    $queryRawUnsafe: (...a: any[]) => raw(...a),
    $executeRawUnsafe: (...a: any[]) => exec(...a),
    $transaction: (...a: any[]) => tx(...a),
    llmSpend: { create: vi.fn() },
    systemConfig: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import {
  getSpendReport, getTimeline, getByUser, getByPurpose, getByProvider,
  getAnomaly, getPerTenant, sweepLlmSpendRetention,
} from '../src/services/llmSpendService';

/** Every SQL string the service handed to the driver during one call. */
const sqlSeen = () => raw.mock.calls.map((c) => String(c[0]));

beforeEach(() => { raw.mockReset(); exec.mockReset(); tx.mockReset(); raw.mockResolvedValue([]); });

describe('every reader goes through the view, never the bare table', () => {
  const readers: Array<[string, () => Promise<unknown>]> = [
    ['getTimeline',    () => getTimeline('TMC-0001', 30)],
    ['getByUser',      () => getByUser('TMC-0001', 30, 10)],
    ['getByPurpose',   () => getByPurpose('TMC-0001', 30, 10)],
    ['getByProvider',  () => getByProvider('TMC-0001', 30)],
    ['getAnomaly',     () => getAnomaly('TMC-0001')],
    ['getPerTenant',   () => getPerTenant(30)],
    ['getSpendReport', () => getSpendReport('TMC-0001', '2026-05-01', '2026-08-31', 'month')],
  ];

  for (const [name, run] of readers) {
    it(`${name} reads llm_spend_unified`, async () => {
      await run();
      const sql = sqlSeen();
      expect(sql.length).toBeGreaterThan(0);
      for (const q of sql) {
        expect(q).toContain('llm_spend_unified');
        // The bare table must not appear. `llm_spend_unified` contains the substring
        // `llm_spend`, so match the table name only where it is NOT followed by `_`.
        expect(q).not.toMatch(/\bllm_spend(?!_)/);
      }
    });

    it(`${name} counts calls with SUM(calls), not COUNT(*)`, async () => {
      await run();
      for (const q of sqlSeen()) {
        expect(q).not.toMatch(/COUNT\(\*\)/i);
      }
    });
  }

  it('groups on the day column, not on a timestamp that the view does not expose', async () => {
    await getSpendReport('TMC-0001', '2026-05-01', '2026-08-31', 'month');
    for (const q of sqlSeen()) {
      expect(q).not.toContain('created_at');
      expect(q).toContain('day');
    }
  });
});

describe('the retention sweep', () => {
  /**
   * The CALLBACK form is required, and this test exists because the array form shipped first and
   * failed on its first production run.
   *
   * `db/prisma.ts` wraps `$executeRawUnsafe` to attribute DEF-085's raw-query failures, and a
   * wrapped method is no longer a `PrismaPromise`, so `$transaction([p1, p2])` is rejected with
   * "All elements of the array need to be Prisma Client promises". That same file's
   * `$transaction` override re-installs the observers only on a `tx` passed to a callback.
   *
   * So this asserts the callback shape, not just the ordering — the ordering was already right
   * in the version that did not work at all.
   */
  const txRunner = () => {
    tx.mockImplementation(async (fn: any) => {
      if (typeof fn !== 'function') throw new Error('array form is rejected by the wrapped client');
      return fn({ $executeRawUnsafe: (...a: any[]) => exec(...a) });
    });
    exec.mockImplementation(async (sql: string) => (String(sql).includes('INSERT') ? 1129 : 2382156));
  };

  it('passes a FUNCTION to $transaction, not an array of promises', async () => {
    txRunner();
    const out = await sweepLlmSpendRetention(30);

    expect(tx).toHaveBeenCalledTimes(1);
    expect(typeof tx.mock.calls[0][0]).toBe('function');
    // Proof it actually ran rather than failing open to zeroes.
    expect(out.rolledRows).toBe(1129);
    expect(out.deletedRows).toBe(2382156);
  });

  it('rolls up BEFORE deleting, on the transaction client', async () => {
    // The ordering is the safety property: a delete that could run without its rollup would
    // destroy that day's spend outright.
    txRunner();
    await sweepLlmSpendRetention(30);

    const [first, second] = exec.mock.calls.map((c) => String(c[0]));
    expect(first).toContain('INSERT INTO llm_spend_daily');
    expect(second).toContain('DELETE FROM llm_spend');
    // ON CONFLICT is what makes a re-run recompute rather than double-count.
    expect(first).toContain('ON CONFLICT');
  });

  it('deletes and rolls up at the SAME cutoff, so no day can fall between them', async () => {
    txRunner();
    await sweepLlmSpendRetention(30);

    const [insert, del] = exec.mock.calls.map((c) => String(c[0]));
    const boundary = /CURRENT_DATE - \(INTERVAL '1 day' \* 30\)/;
    expect(insert).toMatch(boundary);
    expect(del).toMatch(boundary);
  });

  it('refuses a nonsensical retention window instead of deleting everything', async () => {
    // A 0 or negative window would mean "archive today and delete it", which would empty the raw
    // table on every pass and hand the anomaly check nothing to compare against.
    txRunner();
    for (const bad of [0, -5, Number.NaN]) {
      exec.mockClear();
      await sweepLlmSpendRetention(bad as number);
      const sql = exec.mock.calls.map((c) => String(c[0])).join('\n');
      expect(sql).toContain("INTERVAL '1 day' * 30");
    }
  });

  it('never throws into the job loop — a failed sweep reports zero and leaves data alone', async () => {
    // It runs on the hourly self-heal pass. Throwing would take down the pass, and the pass does
    // other repairs; a sweep that cannot run is not a reason to stop healing.
    tx.mockRejectedValue(new Error('deadlock detected'));
    await expect(sweepLlmSpendRetention(30)).resolves.toEqual({
      rolledRows: 0, deletedRows: 0, cutoff: '',
    });
  });
});
