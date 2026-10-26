/**
 * DEF-362 — Integrations Stage 1b: the Context writer (engine/contextWriter.ts)
 * and the shared tenant org_doc helper (knowledge/tenantOrgDoc.ts), against an
 * in-memory wiki_pages double.
 *
 * Rules pinned (spec INTEGRATIONS_DESIGN.md §2b "Context writer"):
 *  - per_record pages titled "<integration name> · <record title>", keyed by
 *    record id in metadata {integrationId, recordKey, contentHash, scope:'tenant'};
 *  - table mode = ONE page;
 *  - pages are created scope 'tenant' through the ONE helper;
 *  - unchanged content (hash) is skipped — no write, no change row;
 *  - a blank never overwrites a section;
 *  - records gone from the source ⇒ 'stale', never deleted; not on an
 *    incomplete or empty read; a returning record is re-activated;
 *  - cap integrations.max_context_pages ⇒ truncated + a note;
 *  - a renamed record keeps its page (identity is the record, not the title);
 *  - dry run writes no wiki page;
 *  - every written page gets its change row, right after its write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CN = 'TMC-0001';
const db = vi.hoisted(() => ({
  pages: [] as any[],
  changes: [] as any[],
  writes: [] as string[],
  seq: 0,
  failTitle: null as string | null,
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/services/behaviorConfig', () => ({ getBehaviorValue: async () => 500 }));
vi.mock('../src/services/knowledge/wikiEmbeddingService', () => ({ embedWikiPage: async () => { db.writes.push('embed'); } }));

vi.mock('../src/db/prisma', () => {
  const metaMatch = (row: any, where: any) => {
    if (where.clientNumber && row.clientNumber !== where.clientNumber) return false;
    if (where.pageType && row.pageType !== where.pageType) return false;
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.title !== undefined && row.title !== where.title) return false;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.status?.not !== undefined && row.status === where.status.not) return false;
    if (where.metadata?.path) return row.metadata?.[where.metadata.path[0]] === where.metadata.equals;
    return true;
  };
  const p: any = {
    wikiPage: {
      findFirst: async ({ where }: any) => db.pages.find((r) => metaMatch(r, where)) ?? null,
      findMany: async ({ where }: any) => db.pages.filter((r) => metaMatch(r, where)).map((r) => ({ ...r })),
      create: async ({ data }: any) => {
        db.writes.push('wikiPage.create');
        if (db.failTitle && data.title === db.failTitle) throw Object.assign(new Error('Unique'), { code: 'P2002' });
        const row = { id: `w${++db.seq}`, ...data };
        db.pages.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        db.writes.push('wikiPage.update');
        const r = db.pages.find((x) => x.id === where.id);
        Object.assign(r, data);
        return r;
      },
      updateMany: async ({ where, data }: any) => {
        db.writes.push('wikiPage.updateMany');
        const rows = db.pages.filter((r) => metaMatch(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
      delete: async () => { db.writes.push('wikiPage.delete'); },
      deleteMany: async () => { db.writes.push('wikiPage.deleteMany'); },
    },
    integrationRunChange: {
      create: async ({ data }: any) => { db.writes.push('change.create'); db.changes.push(data); return data; },
      createMany: async ({ data }: any) => { db.writes.push('change.createMany'); db.changes.push(...data); return { count: data.length }; },
    },
  };
  return { __esModule: true, default: p, prisma: p };
});

import {
  planContextPages, writeContextPages, diffContextPages, sha256,
} from '../src/services/integrations/engine/contextWriter';
import { upsertTenantOrgDoc } from '../src/services/knowledge/tenantOrgDoc';
import type { ApprovedContextRow } from '../src/services/integrations/types';

const INTEG = { id: 'i1', name: 'Customers' };
const PER: ApprovedContextRow = { suggestionId: 's1', targetKey: 'context:per_record', transform: { mode: 'per_record', titleField: 'name', bodyFields: ['tier', 'owner'] } };
const TABLE: ApprovedContextRow = { suggestionId: 's2', targetKey: 'context:table', transform: { mode: 'table', columns: ['name', 'tier'] } };
const recs = () => [
  { id: 'A1', name: 'Acme', tier: 'Gold', owner: 'Sara' },
  { id: 'B2', name: 'Beta', tier: 'Silver', owner: 'Ali' },
];
const OPTS = { dryRun: false, runId: 'run1', idField: 'id', userId: 7, maxPages: 500 };

beforeEach(() => { db.pages = []; db.changes = []; db.writes = []; db.seq = 0; db.failTitle = null; });

describe('planContextPages (pure)', () => {
  it('per_record: titled "<integration> · <record title>", keyed by record id, body = Field: value lines', () => {
    const p = planContextPages(INTEG, recs(), [PER], 'id', 500);
    expect(p.pages.map((x) => x.title)).toEqual(['Customers · Acme', 'Customers · Beta']);
    expect(p.pages[0].recordKey).toBe('i1:A1');
    expect(p.pages[0].body).toContain('tier: Gold');
    expect(p.pages[0].contentHash).toBe(sha256(p.pages[0].body));
  });
  it('table: ONE page for the whole set', () => {
    const p = planContextPages(INTEG, recs(), [TABLE], 'id', 500);
    expect(p.pages).toHaveLength(1);
    expect(p.pages[0].recordKey).toBe('i1:table');
    expect(p.pages[0].body).toMatch(/\| Acme \| Gold \|/);
  });
  it('cap ⇒ truncated + a note naming the limit', () => {
    const p = planContextPages(INTEG, recs(), [PER], 'id', 1);
    expect(p.pages).toHaveLength(1);
    expect(p.truncated).toBe(true);
    expect(p.anomalies.join(' ')).toMatch(/max_context_pages/);
  });
  it('same title twice ⇒ disambiguated (wiki_pages title is unique), no collision', () => {
    const p = planContextPages(INTEG, [{ id: '1', name: 'X', tier: 'a', owner: '' }, { id: '2', name: 'X', tier: 'b', owner: '' }], [PER], 'id', 500);
    expect(new Set(p.pages.map((x) => x.title)).size).toBe(2);
  });
});

describe('writeContextPages — live', () => {
  it('creates tenant-scoped org_doc pages through the helper, with metadata and a change row each', async () => {
    const r = await writeContextPages(CN, INTEG, recs(), [PER], OPTS);
    expect(r.created).toBe(2);
    expect(db.pages).toHaveLength(2);
    const pg = db.pages[0];
    expect(pg).toMatchObject({ clientNumber: CN, userId: 7, pageType: 'org_doc', scope: 'tenant', status: 'active', lastUpdatedBy: 'integration', title: 'Customers · Acme' });
    expect(pg.metadata).toMatchObject({ integrationId: 'i1', recordKey: 'i1:A1', contentHash: sha256(pg.bodyMarkdown), scope: 'tenant' });
    expect(db.changes.map((c) => [c.op, c.targetKind, c.subjectKey])).toEqual([['create', 'context', 'i1:A1'], ['create', 'context', 'i1:B2']]);
    // Change row right after its own page write.
    expect(db.writes.filter((w) => w !== 'embed').slice(0, 4)).toEqual(['wikiPage.create', 'change.create', 'wikiPage.create', 'change.create']);
  });

  it('unchanged content is skipped: no write, no change row', async () => {
    await writeContextPages(CN, INTEG, recs(), [PER], OPTS);
    db.writes = []; db.changes = [];
    const r = await writeContextPages(CN, INTEG, recs(), [PER], { ...OPTS, runId: 'run2' });
    expect(r).toMatchObject({ created: 0, updated: 0, unchanged: 2, stale: 0 });
    expect(db.writes.filter((w) => w.startsWith('wikiPage'))).toEqual([]);
    expect(db.changes).toEqual([]);
  });

  it('a blank never overwrites a section: the field keeps its last value', async () => {
    await writeContextPages(CN, INTEG, recs(), [PER], OPTS);
    const next = recs(); next[0].owner = ''; next[0].tier = 'Platinum';
    const r = await writeContextPages(CN, INTEG, next, [PER], { ...OPTS, runId: 'run2' });
    expect(r.updated).toBe(1);
    const acme = db.pages.find((p) => p.metadata.recordKey === 'i1:A1');
    expect(acme.bodyMarkdown).toContain('tier: Platinum');
    expect(acme.bodyMarkdown).toContain('owner: Sara');
  });

  it('a renamed record keeps its page (identity = record id, not title)', async () => {
    await writeContextPages(CN, INTEG, recs(), [PER], OPTS);
    const next = recs(); next[0].name = 'Acme Ltd';
    await writeContextPages(CN, INTEG, next, [PER], { ...OPTS, runId: 'run2' });
    expect(db.pages).toHaveLength(2);
    expect(db.pages.find((p) => p.metadata.recordKey === 'i1:A1').title).toBe('Customers · Acme Ltd');
  });

  it('a record gone from the source is marked stale, never deleted; it comes back active', async () => {
    await writeContextPages(CN, INTEG, recs(), [PER], OPTS);
    const r = await writeContextPages(CN, INTEG, [recs()[0]], [PER], { ...OPTS, runId: 'run2' });
    expect(r.stale).toBe(1);
    expect(db.pages).toHaveLength(2);
    expect(db.pages.find((p) => p.metadata.recordKey === 'i1:B2').status).toBe('stale');
    expect(db.writes).not.toContain('wikiPage.delete');
    expect(db.writes).not.toContain('wikiPage.deleteMany');
    expect(db.changes.at(-1)).toMatchObject({ op: 'stale', subjectKey: 'i1:B2', targetKind: 'context' });
    // Same content returns ⇒ re-activated even though the hash is unchanged.
    const back = await writeContextPages(CN, INTEG, recs(), [PER], { ...OPTS, runId: 'run3' });
    expect(back.updated).toBe(1);
    expect(db.pages.find((p) => p.metadata.recordKey === 'i1:B2').status).toBe('active');
  });

  it('no stale marking on an incomplete or empty read', async () => {
    await writeContextPages(CN, INTEG, recs(), [PER], OPTS);
    const partial = await writeContextPages(CN, INTEG, [recs()[0]], [PER], { ...OPTS, sourceComplete: false });
    expect(partial.stale).toBe(0);
    const empty = await writeContextPages(CN, INTEG, [], [PER], OPTS);
    expect(empty.stale).toBe(0);
    expect(db.pages.every((p) => p.status === 'active')).toBe(true);
  });

  it('a page that fails to write gets no change row, the others still land, and the failure is named', async () => {
    db.failTitle = 'Customers · Beta';
    const r = await writeContextPages(CN, INTEG, recs(), [PER], OPTS);
    expect(r.created).toBe(1);
    expect(db.changes).toHaveLength(1);
    expect(r.anomalies.join(' ')).toMatch(/could not be saved.*Customers · Beta/);
  });
});

describe('writeContextPages — dry run', () => {
  it('writes no wiki page, only preview change rows', async () => {
    const r = await writeContextPages(CN, INTEG, recs(), [PER, TABLE], { ...OPTS, dryRun: true });
    expect(r.created).toBe(3);
    expect(db.pages).toEqual([]);
    expect(db.writes.filter((w) => w.startsWith('wikiPage'))).toEqual([]);
    expect(db.changes).toHaveLength(3);
  });
});

describe('diffContextPages', () => {
  it('ignores stored pages of other records and counts owned', () => {
    const plan = planContextPages(INTEG, recs(), [PER], 'id', 500);
    const d = diffContextPages(plan, [], 2, true);
    expect(d.ops.map((o) => o.op)).toEqual(['create', 'create']);
    expect(d.owned).toBe(0);
  });
});

describe('upsertTenantOrgDoc (the shared helper)', () => {
  it('create = scope tenant, org_doc, given lastUpdatedBy; same hash ⇒ untouched; default actor is facl_scribe', async () => {
    const a = await upsertTenantOrgDoc(CN, { userId: 3, title: 'T', body: 'b', metadata: { contentHash: 'h1' }, contentHash: 'h1', lastUpdatedBy: 'integration' });
    expect(a.changed).toBe(true);
    expect(db.pages[0]).toMatchObject({ scope: 'tenant', pageType: 'org_doc', lastUpdatedBy: 'integration' });
    const b = await upsertTenantOrgDoc(CN, { userId: 3, title: 'T', body: 'b2', metadata: { contentHash: 'h1' }, contentHash: 'h1' });
    expect(b).toEqual({ id: a.id, changed: false });
    const c = await upsertTenantOrgDoc(CN, { userId: 3, title: 'T', body: 'b3', metadata: { contentHash: 'h2' }, contentHash: 'h2' });
    expect(c.changed).toBe(true);
    expect(db.pages[0]).toMatchObject({ bodyMarkdown: 'b3', lastUpdatedBy: 'facl_scribe' });
  });
});
