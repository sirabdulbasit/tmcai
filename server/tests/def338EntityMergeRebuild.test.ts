/**
 * DEF-338 `entity-merge-fk-violation` — the entity merge had never once
 * succeeded on a realistic duplicate (same survivor `cmpcpvy1k…` retried
 * hourly across FOUR deploys, ~24 failures/day):
 *
 *  - repointing `entity_links` in place (`UPDATE … SET entity_id/
 *    linked_entity_id = survivor`) hits the unique triple
 *    (entity_id, linked_entity_id, link_type) — 23505 — because a true
 *    duplicate usually carries the SAME relationships the survivor already
 *    has; that is the normal case, not the edge;
 *  - every in-transaction statement had `.catch(() => 0)`, which cannot
 *    contain a failure inside a Postgres transaction (the first error aborts
 *    it; everything after fails anyway) — it only masked the root cause and
 *    multiplied the log lines;
 *  - any link row left pointing at a doomed id turned the final
 *    `DELETE FROM entities` into a 23503 on `entity_links_linked_entity_id_fkey`.
 *
 * The fix REBUILDS links instead of repointing (snapshot → delete → re-insert
 * remapped with ON CONFLICT DO NOTHING, self-links dropped), removes the
 * in-transaction catches so the first error throws with its real sqlState,
 * and narrows every statement to the ids PROVEN to exist under the tenant.
 * Neither constraint can fire, by construction — no error branch to remember.
 *
 * Under test (mocked prisma captures every statement in order):
 *  - no `UPDATE entity_links` is ever issued; links are deleted and
 *    re-inserted with ON CONFLICT DO NOTHING;
 *  - a duplicate's link to the survivor (or to another duplicate) becomes a
 *    self-link and is dropped, not re-inserted;
 *  - all entity_links statements precede `DELETE FROM entities` (FK order);
 *  - an id the tenant snapshot did not return is excluded from every
 *    subsequent statement (tenant scope by construction);
 *  - a mid-transaction failure stops the merge at that statement — nothing
 *    after it executes, and the merge reports null;
 *  - the rollback record carries the deleted link rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: any[] }>,
  entities: {} as Record<string, any>,
  links: [] as any[],
  failOn: '',
  insertResults: [] as number[],
}));

vi.mock('../src/db/prisma', () => {
  const run = async (sql: string, params: any[]) => {
    state.calls.push({ sql, params });
    if (state.failOn && sql.includes(state.failOn)) throw Object.assign(new Error('boom'), { code: 'P2010', meta: { code: '23505' } });
    if (sql.includes('FROM entities WHERE client_number = $1 AND id = ANY')) {
      return (params[1] as string[]).map((id) => state.entities[id]).filter((r) => r && r.client_number === params[0]);
    }
    if (sql.includes('FROM entities WHERE client_number = $1 AND id = $2')) {
      const r = state.entities[params[1]];
      return r && r.client_number === params[0] ? [r] : [];
    }
    if (sql.includes('FROM entity_links')) {
      const ids = params[0] as string[];
      return state.links.filter((l) => ids.includes(l.entity_id) || ids.includes(l.linked_entity_id));
    }
    // open_items always has one row pointing at a duplicate, so the plain
    // repoint loop genuinely executes its UPDATE in every scenario below.
    if (sql.includes(' AS old_value FROM open_items')) return [{ id: 'oi-9', old_value: 'dup1' }];
    if (sql.includes(' AS old_value FROM ')) return [];
    if (sql.startsWith('INSERT INTO entity_links')) return state.insertResults.length ? state.insertResults.shift() : 1;
    return 1;
  };
  const tx = {
    $queryRawUnsafe: (sql: string, ...params: any[]) => run(sql, params),
    $executeRawUnsafe: (sql: string, ...params: any[]) => run(sql, params),
  };
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0, groupBy: async () => [],
  };
  const p: any = new Proxy(
    {
      $transaction: async (fn: any) => fn(tx),
      $queryRawUnsafe: (sql: string, ...params: any[]) => run(sql, params),
      $executeRawUnsafe: (sql: string, ...params: any[]) => run(sql, params),
    },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

import { mergeEntities } from '../src/services/memory/identityResolutionService';

const entity = (id: string, over: Record<string, any> = {}) => ({
  id, client_number: 'TMC-0001', name: 'Laiba Zahid', email: null, phone: null,
  company: null, role: null, relationship_strength: 1, last_interaction: null,
  created_at: new Date('2026-01-01'), ...over,
});
const link = (id: string, from: string, to: string, type = 'works_at') => ({
  id, entity_id: from, linked_entity_id: to, link_type: type,
  client_number: 'TMC-0001', created_at: new Date('2026-02-02'),
});

beforeEach(() => {
  state.calls = [];
  state.failOn = '';
  state.insertResults = [];
  state.entities = {
    surv: entity('surv', { email: 'laiba@tmcltd.com' }),
    dup1: entity('dup1', { phone: '+923001112223' }),
    dup2: entity('dup2'),
  };
  state.links = [];
});

describe('DEF-338 — the merge rebuilds entity_links; neither constraint can fire', () => {
  it('never issues UPDATE entity_links: links are deleted and re-inserted with ON CONFLICT DO NOTHING, remapped to the survivor', async () => {
    state.links = [link('l1', 'dup1', 'acme')];
    const out = await mergeEntities('TMC-0001', 'surv', ['dup1', 'dup2'], 'same person');
    expect(out).not.toBeNull();
    expect(state.calls.some((c) => c.sql.includes('UPDATE entity_links'))).toBe(false);
    const del = state.calls.find((c) => c.sql.includes('DELETE FROM entity_links'));
    expect(del!.params[0]).toEqual(['l1']);
    const ins = state.calls.find((c) => c.sql.startsWith('INSERT INTO entity_links'));
    expect(ins!.sql).toContain('ON CONFLICT DO NOTHING');
    // same row id, entity_id remapped dup1 → surv, target and type kept
    expect(ins!.params).toEqual(['l1', 'surv', 'acme', 'works_at', 'TMC-0001', new Date('2026-02-02')]);
  });

  it('drops self-links instead of re-inserting them: dup↔survivor and dup↔dup links are identity artefacts, not relationships', async () => {
    state.links = [link('l1', 'dup1', 'surv'), link('l2', 'dup1', 'dup2'), link('l3', 'acme', 'dup2')];
    const out = await mergeEntities('TMC-0001', 'surv', ['dup1', 'dup2'], 'same person');
    const inserts = state.calls.filter((c) => c.sql.startsWith('INSERT INTO entity_links'));
    expect(inserts).toHaveLength(1); // only l3 survives, remapped acme → surv
    expect(inserts[0].params.slice(0, 3)).toEqual(['l3', 'acme', 'surv']);
    expect(out!.repointed['entity_links']).toBe(1);
  });

  it('settles every entity_links row BEFORE DELETE FROM entities — the foreign key cannot see a doomed id', async () => {
    state.links = [link('l1', 'dup1', 'acme'), link('l2', 'acme', 'dup2')];
    await mergeEntities('TMC-0001', 'surv', ['dup1', 'dup2'], 'same person');
    const lastLinkStmt = state.calls.map((c, i) => (c.sql.includes('entity_links') ? i : -1)).filter((i) => i >= 0).pop()!;
    const entityDelete = state.calls.findIndex((c) => c.sql.includes('DELETE FROM entities'));
    expect(entityDelete).toBeGreaterThan(lastLinkStmt);
  });

  it('operates only on ids proven to exist under the tenant — a foreign or stale id cannot repoint anything', async () => {
    state.links = [link('l1', 'dup1', 'acme')];
    state.entities['theirs'] = entity('theirs', { client_number: 'TMC-0002' });
    const out = await mergeEntities('TMC-0001', 'surv', ['dup1', 'theirs', 'ghost'], 'same person');
    expect(out!.mergedIds).toEqual(['dup1']);
    for (const c of state.calls.slice(2)) {
      for (const p of c.params) {
        if (Array.isArray(p)) expect(p).not.toContain('theirs');
      }
    }
    const entityDelete = state.calls.find((c) => c.sql.includes('DELETE FROM entities'));
    expect(entityDelete!.params).toEqual(['TMC-0001', ['dup1']]);
  });

  it('a mid-transaction failure STOPS the merge — no statement after the error, null out, no swallowed cascade', async () => {
    state.links = [link('l1', 'dup1', 'acme')];
    state.failOn = 'UPDATE open_items';
    const out = await mergeEntities('TMC-0001', 'surv', ['dup1'], 'same person');
    expect(out).toBeNull();
    const failedAt = state.calls.findIndex((c) => c.sql.includes('UPDATE open_items'));
    expect(failedAt).toBeGreaterThan(-1);
    expect(state.calls).toHaveLength(failedAt + 1);
    expect(state.calls.some((c) => c.sql.includes('DELETE FROM entities'))).toBe(false);
  });

  it('the rollback record carries the deleted link rows — the rebuild stays reversible', async () => {
    state.links = [link('l1', 'dup1', 'surv')];
    const out = await mergeEntities('TMC-0001', 'surv', ['dup1'], 'same person');
    const moved = (out!.rollback as any).movedRows.find((m: any) => m.table === 'entity_links');
    expect(moved.ids).toEqual([state.links[0]]);
  });
});
