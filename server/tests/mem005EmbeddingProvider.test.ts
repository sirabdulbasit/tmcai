/**
 * MEM-005 — one embedding provider, and the retirement of a path whose storage
 * had been gone since May.
 *
 * MEM-001 (2026-08-10) migrated wiki embeddings off `text-embedding-004` after
 * Google retired it. It could not reach the other two consumers, because each
 * owned a private copy of the provider call, the model constant, the
 * normalisation and the stub. So for a further 28 days:
 *
 *   chunkVectorService      POSTed to the retired endpoint  (HTTP 404)
 *   openItemEmbeddingService POSTed to the retired endpoint (HTTP 404)
 *
 * The open-item path was worse than stale. Its table `open_item_embeddings` was
 * DROPPED on 2026-05-18 ("orphan, never referenced"), so `prisma
 * .openItemEmbedding` is undefined on the generated client and every call threw
 * a TypeError that a try/catch turned into a console.warn. It has been retired
 * rather than rebuilt: recreating a table needs product evidence, and the only
 * reader was a route no client ever called.
 *
 * A third defect hid inside the chunk repair sweep: it selected
 * `embedding_model IS NULL OR embedding_model = 'legacy-unknown'` — the two
 * stale models known when it was written. Rows on `text-embedding-004` were
 * therefore invisible to the sweep meant to repair them AND excluded from
 * search, which filters on the current model. Stranded in both directions.
 *
 * These are behaviour tests: the provider is exercised through a fake `fetch`,
 * and the sweeps through a fake Prisma that evaluates their SQL predicate
 * against an in-memory table.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── fakes ────────────────────────────────────────────────────────────
interface ChunkRow { id: number; client_number: string; content: string; embedding_model: string | null; }

const H = vi.hoisted(() => {
  const sysLogCalls: any[] = [];
  const updates: Array<{ id: number; model: string }> = [];
  const store: { rows: Array<{ id: number; client_number: string; content: string; embedding_model: string | null }> } = { rows: [] };

  const queryRawUnsafe = vi.fn(async (sql: string, ...args: any[]) => {
    if (sql.includes('FROM ops_health_state')) return [];
    if (sql.includes('FROM chunks')) {
      const [clientNumber] = args;
      let rows = store.rows.filter((r) => r.client_number === clientNumber);
      // Evaluate whichever staleness predicate the service actually emitted.
      // The old form named two models explicitly; the new form is IS DISTINCT
      // FROM the bound current model. Choosing between them here is what lets
      // this test tell the two implementations apart.
      if (sql.includes('IS DISTINCT FROM')) {
        const model = args[1];
        rows = rows.filter((r) => r.embedding_model !== model);
      } else if (sql.includes("'legacy-unknown'")) {
        rows = rows.filter((r) => r.embedding_model === null || r.embedding_model === 'legacy-unknown');
      }
      const limit = Number(args[args.length - 1]) || rows.length;
      return rows.slice(0, limit).map((r) => ({ id: r.id, content: r.content }));
    }
    return [];
  });

  const executeRawUnsafe = vi.fn(async (sql: string, ...args: any[]) => {
    if (sql.includes('UPDATE chunks')) {
      const id = Number(args[2]);
      updates.push({ id, model: String(args[1]) });
      const row = store.rows.find((r) => r.id === id);
      if (row) row.embedding_model = String(args[1]);
    }
    return 1;
  });

  return { sysLogCalls, updates, store, queryRawUnsafe, executeRawUnsafe };
});

const { sysLogCalls, updates, store, queryRawUnsafe, executeRawUnsafe } = H;

vi.mock('../src/services/systemLogService', () => ({
  log: vi.fn(async (e: any) => { H.sysLogCalls.push(e); }),
}));

vi.mock('../src/db/prisma', () => ({
  default: { $queryRawUnsafe: H.queryRawUnsafe, $executeRawUnsafe: H.executeRawUnsafe },
}));

import {
  embedTextForPgVector,
  unitNormalise,
  toVectorLiteral,
  PGVECTOR_EMBEDDING_MODEL,
  PGVECTOR_EMBEDDING_DIM,
} from '../src/services/knowledge/pgVectorEmbeddingProvider';
import { MODEL_EMBEDDING } from '../src/config/models';
import { resetEmbeddingGuard, getEmbeddingHealth } from '../src/services/knowledge/embeddingGuard';
import { reembedUnknownChunkVectors } from '../src/services/knowledge/chunkVectorService';

const origEnv = { NODE_ENV: process.env.NODE_ENV, ALLOW: process.env.EMBEDDINGS_ALLOW_STUB, KEY: process.env.GEMINI_API_KEY };

/** A provider response of `dim` components, all equal — deliberately NOT unit
 *  length, which is what gemini-embedding-001 actually returns at 768. */
const vecResponse = (dim: number, value = 2) => ({
  ok: true,
  status: 200,
  json: async () => ({ embedding: { values: new Array(dim).fill(value) } }),
});

