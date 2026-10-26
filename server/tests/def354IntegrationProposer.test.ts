/**
 * DEF-354 — Integrations Stage 1, mapping/aiProposer.ts + mapping/proposalJobs.ts.
 *
 * Rules pinned (spec INTEGRATIONS_DESIGN.md §2.3, vm §9):
 *  - A new proposal KEEPS what is approved: every APPROVED row of the previous
 *    version is copied unchanged (carried_from_id) and listed to the model as
 *    settled.
 *  - Rejected pairs (all versions) are in the prompt and are not re-proposed
 *    unless the admin's instruction this time asks.
 *  - Proposable ≠ writable: keys outside the active catalogue are dropped
 *    unless declared as a valid new KPI; a KPI fed by another integration or
 *    already fed in this version is SET_ASIDE, never merged.
 *  - A reply without the trailing `"complete": true` sentinel is an error and
 *    nothing is saved.
 *  - The proposer writes ONE version + its rows in ONE transaction, every row
 *    carries the tenant, and it NEVER writes KPI data or KPI definitions.
 *  - Jobs: same inputs → same running job; different inputs → 409; the
 *    connection must have passed its test; another tenant reads null.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CN = 'TMC-0001';
const ID = 'integ-1';

const state = vi.hoisted(() => ({
  integ: null as any,
  defs: [] as any[],
  prevVersion: null as null | { id: string; version: number },
  approvedPrev: [] as any[],
  rejected: [] as any[],
  read: null as any,
  reply: '' as string | (() => Promise<string>),
  llmCalls: [] as Array<{ system: string; user: string; opts: any }>,
  whereSeen: [] as any[],
  versionCreates: [] as any[],
  versionUpdates: [] as any[],
  suggestionCreates: [] as any[],
  forbidden: [] as string[],
  transactions: 0,
  connectionOk: true,
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async () => 3_600_000,
}));
vi.mock('../src/services/llmRouter', () => ({
  callLLM: async (system: string, user: string, opts: any) => {
    state.llmCalls.push({ system, user, opts });
    const text = typeof state.reply === 'function' ? await state.reply() : state.reply;
    return { text, provider: 'gemini' };
  },
}));
vi.mock('../src/services/integrations/sources/gsheetReader', () => ({
  readGsheet: async () => state.read,
}));
vi.mock('../src/services/integrations/store/integrationStore', () => ({
  readSourceConfig: (raw: any) => (raw && raw.sheetId ? raw : null),
  isConnectionOk: () => state.connectionOk,
}));
vi.mock('../src/db/prisma', () => {
  const forbid = (name: string) => new Proxy({}, {
    get: (_t, m) => (..._a: any[]) => { state.forbidden.push(`${name}.${String(m)}`); throw new Error('forbidden write'); },
  });
  const seen = (args: any) => { state.whereSeen.push(args?.where); return args; };
  const p: any = {
    integrationSync: {
      findFirst: async (a: any) => { seen(a); return a.where.clientNumber === state.integ?.clientNumber && a.where.id === state.integ?.id ? state.integ : null; },
    },
    kpiDefinition: {
      findMany: async (a: any) => { seen(a); return state.defs; },
      create: (..._a: any[]) => { state.forbidden.push('kpiDefinition.create'); },
      upsert: (..._a: any[]) => { state.forbidden.push('kpiDefinition.upsert'); },
      update: (..._a: any[]) => { state.forbidden.push('kpiDefinition.update'); },
      createMany: (..._a: any[]) => { state.forbidden.push('kpiDefinition.createMany'); },
    },
    kpiReading: forbid('kpiReading'),
    integrationRun: forbid('integrationRun'),
    integrationRunChange: forbid('integrationRunChange'),
    integrationMappingVersion: {
      findMany: async (a: any) => { seen(a); return state.prevVersion ? [state.prevVersion] : []; },
      findFirst: async (a: any) => { seen(a); return state.prevVersion; },
      create: async (a: any) => { state.versionCreates.push(a.data); return { id: 'ver-new', version: a.data.version }; },
      updateMany: async (a: any) => { state.versionUpdates.push(a); return { count: 1 }; },
    },
    integrationSuggestion: {
      findMany: async (a: any) => {
        seen(a);
        if (a.where.status === 'REJECTED') return state.rejected;
        if (a.where.status === 'APPROVED' && a.where.mappingVersionId === state.prevVersion?.id) return state.approvedPrev;
        return [];
      },
      createMany: async (a: any) => { state.suggestionCreates.push(...a.data); return { count: a.data.length }; },
    },
    $executeRaw: (..._a: any[]) => { state.forbidden.push('$executeRaw'); },
    $executeRawUnsafe: (..._a: any[]) => { state.forbidden.push('$executeRawUnsafe'); },
    $transaction: async (fn: any) => { state.transactions++; return fn(p); },
  };
  return { __esModule: true, default: p, prisma: p };
});

import {
  ProposalError, parseProposerAnswer, proposeMapping, proposerBudget, PROPOSER_PURPOSE,
} from '../src/services/integrations/mapping/aiProposer';
import {
  __resetProposalJobs, getProposalJob, ProposalBusyError, startProposalJob, sweepProposalJobs,
} from '../src/services/integrations/mapping/proposalJobs';

const LONG_HEADERS = ['Month', 'Region', 'Revenue', 'Orders', 'Status', 'Empty'];
const longRecords = Array.from({ length: 6 }, (_, i) => ({
  Month: `${['Jan', 'Feb', 'Mar'][i % 3]} 2026`,
  Region: i < 3 ? 'North' : 'South',
  Revenue: String(1000 + i),
  Orders: String(10 + i),
  Status: 'open',
  Empty: '',
}));

const answer = (rows: any[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ summary: 'Revenue and orders by month.', rows, notices: [], ...extra, complete: true });
const long = (valueField: string, more: Record<string, unknown> = {}) => ({ mode: 'long', valueField, periodField: 'Month', ...more });

beforeEach(() => {
  state.integ = { id: ID, clientNumber: CN, name: 'Sales sheet', purpose: 'Track sales', adminBrief: 'Monthly totals', sourceConfig: { sheetId: 'S1', gid: '0', link: 'x' } };
  state.defs = [
    { kpiKey: 'revenue', label: 'Revenue', unit: 'PKR', grain: 'month', isActive: true, sourceIntegrationId: null },
    { kpiKey: 'orders', label: 'Orders', unit: null, grain: 'month', isActive: true, sourceIntegrationId: null },
    { kpiKey: 'old_metric', label: 'Old', unit: null, grain: 'month', isActive: false, sourceIntegrationId: null },
    { kpiKey: 'theirs', label: 'Theirs', unit: null, grain: 'month', isActive: true, sourceIntegrationId: 'integ-OTHER' },
  ];
  state.prevVersion = null;
  state.approvedPrev = [];
  state.rejected = [];
  state.read = { records: longRecords, headers: LONG_HEADERS, rowCount: 6, truncated: false, anomalies: [], sourceLabel: 'Sales › Monthly' };
  state.reply = answer([{ targetKey: 'kpi:revenue', transform: long('Revenue'), why: 'money per month' }]);
  state.llmCalls.length = 0;
  state.whereSeen.length = 0;
  state.versionCreates.length = 0;
  state.versionUpdates.length = 0;
  state.suggestionCreates.length = 0;
  state.forbidden.length = 0;
  state.transactions = 0;
  state.connectionOk = true;
  __resetProposalJobs();
});

const opts = { actorId: 7 };
const byKey = () => Object.fromEntries(state.suggestionCreates.map((s) => [s.targetKey, s]));

describe('DEF-354 proposer — what it saves', () => {
  it('writes ONE version + its rows in ONE transaction, tenant on every row, and no KPI data', async () => {
    const r = await proposeMapping(CN, ID, opts);
    expect(state.transactions).toBe(1);
    expect(state.versionCreates).toHaveLength(1);
    expect(state.versionCreates[0]).toMatchObject({ clientNumber: CN, integrationId: ID, version: 1, status: 'DRAFT', createdBy: 7 });
    expect(state.versionCreates[0].spec).toMatchObject({ provider: 'gemini' });
    expect(state.versionCreates[0].spec.coverage).toHaveLength(LONG_HEADERS.length);
    expect(state.suggestionCreates.every((s) => s.clientNumber === CN && s.mappingVersionId === 'ver-new')).toBe(true);
    expect(state.forbidden).toEqual([]);
    expect(r).toMatchObject({ mappingVersion: 1, versionId: 'ver-new', provider: 'gemini', counts: { pending: 1, approvedCarried: 0, setAside: 0 } });
    // Every read was tenant-scoped.
    expect(state.whereSeen.every((w) => w && w.clientNumber === CN)).toBe(true);
  });

  it('supersedes every older DRAFT in the same transaction — a stale draft cannot be approved or turned on (review fix)', async () => {
    await proposeMapping(CN, ID, opts);
    expect(state.versionUpdates).toEqual([{
      where: { clientNumber: CN, integrationId: ID, status: 'DRAFT', id: { not: 'ver-new' } },
      data: { status: 'SUPERSEDED' },
    }]);
  });

  it('the token budget stays under the Claude SDK non-streaming refusal, however wide the sheet (review fix)', () => {
    for (const fields of [1, 100, 219, 220, 500, 5000]) {
      const { maxTokens } = proposerBudget(fields);
      expect((3600 * maxTokens) / 128000).toBeLessThanOrEqual(600); // @anthropic-ai/sdk _calculateNonstreamingTimeout
    }
    expect(proposerBudget(10).maxTokens).toBe(8_192 + 600);
  });

  it('calls the model with purpose integration_mapping, the tenant and the actor', async () => {
    await proposeMapping(CN, ID, opts);
    expect(state.llmCalls).toHaveLength(1);
    expect(state.llmCalls[0].opts).toMatchObject({ purpose: PROPOSER_PURPOSE, clientNumber: CN, userId: 7 });
    expect(PROPOSER_PURPOSE).toBe('integration_mapping');
    expect(state.llmCalls[0].opts.timeoutMs).toBeGreaterThan(15_000);
    // The prompt carries the brief, the inventory and the ACTIVE catalogue only.
    const u = state.llmCalls[0].user;
    expect(u).toContain('Monthly totals');
    expect(u).toContain('"Revenue": number, filled 6/6');
    expect(u).toContain('- revenue: Revenue (PKR)');
    expect(u).not.toContain('old_metric');
  });

  it('a wrong-tenant id is not found and calls nothing', async () => {
    await expect(proposeMapping('TMC-9999', ID, opts)).rejects.toMatchObject({ code: 'INTEGRATION_NOT_FOUND' });
    expect(state.llmCalls).toHaveLength(0);
    expect(state.versionCreates).toHaveLength(0);
  });
});

describe('DEF-354 proposer — a new proposal keeps what is approved', () => {
  beforeEach(() => {
    state.prevVersion = { id: 'ver-1', version: 1 };
    state.approvedPrev = [{
      id: 'sug-approved', sourceField: 'Revenue', targetKey: 'kpi:revenue', transform: long('Revenue'),
      coverage: { field: 'Revenue' }, samples: ['1000'], newKpi: null, reason: 'approved earlier', decidedBy: 3, decidedAt: new Date('2026-10-20T10:00:00Z'),
    }];
  });

  it('copies every approved row unchanged with carried_from_id, and lists it to the model as settled', async () => {
    state.reply = answer([
      { targetKey: 'kpi:revenue', transform: long('Revenue') },  // same pair — not duplicated
      { targetKey: 'kpi:orders', transform: long('Orders') },
    ]);
    const r = await proposeMapping(CN, ID, opts);
    const carried = state.suggestionCreates.filter((s) => s.carriedFromId === 'sug-approved');
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({
      status: 'APPROVED', targetKey: 'kpi:revenue', sourceField: 'Revenue', transform: long('Revenue'),
      reason: 'approved earlier', decidedBy: 3, decidedAt: new Date('2026-10-20T10:00:00Z'),
    });
    expect(state.suggestionCreates.filter((s) => s.targetKey === 'kpi:revenue')).toHaveLength(1);
    expect(byKey()['kpi:orders'].status).toBe('PENDING');
    expect(r.mappingVersion).toBe(2);
    expect(r.counts).toEqual({ pending: 1, approvedCarried: 1, setAside: 0 });
    expect(state.llmCalls[0].user).toMatch(/ALREADY APPROVED \(v1\)[^\n]*\n- kpi:revenue ← /);
  });

  it('a second source aimed at an already-fed KPI is SET_ASIDE, never merged', async () => {
    state.reply = answer([{ targetKey: 'kpi:revenue', transform: long('Orders') }]);
    await proposeMapping(CN, ID, opts);
    const second = state.suggestionCreates.find((s) => s.sourceField === 'Orders')!;
    expect(second.status).toBe('SET_ASIDE');
    expect(second.reason).toContain('Withdraw that approval first');
  });

  it('warns (and keeps the approval) when the sheet lost a column the approved row reads', async () => {
    state.read = { ...state.read, headers: LONG_HEADERS.filter((h) => h !== 'Revenue') };
    state.reply = answer([]);
    const r = await proposeMapping(CN, ID, opts);
    expect(state.suggestionCreates[0]).toMatchObject({ status: 'APPROVED', carriedFromId: 'sug-approved' });
    expect(r.notices.join(' ')).toContain('no longer has');
  });
});

describe('DEF-354 proposer — rejected pairs are settled', () => {
  beforeEach(() => {
    state.rejected = [{ sourceField: 'Orders', targetKey: 'kpi:orders' }];
    state.reply = answer([{ targetKey: 'kpi:orders', transform: long('Orders') }]);
  });

  it('are listed in the prompt and a re-proposal is dropped with a notice', async () => {
    const r = await proposeMapping(CN, ID, opts);
    expect(state.llmCalls[0].user).toContain('ALREADY REJECTED');
    expect(state.llmCalls[0].user).toContain('"Orders" → kpi:orders');
    expect(state.suggestionCreates).toHaveLength(0);
    expect(r.notices.join(' ')).toContain('rejected earlier');
  });

  it('are reopened only by the admin instruction, and the reason says so', async () => {
    await proposeMapping(CN, ID, { actorId: 7, prompt: 'Map Orders after all' });
    expect(state.llmCalls[0].user).toContain('ADDITIONAL INSTRUCTION (takes priority');
    expect(byKey()['kpi:orders']).toMatchObject({ status: 'PENDING' });
    expect(byKey()['kpi:orders'].reason).toContain('Rejected earlier; proposed again');
    expect(state.versionCreates[0].adminPrompt).toBe('Map Orders after all');
  });

  it('a pair rejected as kpi:new:<key> is settled for kpi:<key> too', async () => {
    state.rejected = [{ sourceField: 'Orders', targetKey: 'kpi:new:orders' }];
    await proposeMapping(CN, ID, opts);
    expect(state.suggestionCreates).toHaveLength(0);
  });
});

describe('DEF-354 proposer — proposable is not writable', () => {
  it('drops keys outside the catalogue, inactive KPIs, bad new keys and unknown columns', async () => {
    state.reply = answer([
      { targetKey: 'kpi:profit', transform: long('Revenue') },                                   // not in catalogue, no newKpi
      { targetKey: 'kpi:old_metric', transform: long('Revenue') },                               // inactive
      { targetKey: 'kpi:new:Bad-Key', newKpi: { kpiKey: 'Bad-Key', label: 'Bad' }, transform: long('Revenue') },
      { targetKey: 'kpi:new:aov', newKpi: { kpiKey: 'other', label: 'AOV' }, transform: long('Revenue') }, // key mismatch
      { targetKey: 'kpi:orders', transform: long('Ghost') },                                    // column not in sheet
      { targetKey: 'kpi:orders', transform: { mode: 'diagonal' } },
    ]);
    const r = await proposeMapping(CN, ID, opts);
    expect(state.suggestionCreates).toHaveLength(0);
    expect(r.notices.filter((n) => n.startsWith('Dropped'))).toHaveLength(6);
    expect(r.counts).toEqual({ pending: 0, approvedCarried: 0, setAside: 0 });
  });

  it('keeps a properly declared new KPI as PENDING with newKpi — and creates no definition', async () => {
    state.reply = answer([{ targetKey: 'kpi:new:orders_per_region', newKpi: { kpiKey: 'orders_per_region', label: 'Orders by region', unit: 'count' }, transform: long('Orders', { dimensionField: 'Region' }) }]);
    await proposeMapping(CN, ID, opts);
    expect(state.suggestionCreates[0]).toMatchObject({
      targetKey: 'kpi:new:orders_per_region', status: 'PENDING',
      newKpi: { kpiKey: 'orders_per_region', label: 'Orders by region', unit: 'count' },
      transform: { mode: 'long', valueField: 'Orders', periodField: 'Month', dimensionField: 'Region' },
    });
    expect(state.forbidden).toEqual([]);
  });

  it('a "new" KPI that already exists maps to the existing key', async () => {
    state.reply = answer([{ targetKey: 'kpi:new:revenue', newKpi: { kpiKey: 'revenue', label: 'Revenue' }, transform: long('Revenue') }]);
    await proposeMapping(CN, ID, opts);
    expect(state.suggestionCreates[0].targetKey).toBe('kpi:revenue');
    expect(state.suggestionCreates[0].newKpi).toBeUndefined(); // column left NULL
  });

  it('a KPI fed by another integration is SET_ASIDE (one field, one owner)', async () => {
    state.reply = answer([{ targetKey: 'kpi:theirs', transform: long('Revenue') }]);
    await proposeMapping(CN, ID, opts);
    expect(state.suggestionCreates[0].status).toBe('SET_ASIDE');
    expect(state.suggestionCreates[0].reason).toContain('another integration');
  });

  it('arithmetic beats the model: never-populated and text columns are SET_ASIDE with numbers', async () => {
    state.reply = answer([
      { targetKey: 'kpi:revenue', transform: long('Empty') },
      { targetKey: 'kpi:orders', transform: long('Status') },
    ]);
    const r = await proposeMapping(CN, ID, opts);
    expect(byKey()['kpi:revenue']).toMatchObject({ status: 'SET_ASIDE' });
    expect(byKey()['kpi:revenue'].reason).toContain('0 of 6 cells');
    expect(byKey()['kpi:orders'].reason).toContain('only 0 of 6');
    expect(r.counts.setAside).toBe(2);
  });

  it('supports the wide (unpivot) layout', async () => {
    state.read = {
      records: [{ Region: 'North', 'Jan 2026': '10', 'Feb 2026': '12' }, { Region: 'South', 'Jan 2026': '7', 'Feb 2026': '' }],
      headers: ['Region', 'Jan 2026', 'Feb 2026'], rowCount: 2, truncated: false, anomalies: [], sourceLabel: 'Wide',
    };
    state.reply = answer([{ targetKey: 'kpi:revenue', transform: { mode: 'wide', columns: ['Jan 2026', 'Feb 2026'], periodFrom: 'header', dimensionField: 'Region' } }]);
    await proposeMapping(CN, ID, opts);
    expect(state.suggestionCreates[0]).toMatchObject({
      status: 'PENDING', sourceField: 'Jan 2026',
      transform: { mode: 'wide', columns: ['Jan 2026', 'Feb 2026'], periodFrom: 'header', dimensionField: 'Region' },
    });
    expect(state.suggestionCreates[0].reason).toContain('3 distinct readings');
  });
});

describe('DEF-354 proposer — a truncated answer is never saved', () => {
  it('missing sentinel ⇒ error, nothing saved', async () => {
    state.reply = JSON.stringify({ summary: 's', rows: [{ targetKey: 'kpi:revenue', transform: long('Revenue') }], notices: [] });
    await expect(proposeMapping(CN, ID, opts)).rejects.toBeInstanceOf(ProposalError);
    expect(state.transactions).toBe(0);
    expect(state.versionCreates).toHaveLength(0);
  });

  it('cut-off JSON ⇒ error; "complete": "true" (a string) is not the sentinel', () => {
    expect(() => parseProposerAnswer('{"summary":"s","rows":[{"targetKey":"kpi:rev')).toThrow(ProposalError);
    expect(() => parseProposerAnswer('{"rows":[],"complete":"true"}')).toThrow(/incomplete/);
    expect(() => parseProposerAnswer('Here you go: {"rows":[],"complete":true}')).toThrow(ProposalError);
  });

  it('accepts one surrounding code fence', () => {
    expect(parseProposerAnswer('```json\n{"summary":"ok","rows":[],"notices":["n"],"complete":true}\n```'))
      .toEqual({ summary: 'ok', rows: [], notices: ['n'] });
  });
});

describe('DEF-354 proposal jobs', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('refuses until the connection passed its test', async () => {
    state.connectionOk = false;
    await expect(startProposalJob(CN, ID, opts)).rejects.toMatchObject({ code: 'INTEGRATION_INPUT', field: 'connection' });
    expect(state.llmCalls).toHaveLength(0);
  });

  it('same inputs → the same running job; different inputs → 409', async () => {
    let release!: (v: string) => void;
    state.reply = () => new Promise<string>((r) => { release = r; });
    const a = await startProposalJob(CN, ID, opts);
    const b = await startProposalJob(CN, ID, { actorId: 8 });
    expect(b.jobId).toBe(a.jobId);
    const busy = await startProposalJob(CN, ID, { actorId: 7, prompt: 'something else' }).catch((e) => e);
    expect(busy).toBeInstanceOf(ProposalBusyError);
    expect(busy.code).toBe('RUN_BUSY');
    await settle();
    expect(getProposalJob(CN, ID, a.jobId)).toMatchObject({ state: 'running', stage: 'Asking the AI what each column means' });
    release(answer([{ targetKey: 'kpi:revenue', transform: long('Revenue') }]));
    await settle(); await settle();
    const done = getProposalJob(CN, ID, a.jobId)!;
    expect(done).toMatchObject({ state: 'done', error: null, result: { mappingVersion: 1, counts: { pending: 1 } } });
    expect(done.finishedAt).not.toBeNull();
    expect(state.llmCalls).toHaveLength(1);
    // After it finished, a new proposal starts a new job.
    const c = await startProposalJob(CN, ID, { actorId: 7, prompt: 'something else' });
    expect(c.jobId).not.toBe(a.jobId);
  });

  it('a job is invisible to another tenant or integration', async () => {
    const { jobId } = await startProposalJob(CN, ID, opts);
    expect(getProposalJob('TMC-9999', ID, jobId)).toBeNull();
    expect(getProposalJob(CN, 'integ-2', jobId)).toBeNull();
    expect(getProposalJob(CN, ID, 'nope')).toBeNull();
  });

  it('a failed proposal is a failed job with admin words, not a throw', async () => {
    state.reply = '{"rows":[]}';
    const { jobId } = await startProposalJob(CN, ID, opts);
    await settle(); await settle();
    expect(getProposalJob(CN, ID, jobId)).toMatchObject({ state: 'failed', result: null });
    expect(getProposalJob(CN, ID, jobId)!.error).toContain('incomplete');
  });

  it('finished jobs are swept after the TTL', async () => {
    const { jobId } = await startProposalJob(CN, ID, opts);
    await settle(); await settle();
    expect(getProposalJob(CN, ID, jobId)).not.toBeNull();
    expect(sweepProposalJobs(Date.now() + 3_600_001)).toBe(1);
    expect(getProposalJob(CN, ID, jobId)).toBeNull();
  });
});
