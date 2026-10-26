/**
 * DEF-362 — Integrations Stage 1b, mapping/aiProposer.ts: Review & Mapping for
 * KPI, Context, the structured filter and "not used" (spec INTEGRATIONS_DESIGN.md
 * §2b "Review & Mapping").
 *
 * Rules pinned (each test fails when its rule is removed):
 *  P1 prompt ORDER: document reading → remarks → filter words → connect
 *     instructions → inventory → per-field notes → catalogue (spec §2b).
 *  P2 Context rows: per_record / table persist with targetKind 'context' and the
 *     right target key; a field that is not in the data drops the row (notice).
 *  P3 per_record arithmetic: a never-filled title, or records without the
 *     connection's id field, ⇒ SET_ASIDE with numbers; over max_context_pages ⇒
 *     the cap is named in the reason.
 *  P4 the filter: validated against REAL fields; "keeps X of Y"; keeps 0 ⇒
 *     SET_ASIDE; no filter words ⇒ dropped; at most one per version (a carried
 *     approved filter blocks a new one); filter words with no filter ⇒ notice.
 *  P5 "not used" is a notice + spec.notUsed, NEVER an approvable row.
 *  P6 every row stores `followed`; carried rows keep theirs and their kind.
 *  P7 Stage 1 answers (no `kind`) still map as KPI rows.
 *  P8 rejected Context pairs are settled like KPI pairs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CN = 'TMC-0001';
const ID = 'integ-api';

const state = vi.hoisted(() => ({
  integ: null as any,
  defs: [] as any[],
  prevVersion: null as null | { id: string; version: number },
  approvedPrev: [] as any[],
  rejected: [] as any[],
  read: null as any,
  reply: '',
  maxPages: 500,
  llmCalls: [] as Array<{ system: string; user: string; opts: any }>,
  versionCreates: [] as any[],
  suggestionCreates: [] as any[],
  forbidden: [] as string[],
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async (key: string) => (key === 'integrations.max_context_pages' ? state.maxPages : 3_600_000),
}));
vi.mock('../src/services/llmRouter', () => ({
  callLLM: async (system: string, user: string, opts: any) => {
    state.llmCalls.push({ system, user, opts });
    return { text: state.reply, provider: 'gemini' };
  },
}));
vi.mock('../src/services/integrations/sources', () => ({
  sourceProblem: () => null,
  readSource: async () => state.read,
}));
vi.mock('../src/db/prisma', () => {
  const forbid = (name: string) => new Proxy({}, {
    get: (_t, m) => () => { state.forbidden.push(`${name}.${String(m)}`); throw new Error('forbidden write'); },
  });
  const p: any = {
    integrationSync: {
      findFirst: async (a: any) => (a.where.clientNumber === state.integ?.clientNumber && a.where.id === state.integ?.id ? state.integ : null),
      updateMany: () => { state.forbidden.push('integrationSync.updateMany'); },
    },
    kpiDefinition: { findMany: async () => state.defs },
    kpiReading: forbid('kpiReading'),
    integrationRun: forbid('integrationRun'),
    integrationMappingVersion: {
      findMany: async () => (state.prevVersion ? [state.prevVersion] : []),
      findFirst: async () => state.prevVersion,
      create: async (a: any) => { state.versionCreates.push(a.data); return { id: 'ver-new', version: a.data.version }; },
      updateMany: async () => ({ count: 1 }),
    },
    integrationSuggestion: {
      findMany: async (a: any) => {
        if (a.where.status === 'REJECTED') return state.rejected;
        if (a.where.status === 'APPROVED' && a.where.mappingVersionId === state.prevVersion?.id) return state.approvedPrev;
        return [];
      },
      createMany: async (a: any) => { state.suggestionCreates.push(...a.data); return { count: a.data.length }; },
    },
    $transaction: async (fn: any) => fn(p),
  };
  return { __esModule: true, default: p, prisma: p };
});

import { proposeMapping, buildFieldNotes } from '../src/services/integrations/mapping/aiProposer';

const HEADERS = ['id', 'name', 'status', 'amount', 'created', 'notes', 'meta.region', 'blank'];
const RECORDS = Array.from({ length: 10 }, (_, i) => ({
  id: `C-${i + 1}`,
  name: `Customer ${i + 1}`,
  status: i < 6 ? 'active' : 'inactive',
  amount: String(100 * (i + 1)),
  created: i < 4 ? '2024-06-01' : '2025-03-01',
  notes: i % 2 ? 'VIP' : '',
  'meta.region': 'North',
  blank: '',
}));

const answer = (rows: any[], notices: string[] = []) =>
  JSON.stringify({ summary: 'Customers as Context.', rows, notices, complete: true });

beforeEach(() => {
  state.integ = {
    id: ID, clientNumber: CN, name: 'CRM', purpose: 'Know our customers', adminBrief: 'REMARK: treat customers as knowledge',
    sourceKind: 'api', sourceConfig: {}, apiConfig: { baseUrl: 'https://api.example.com', idField: 'id' },
    filterInstructions: 'FILTER: only active customers', connectInstructions: 'CONNECT: one page per customer',
    apiDocReading: { summary: 'DOC: the customers endpoint lists accounts', gaps: ['GAP: paging not described'], draft: {} },
  };
  state.defs = [];
  state.prevVersion = null;
  state.approvedPrev = [];
  state.rejected = [];
  state.read = { records: RECORDS, headers: HEADERS, rowCount: RECORDS.length, truncated: false, anomalies: [], sourceLabel: 'api.example.com /customers' };
  state.maxPages = 500;
  state.llmCalls.length = 0;
  state.versionCreates.length = 0;
  state.suggestionCreates.length = 0;
  state.forbidden.length = 0;
  state.reply = answer([]);
});

const run = (prompt?: string) => proposeMapping(CN, ID, { actorId: 7, ...(prompt ? { prompt } : {}) });
const byKind = (k: string) => state.suggestionCreates.filter((s) => s.targetKind === k);

describe('P1 — the prompt carries the admin words in the spec §2b order', () => {
  it('document reading → remarks → filter words → connect instructions → inventory → notes → catalogue', async () => {
    await run();
    const u = state.llmCalls[0].user;
    const order = ['DOC: the customers endpoint', 'REMARK: treat customers', 'FILTER: only active', 'CONNECT: one page',
      'FIELD INVENTORY', 'FIELD NOTES', 'KPI CATALOGUE'].map((m) => {
      const i = u.indexOf(m);
      expect(i, m).toBeGreaterThanOrEqual(0);
      return i;
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(u).toContain('GAP: paging not described');
  });

  it('per-field notes name the id field, the never-filled and the constant fields', async () => {
    await run();
    const u = state.llmCalls[0].user;
    expect(u).toContain('"id" identifies a record');
    expect(u).toContain('"blank" is never filled');
    expect(u).toContain('"meta.region" has the same value ("North") in every record');
  });

  it('buildFieldNotes is pure and capped', () => {
    const cov = Array.from({ length: 100 }, (_, i) => ({ field: `f${i}`, filled: 0, total: 3, inferredType: 'empty' as const, samples: [] }));
    expect(buildFieldNotes(cov, null)).toHaveLength(60);
  });
});

describe('P2/P3 — Context rows', () => {
  it('per_record and table rows persist as context with their layout and followed', async () => {
    state.reply = answer([
      { kind: 'context', targetKey: 'context:per_record', transform: { mode: 'per_record', titleField: 'name', bodyFields: ['status', 'notes'] }, why: 'customer facts', followed: 'CONNECT: one page per customer' },
      { kind: 'context', targetKey: 'context:table', transform: { mode: 'table', columns: ['name', 'status'] }, followed: 'REMARK' },
    ]);
    const r = await run();
    const ctx = byKind('context');
    expect(ctx).toHaveLength(2);
    expect(ctx[0]).toMatchObject({ targetKey: 'context:per_record', sourceField: 'name', status: 'PENDING', followed: 'CONNECT: one page per customer', clientNumber: CN });
    expect(ctx[0].transform).toEqual({ mode: 'per_record', titleField: 'name', bodyFields: ['status', 'notes'] });
    expect(ctx[0].reason).toContain('10 knowledge page(s)');
    expect(ctx[1]).toMatchObject({ targetKey: 'context:table', sourceField: 'name', followed: 'REMARK' });
    expect(r.counts.pending).toBe(2);
  });

  it('a Context row naming a field the data does not have is dropped with a notice', async () => {
    state.reply = answer([{ kind: 'context', transform: { mode: 'per_record', titleField: 'name', bodyFields: ['phone'] } }]);
    const r = await run();
    expect(byKind('context')).toHaveLength(0);
    expect(r.notices.join(' ')).toContain('"phone" is not in the data');
  });

  it('a target key that disagrees with the layout is dropped', async () => {
    state.reply = answer([{ kind: 'context', targetKey: 'context:table', transform: { mode: 'per_record', titleField: 'name', bodyFields: ['status'] } }]);
    const r = await run();
    expect(byKind('context')).toHaveLength(0);
    expect(r.notices.join(' ')).toContain('does not match');
  });

  it('a never-filled title field ⇒ SET_ASIDE with the numbers', async () => {
    state.reply = answer([{ kind: 'context', transform: { mode: 'per_record', titleField: 'blank', bodyFields: ['status'] } }]);
    await run();
    expect(byKind('context')[0].status).toBe('SET_ASIDE');
    expect(byKind('context')[0].reason).toContain('blank in all 10 records');
  });

  it('records without the connection id field ⇒ SET_ASIDE (no page could be kept current)', async () => {
    state.integ.apiConfig = { baseUrl: 'https://api.example.com', idField: 'blank' };
    state.reply = answer([{ kind: 'context', transform: { mode: 'per_record', titleField: 'name', bodyFields: ['status'] } }]);
    await run();
    expect(byKind('context')[0].status).toBe('SET_ASIDE');
    expect(byKind('context')[0].reason).toContain('id field "blank"');
  });

  it('more records than max_context_pages ⇒ the cap is named in the reason', async () => {
    state.maxPages = 4;
    state.reply = answer([{ kind: 'context', transform: { mode: 'per_record', titleField: 'name', bodyFields: ['status'] } }]);
    await run();
    expect(byKind('context')[0].reason).toContain('Only the first 4 would be written');
  });

  it('P8 a rejected Context pair is not proposed again without an instruction', async () => {
    state.rejected = [{ sourceField: 'name', targetKey: 'context:per_record' }];
    state.reply = answer([{ kind: 'context', transform: { mode: 'per_record', titleField: 'name', bodyFields: ['status'] } }]);
    const r = await run();
    expect(byKind('context')).toHaveLength(0);
    expect(r.notices.join(' ')).toContain('rejected earlier');
  });
});

describe('P4 — the structured filter', () => {
  const activeFilter = { match: 'all', conditions: [{ field: 'status', op: 'equals', value: 'active' }] };

  it('is validated against the real fields and counted: keeps 6 of 10', async () => {
    state.reply = answer([{ kind: 'filter', filter: activeFilter, followed: 'FILTER: only active customers' }]);
    await run();
    const f = byKind('filter');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ targetKey: 'filter', sourceField: 'status', status: 'PENDING', followed: 'FILTER: only active customers' });
    expect(f[0].transform).toEqual(activeFilter);
    expect(f[0].reason).toContain('keeps 6 of the 10 records');
  });

  it('a condition on a field the data does not have drops the filter (it would fail every run)', async () => {
    state.reply = answer([{ kind: 'filter', filter: { match: 'all', conditions: [{ field: 'Status ', op: 'equals', value: 'x' }] } }]);
    const r = await run();
    expect(byKind('filter')).toHaveLength(0);
    expect(r.notices.join(' ')).toContain('not in the data');
  });

  it('a filter that keeps nothing is SET_ASIDE with the arithmetic', async () => {
    state.reply = answer([{ kind: 'filter', filter: { match: 'all', conditions: [{ field: 'status', op: 'equals', value: 'gone' }] } }]);
    await run();
    expect(byKind('filter')[0].status).toBe('SET_ASIDE');
    expect(byKind('filter')[0].reason).toContain('keeps 0 of the 10');
  });

  it('without filter words (and no instruction) a proposed filter is dropped', async () => {
    state.integ.filterInstructions = null;
    state.reply = answer([{ kind: 'filter', filter: activeFilter }]);
    const r = await run();
    expect(byKind('filter')).toHaveLength(0);
    expect(r.notices.join(' ')).toContain('no filter words');
  });

  it('at most one filter: the second is dropped', async () => {
    state.reply = answer([
      { kind: 'filter', filter: activeFilter },
      { kind: 'filter', filter: { match: 'all', conditions: [{ field: 'created', op: 'after', value: '2025-01-01' }] } },
    ]);
    const r = await run();
    expect(byKind('filter')).toHaveLength(1);
    expect(r.notices.join(' ')).toContain('Dropped a second filter');
  });

  it('a carried approved filter blocks a new one, and is itself carried with kind + followed', async () => {
    state.prevVersion = { id: 'v1', version: 1 };
    state.approvedPrev = [{
      id: 'sug-f', targetKind: 'filter', sourceField: 'status', targetKey: 'filter', transform: activeFilter,
      coverage: null, samples: [], newKpi: null, reason: 'r', followed: 'FILTER words', decidedBy: 7, decidedAt: new Date(),
    }];
    state.reply = answer([{ kind: 'filter', filter: { match: 'all', conditions: [{ field: 'amount', op: 'greater_than', value: '100' }] } }]);
    await run();
    const f = byKind('filter');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ status: 'APPROVED', carriedFromId: 'sug-f', followed: 'FILTER words' });
    expect(state.llmCalls[0].user).toContain('ALREADY APPROVED');
  });

  it('filter words that did not become a filter are reported, never silently ignored', async () => {
    state.reply = answer([]);
    const r = await run();
    expect(r.notices.join(' ')).toContain('did not become a filter');
  });
});

describe('P5 — "not used" is a notice, never an approvable row', () => {
  it('lands in notices and spec.notUsed; no suggestion row is created', async () => {
    state.reply = answer([{ kind: 'not_used', field: 'meta.region', why: 'the same in every record', followed: 'REMARK' }]);
    const r = await run();
    expect(state.suggestionCreates).toHaveLength(0);
    expect(r.notices.join(' ')).toContain('Not used: "meta.region" — the same in every record');
    expect(state.versionCreates[0].spec.notUsed).toEqual([{ field: 'meta.region', reason: 'the same in every record' }]);
  });
});

describe('P6/P7 — followed on every row; Stage 1 answers still map', () => {
  it('a KPI row without "kind" maps as before and stores followed (null when absent)', async () => {
    state.reply = answer([
      { targetKey: 'kpi:new:sales', newKpi: { kpiKey: 'sales', label: 'Sales' }, transform: { mode: 'long', valueField: 'amount', periodField: 'created' }, followed: 'REMARK' },
    ]);
    await run();
    const k = byKind('kpi');
    expect(k).toHaveLength(1);
    expect(k[0]).toMatchObject({ targetKey: 'kpi:new:sales', followed: 'REMARK' });
  });

  it('followed is clipped to 300 characters', async () => {
    state.reply = answer([{ kind: 'context', transform: { mode: 'table', columns: ['name'] }, followed: 'x'.repeat(1000) }]);
    await run();
    expect(byKind('context')[0].followed.length).toBe(300);
  });

  it('the proposer writes no integration column (approved_filter is approval-only)', async () => {
    state.reply = answer([{ kind: 'filter', filter: { match: 'all', conditions: [{ field: 'status', op: 'equals', value: 'active' }] } }]);
    await run();
    expect(state.forbidden).toEqual([]);
  });
});