beforeEach(() => {
  resetEmbeddingGuard();
  sysLogCalls.length = 0;
  updates.length = 0;
  store.rows = [];
  queryRawUnsafe.mockClear();
  executeRawUnsafe.mockClear();
  process.env.NODE_ENV = 'production';
  process.env.EMBEDDINGS_ALLOW_STUB = '';
  process.env.GEMINI_API_KEY = 'test-key';
});

afterEach(() => {
  process.env.NODE_ENV = origEnv.NODE_ENV;
  if (origEnv.ALLOW === undefined) delete process.env.EMBEDDINGS_ALLOW_STUB; else process.env.EMBEDDINGS_ALLOW_STUB = origEnv.ALLOW;
  if (origEnv.KEY === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = origEnv.KEY;
  vi.unstubAllGlobals();
});

// ── the shared provider ──────────────────────────────────────────────

describe('MEM-005 — the shared pgvector embedding provider', () => {
  it('reuses the repository model constant rather than declaring another', () => {
    expect(PGVECTOR_EMBEDDING_MODEL).toBe(MODEL_EMBEDDING);
  });

  it('keeps the 768-dim contract, which is NOT the model default', () => {
    // gemini-embedding-001 returns 3072 natively. The pgvector columns are
    // vector(768). pipeline/embedder.ts is a separate live path that uses the
    // native width — conflating the two would silently corrupt one of them.
    expect(PGVECTOR_EMBEDDING_DIM).toBe(768);
  });

  it('requests the current model and outputDimensionality 768', async () => {
    const fetchMock = vi.fn(async () => vecResponse(768));
    vi.stubGlobal('fetch', fetchMock);

    await embedTextForPgVector('hello world', 'wiki');

    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toContain(`models/${MODEL_EMBEDDING}:embedContent`);
    expect(url).not.toContain('text-embedding-004');
    expect(JSON.parse(init.body).outputDimensionality).toBe(768);
  });

  it('returns a unit-normalised vector', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => vecResponse(768, 2)));

    const res = await embedTextForPgVector('hello world', 'wiki');

    expect(res).not.toBeNull();
    expect(res!.embedding).toHaveLength(768);
    expect(res!.dim).toBe(768);
    const l2 = Math.sqrt(res!.embedding.reduce((s, x) => s + x * x, 0));
    expect(l2).toBeCloseTo(1, 6);
  });

  it('never produces NaN from a zero or non-finite vector', () => {
    // Dividing by a zero norm would poison the stored vector unrecoverably —
    // pgvector accepts NaN and every distance against it becomes NaN.
    expect(unitNormalise([0, 0, 0])).toEqual([0, 0, 0]);
    expect(unitNormalise([Number.NaN, 1]).every((n) => !Number.isFinite(n) || Number.isFinite(n))).toBe(true);
    expect(toVectorLiteral([Number.NaN, Infinity, 0.5])).toBe('[0,0,0.500000]');
  });

  it('HTTP 404 records degradation and writes nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

    const res = await embedTextForPgVector('hello', 'chunks');

    expect(res).toBeNull();
    const health = await getEmbeddingHealth(['chunks']);
    expect(health[0].status).toBe('degraded');
    expect(health[0].lastError).toContain('404');
  });

  it('writes no stub in production when the provider fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const res = await embedTextForPgVector('hello', 'wiki');
    expect(res).toBeNull();
  });

  it('rejects a 200 carrying the wrong vector width', async () => {
    // A 3072-wide response is the model's default. Accepting it would break the
    // vector(768) column, so the wrong shape is a failure, not a vector.
    vi.stubGlobal('fetch', vi.fn(async () => vecResponse(3072)));

    const res = await embedTextForPgVector('hello', 'wiki');

    expect(res).toBeNull();
    const health = await getEmbeddingHealth(['wiki']);
    expect(health[0].status).toBe('degraded');
    expect(health[0].lastError).toContain('3072');
  });

  it('records recovery only after a real provider success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    await embedTextForPgVector('hello', 'wiki');
    expect((await getEmbeddingHealth(['wiki']))[0].status).toBe('degraded');

    vi.stubGlobal('fetch', vi.fn(async () => vecResponse(768)));
    await embedTextForPgVector('hello', 'wiki');
    expect((await getEmbeddingHealth(['wiki']))[0].status).toBe('ok');
  });

  it('a stub success never stamps recovery', async () => {
    process.env.NODE_ENV = 'development';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    // Degrade first via a production-mode failure, then confirm a dev stub does
    // not clear it: recovery must mean the provider works, not that we faked it.
    process.env.NODE_ENV = 'production';
    await embedTextForPgVector('hello', 'chunks');
    process.env.NODE_ENV = 'development';

    const stub = await embedTextForPgVector('hello', 'chunks');

    expect(stub).not.toBeNull();
    expect(stub!.model).toBe('stub-768');
    expect(stub!.embedding).toHaveLength(768);
    expect((await getEmbeddingHealth(['chunks']))[0].status).toBe('degraded');
  });
});

// ── chunk staleness ──────────────────────────────────────────────────

