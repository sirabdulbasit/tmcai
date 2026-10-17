/**
 * DEF-339 `merge-rollback-discarded` — Codex it-79(5) directive #1.
 *
 * DEF-338 made the hourly identity merge succeed for the first time ever,
 * which made `DELETE FROM entities` REACHABLE on production contacts — driven
 * by a duplicate-detection path whose precision has never been observed live.
 * `mergeEntities` computed a full rollback record (deleted rows, repointed
 * references, survivor's pre-merge state) and its docstring promised
 * "REVERSIBLE" — but the scheduler caller DISCARDED it, logging only ids.
 * A wrong high-confidence auto-merge would permanently lose a contact's
 * identity fields; an id in a log line is not recovery.
 *
 * The fix: the rollback record is written to `entity_merge_audit` INSIDE the
 * merge transaction. A merge that cannot write its receipt cannot commit —
 * the `no-claim-without-a-receipt` guardrail applied to Brain's own
 * unattended mutation, held by construction, not by a code path someone must
 * remember.
 *
 * Under test (mocked prisma captures every statement in order):
 *  - a successful merge writes exactly ONE audit INSERT, carrying the tenant,
 *    the survivor, the tenant-verified merged ids, the proposal's reason, and
 *    a rollback JSON with the deleted entity rows IN FULL (not ids), the
 *    moved entity_links rows, and the survivor's pre-merge state;
 *  - the INSERT is issued after the entity DELETE, inside the transaction,
 *    and the outcome returns its id (`auditId`) for the caller's log line;
 *  - a failing audit INSERT aborts the merge — null outcome, nothing after
 *    the failing statement (no unaudited deletion can be reported);
 *  - the audit's merged_ids exclude foreign/stale ids (tenant guardrail
 *    continuity from DEF-338).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: any[] }>,
  entities: {} as Record<string, any>,
  links: [] as any[],
  failOn: '',
}));

vi.mock('../src/db/prisma', () => {
  const run = async (sql: string, params: any[]) => {
    state.calls.push({ sql, params });
    if (state.failOn && sql.includes(state.failOn)) throw Object.assign(new Error('boom'), { code: 'P2010' });
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
    if (sql.includes(' AS old_value FROM ')) return [];
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
  state.entities = {
    surv: entity('surv', { email: 'laiba@tmcltd.com' }),
    dup1: entity('dup1', { phone: '+923001112223' }),
  };
  state.links = [link('l1', 'dup1', 'acme')];
});

const auditInserts = () => state.calls.filter((c) => c.sql.includes('INSERT INTO entity_merge_audit'));

describe('DEF-339 — no deletion commits without its durable receipt', () => {
  it('a successful merge writes exactly one audit row: tenant, survivor, verified ids, reason — and returns its id', async () => {
    const out = await mergeEntities('TMC-0001', 'surv', ['dup1'], 'same person, shared number');
    const ins = auditInserts();
    expect(ins).toHaveLength(1);
    const [id, clientNumber, survivorId, mergedIds, reason] = ins[0].params;
    expect(clientNumber).toBe('TMC-0001');
    expect(survivorId).toBe('surv');
    expect(mergedIds).toEqual(['dup1']);
    expect(reason).toBe('same person, shared number');
    expect(out!.auditId).toBe(id);
  });

  it('the rollback payload carries recovery data, not references: deleted rows IN FULL, the moved links, the survivor before', async () => {
    const out = await mergeEntities('TMC-0001', 'surv', ['dup1'], 'same person');
    const payload = JSON.parse(auditInserts()[0].params[5]);
    expect(payload.deletedEntities[0]).toMatchObject({ id: 'dup1', phone: '+923001112223', name: 'Laiba Zahid' });
    const movedLinks = payload.movedRows.find((m: any) => m.table === 'entity_links');
    expect(movedLinks.ids[0]).toMatchObject({ id: 'l1', entity_id: 'dup1', linked_entity_id: 'acme' });
    expect(payload.survivorBefore).toMatchObject({ id: 'surv', email: 'laiba@tmcltd.com' });
    expect(out!.rollback).toMatchObject({ reason: 'same person' });
  });

  it('the receipt is written inside the transaction, after the entity DELETE — the last thing before commit', async () => {
    await mergeEntities('TMC-0001', 'surv', ['dup1'], 'same person');
    const auditAt = state.calls.findIndex((c) => c.sql.includes('INSERT INTO entity_merge_audit'));
    const deleteAt = state.calls.findIndex((c) => c.sql.includes('DELETE FROM entities'));
    expect(deleteAt).toBeGreaterThan(-1);
    expect(auditAt).toBeGreaterThan(deleteAt);
    expect(auditAt).toBe(state.calls.length - 1);
  });

  it('a merge that cannot write its receipt cannot commit — failing audit INSERT yields null, nothing after it', async () => {
    state.failOn = 'INSERT INTO entity_merge_audit';
    const out = await mergeEntities('TMC-0001', 'surv', ['dup1'], 'same person');
    expect(out).toBeNull();
    const auditAt = state.calls.findIndex((c) => c.sql.includes('INSERT INTO entity_merge_audit'));
    expect(auditAt).toBe(state.calls.length - 1);
  });

  it('the audit never claims an id the tenant snapshot did not verify (DEF-338 guardrail continuity)', async () => {
    state.entities['theirs'] = entity('theirs', { client_number: 'TMC-0002' });
    await mergeEntities('TMC-0001', 'surv', ['dup1', 'theirs', 'ghost'], 'same person');
    const [, , , mergedIds] = auditInserts()[0].params;
    expect(mergedIds).toEqual(['dup1']);
  });
});
