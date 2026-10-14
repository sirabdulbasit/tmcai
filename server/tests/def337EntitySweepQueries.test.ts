/**
 * DEF-337 `entity-sweep-query-never-ran` — two raw queries in
 * `entitySweepService.ts` that had NEVER succeeded, shipped behind silent
 * `.catch(() => [])`:
 *  - `getRecentTopics`: `SELECT DISTINCT … ORDER BY MAX(created_at)` — 42P10
 *    (aggregate in ORDER BY, no GROUP BY) on every call since it shipped;
 *  - `getActiveOpenItems`: `SELECT DISTINCT oi.id, … ORDER BY oi.created_at`
 *    — 42P10 (order column not in the DISTINCT select list).
 * Effect: the Memory capability ("what has this sender emailed about / what
 * items came from them") silently returned EMPTY on every call, while the
 * raw-query layer flooded the error log (~18,760 lines on 10-13 alone — the
 * owner's own DEF-334 flood symptom, returned from a new source).
 *
 * Under test (mocked prisma captures the SQL — these pin the FIXED shapes
 * and the behaviours around them):
 *  - recent-topics SQL uses GROUP BY (which provides distinctness) and no
 *    SELECT DISTINCT; the aggregate ordering is licensed; tenant + sender
 *    params are passed; results are normalised (Re:/Fwd: stripped);
 *  - active-items SQL has NO DISTINCT (oi.id is the PK; the join is on a
 *    single-valued FK, so rows are unique) and orders by oi.created_at;
 *  - a blank email never queries (no key, no claim);
 *  - both still fail OPEN on a genuine DB error — enrichment degrades to
 *    empty, never throws into the sweep.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: any[] }>,
  rows: [] as any[],
  throwOnQuery: false,
}));

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0, groupBy: async () => [],
  };
  const p: any = new Proxy(
    {
      $queryRawUnsafe: async (sql: string, ...params: any[]) => {
        state.calls.push({ sql, params });
        if (state.throwOnQuery) throw new Error('db down');
        return state.rows;
      },
      $executeRawUnsafe: async () => 0,
    },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

import { getRecentTopics, getActiveOpenItems } from '../src/services/knowledge/entitySweepService';

beforeEach(() => {
  state.calls = [];
  state.rows = [];
  state.throwOnQuery = false;
});

describe('DEF-337 — the two never-ran queries now run', () => {
  it('recent-topics: GROUP BY provides distinctness, the aggregate ordering is licensed, no SELECT DISTINCT remains', async () => {
    state.rows = [{ subject: 'Re: Fujairah pricing' }, { subject: 'Fwd: DAL API' }];
    const topics = await getRecentTopics('TMC-0001', 'asad@tmcltd.com', '');
    const { sql, params } = state.calls[0];
    expect(sql).toContain("GROUP BY raw_payload->>'subject'");
    expect(sql).toContain('ORDER BY MAX(created_at) DESC');
    expect(sql).not.toContain('SELECT DISTINCT');
    expect(params).toEqual(['TMC-0001', 'asad@tmcltd.com']);
    expect(topics).toEqual(['Fujairah pricing', 'DAL API']); // Re:/Fwd: normalised
  });

  it('recent-topics falls to the phone column when no email exists — same tenant scope', async () => {
    await getRecentTopics('TMC-0001', '', '+923001112223');
    const { sql, params } = state.calls[0];
    expect(sql).toContain('sender_phone = $2');
    expect(params).toEqual(['TMC-0001', '+923001112223']);
  });

  it('active-items: NO DISTINCT (oi.id is the PK; single-valued FK join), ordering by created_at is legal', async () => {
    state.rows = [{ id: 'oi-1', itemNumber: 7, title: 'Approve pricing', status: 'NEW', priority: 'high' }];
    const items = await getActiveOpenItems('TMC-0001', 'asad@tmcltd.com');
    const { sql, params } = state.calls[0];
    expect(sql).not.toContain('DISTINCT');
    expect(sql).toContain('ORDER BY oi.created_at DESC');
    expect(params).toEqual(['TMC-0001', 'asad@tmcltd.com']);
    expect(items[0]).toMatchObject({ id: 'oi-1', itemNumber: 7, title: 'Approve pricing' });
  });

  it('a blank email never queries — no key, no claim', async () => {
    await expect(getActiveOpenItems('TMC-0001', '')).resolves.toEqual([]);
    expect(state.calls).toHaveLength(0);
  });

  it('both still fail OPEN on a real DB error — empty enrichment, never a throw into the sweep', async () => {
    state.throwOnQuery = true;
    await expect(getRecentTopics('TMC-0001', 'x@y.z', '')).resolves.toEqual([]);
    await expect(getActiveOpenItems('TMC-0001', 'x@y.z')).resolves.toEqual([]);
  });
});
