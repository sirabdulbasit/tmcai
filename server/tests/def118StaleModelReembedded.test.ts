/**
 * DEF-118 — 63% of Brain's wiki memory was indexed with a stub, and the repair
 * sweep could never repair it.
 *
 * Production, 2026-08-11 06:00:
 *
 *   embedding_model = 'stub-768'              7,893 pages
 *   embedding_model = 'gemini-embedding-001'  4,590 pages
 *   embedding IS NULL                             0 pages
 *
 * `stub-768` is the deterministic hash-based placeholder used when no provider
 * is configured. Its vectors carry no meaning, and distances between two
 * embedding spaces are not comparable, so those pages returned confident
 * nonsense rather than nothing.
 *
 * `sweepWikiEmbeddings` selects exactly these pages — `embedding_model IS
 * DISTINCT FROM MODEL_GEMINI` — and had been doing so every ~50 minutes for 21
 * hours, embedding none, filing `embedding_provider_degraded` on each run while
 * the provider was healthy (verified HTTP 200 against gemini-embedding-001).
 *
 * The cause was one line in `embedWikiPage`:
 *
 *     if (page.hash === h && !page.embeddingNull) return;
 *
 * Text unchanged plus a vector present — both true of a stub page — so it
 * returned before embedding. Two definitions of "needs embedding", disagreeing:
 * the sweep's included the model, the writer's did not. Fifth recurrence of
 * `protection-with-two-implementations`.
 *
 * It also hid itself: `count(embedding)` reports a stub row as embedded, which
 * is why this memory was reported as fully indexed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const queryRawUnsafe = vi.fn();
const executeRawUnsafe = vi.fn(async () => 1);
vi.mock('../src/db/prisma', () => ({
  default: {
    $queryRawUnsafe: (...a: any[]) => queryRawUnsafe(...a),
    $executeRawUnsafe: (...a: any[]) => executeRawUnsafe(...a),
  },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', (...a: any[]) => fetchMock(...a));

import { embedWikiPage } from '../src/services/knowledge/wikiEmbeddingService';

const GEMINI = 'gemini-embedding-001';
const DIM = 768;

/** A page whose text is unchanged, holding a vector from `model`. */
function pageRow(model: string | null) {
  return [{
    title: 'Vision Metric — service sales package',
    bodyMarkdown: 'The package covers the service sales video and its delivery dates.',
    // Filled in by the caller so the hash matches whatever the code computes.
    hash: '__MATCHING__',
    model,
    embeddingNull: false,
  }];
}

/** Make the stored hash equal the hash the code will compute for this text. */
function withMatchingHash(rows: any[]) {
  const crypto = require('crypto');
  const composed = `${rows[0].title}\n\n${rows[0].bodyMarkdown}`;
  rows[0].hash = crypto.createHash('sha256').update(composed).digest('hex');
  return rows;
}

const okEmbedding = () => ({
  ok: true,
  json: async () => ({ embedding: { values: Array.from({ length: DIM }, (_, i) => (i % 7) / 10 + 0.01) } }),
});

beforeEach(() => {
  queryRawUnsafe.mockReset();
  executeRawUnsafe.mockReset();
  executeRawUnsafe.mockResolvedValue(1);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okEmbedding());
  process.env.GEMINI_API_KEY = 'test-key';
});

describe('a page carrying a stale vector gets re-embedded', () => {
  it('re-embeds a stub-768 page even though its text has not changed', async () => {
    queryRawUnsafe.mockResolvedValueOnce(withMatchingHash(pageRow('stub-768')));
    await embedWikiPage('page-1');
    // The write is the whole point — before DEF-118 this made zero calls.
    expect(fetchMock, 'provider must be called for a stub page').toHaveBeenCalled();
    expect(executeRawUnsafe, 'the new vector must be written').toHaveBeenCalled();
    const [sql, , model] = executeRawUnsafe.mock.calls[0];
    expect(String(sql)).toMatch(/SET embedding = \$1::vector/);
    expect(model).toBe(GEMINI);
  });

  it('re-embeds a page embedded by any superseded model', async () => {
    queryRawUnsafe.mockResolvedValueOnce(withMatchingHash(pageRow('text-embedding-004')));
    await embedWikiPage('page-1');
    expect(executeRawUnsafe).toHaveBeenCalled();
  });

  it('re-embeds a page whose model was never recorded', async () => {
    queryRawUnsafe.mockResolvedValueOnce(withMatchingHash(pageRow(null)));
    await embedWikiPage('page-1');
    expect(executeRawUnsafe).toHaveBeenCalled();
  });
});

describe('the skip that must survive — this is not a licence to re-embed everything', () => {
  it('still skips a current-model page whose text has not changed', async () => {
    queryRawUnsafe.mockResolvedValueOnce(withMatchingHash(pageRow(GEMINI)));
    await embedWikiPage('page-1');
    // 12,483 pages swept every 50 minutes would be a self-inflicted rate-limit
    // outage. The hash check is what makes the sweep affordable.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('still embeds a current-model page whose text HAS changed', async () => {
    const rows = withMatchingHash(pageRow(GEMINI));
    rows[0].hash = 'a-stale-hash';
    queryRawUnsafe.mockResolvedValueOnce(rows);
    await embedWikiPage('page-1');
    expect(executeRawUnsafe).toHaveBeenCalled();
  });

  it('reads the model in the same hop — not a second query per page', () => {
    const SRC = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'knowledge', 'wikiEmbeddingService.ts'), 'utf8');
    expect(SRC).toMatch(/embedding_model AS "model"/);
  });
});

describe('the freshness check and the sweep predicate must not drift apart again', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'knowledge', 'wikiEmbeddingService.ts'), 'utf8');

  it('the writer\'s skip condition names the model', () => {
    const m = /if \(page\.hash === h[^\n]*\)\s*return;/.exec(SRC);
    expect(m, 'freshness check not found').not.toBeNull();
    expect(m![0]).toContain('MODEL_GEMINI');
  });

  it('the sweep still selects on the model, so both sides agree', () => {
    expect(SRC).toMatch(/embedding_model IS DISTINCT FROM \$1/);
  });
});

describe('the degraded finding reports what it actually tried', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'knowledge', 'wikiEmbeddingService.ts'), 'utf8');

  it('counts attempts, not selections — the loop breaks on first failure', () => {
    // Reporting 200 attempts for one attempt sent every reader to the provider,
    // which is where 21 hours of this defect's life went.
    expect(SRC).toMatch(/tried \+= 1/);
    expect(SRC).toMatch(/attempted: tried/);
  });

  it('still says how many were selected, so the backlog stays visible', () => {
    expect(SRC).toMatch(/selected: rows\.length/);
  });
});