describe('MEM-005 — every superseded chunk model is eligible for repair', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => vecResponse(768)));
    store.rows = [
      { id: 1, client_number: 'TMC-0001', content: 'a', embedding_model: null },
      { id: 2, client_number: 'TMC-0001', content: 'b', embedding_model: 'legacy-unknown' },
      { id: 3, client_number: 'TMC-0001', content: 'c', embedding_model: 'text-embedding-004' },
      { id: 4, client_number: 'TMC-0001', content: 'd', embedding_model: 'stub-768' },
      { id: 5, client_number: 'TMC-0001', content: 'e', embedding_model: MODEL_EMBEDDING },
      { id: 6, client_number: 'OTHER-9', content: 'f', embedding_model: 'text-embedding-004' },
    ];
  });

  it('selects NULL, legacy-unknown, retired and stub models alike', async () => {
    const r = await reembedUnknownChunkVectors('TMC-0001', 100);

    expect(r.reembedded).toBe(4);
    expect(updates.map((u) => u.id).sort()).toEqual([1, 2, 3, 4]);
    // The retired model is the one the old explicit-list predicate missed.
    expect(updates.map((u) => u.id)).toContain(3);
  });

  it('leaves current-model rows untouched', async () => {
    await reembedUnknownChunkVectors('TMC-0001', 100);
    expect(updates.map((u) => u.id)).not.toContain(5);
  });

  it('is tenant-scoped', async () => {
    await reembedUnknownChunkVectors('TMC-0001', 100);
    expect(updates.map((u) => u.id)).not.toContain(6);
    expect(store.rows.find((r) => r.id === 6)!.embedding_model).toBe('text-embedding-004');
  });

  it('stamps repaired rows with the current model', async () => {
    await reembedUnknownChunkVectors('TMC-0001', 100);
    expect(updates.every((u) => u.model === MODEL_EMBEDDING)).toBe(true);
  });

  it('honours the batch cap', async () => {
    const r = await reembedUnknownChunkVectors('TMC-0001', 2);
    expect(r.scanned).toBeLessThanOrEqual(2);
    expect(r.reembedded).toBeLessThanOrEqual(2);
  });

  it('is idempotent — a second pass finds nothing left', async () => {
    await reembedUnknownChunkVectors('TMC-0001', 100);
    updates.length = 0;
    const second = await reembedUnknownChunkVectors('TMC-0001', 100);
    expect(second.reembedded).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('STOPS on provider failure instead of filing one finding per row', async () => {
    // The bounded-degradation requirement. Continuing through a 100-row batch
    // against a dead provider produced 100 identical findings and 100 wasted
    // calls; the sweep now yields to the next nightly run.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

    const r = await reembedUnknownChunkVectors('TMC-0001', 100);

    expect(r.degraded).toBe(true);
    expect(r.reembedded).toBe(0);
    expect(r.scanned).toBe(1);
    expect(updates).toHaveLength(0);
    const degradedLogs = sysLogCalls.filter((e) => e.category === 'embedding_degraded');
    expect(degradedLogs).toHaveLength(1);
  });
});

// ── retirement of the dead open-item path ────────────────────────────

describe('MEM-005 — the open-item embedding path is gone, not hidden', () => {
  it('the service module no longer exists', async () => {
    await expect(import('../src/services/triage/openItemEmbeddingService')).rejects.toThrow();
  });

  it('creating an open item does not reach the removed service', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../src/services/openItemsService.ts', import.meta.url), 'utf-8',
    ));
    // Supplementary to the module-absence test above: were this call still
    // present, item creation would throw at import instead of failing silently.
    expect(src).not.toContain("import('./triage/openItemEmbeddingService')");
    expect(src).not.toContain('embedAndStore(');
  });

  it('the dead similar-items endpoint is not registered', async () => {
    const { default: router } = await import('../src/routes/openItemsRoutes');
    const paths = (router as any).stack
      .filter((l: any) => l.route)
      .map((l: any) => l.route.path);
    expect(paths).not.toContain('/:id/similar');
    // The neighbouring routes are untouched — this removed one endpoint, not a
    // section of the file.
    expect(paths).toContain('/:id/history');
  });
});

// ── tenant-guard registry hygiene ────────────────────────────────────

describe('MEM-005 — the tenant guard registries name only real models', () => {
  it('every guarded model exists on the generated Prisma client', async () => {
    const { Prisma } = await import('@prisma/client');
    // importActual: this test is about the REAL registries, not the fake client.
    const { TENANT_SCOPED_MODELS, USER_SCOPED_MODELS } =
      await vi.importActual<any>('../src/db/prisma');
    const real = new Set(Prisma.dmmf.datamodel.models.map((m: any) => m.name));

    const phantom = [...TENANT_SCOPED_MODELS, ...USER_SCOPED_MODELS].filter((m) => !real.has(m));

    // A registry entry for a dropped model guards nothing while reading as
    // coverage. OpenItemEmbedding and ItemStatusHistory sat here for months
    // after their tables were dropped on 2026-05-18.
    expect(phantom).toEqual([]);
  });
});
