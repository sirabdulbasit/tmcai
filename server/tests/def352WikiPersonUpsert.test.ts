/**
 * DEF-352 `wiki-page-duplicate-insert` — the entity-person page INSERT
 * conflicts on the index that actually fires, and REUSES the existing page.
 *
 * Live defect (analyst, ~2/day): `duplicate key value violates unique
 * constraint … (client_number, user_id, page_type, title)=(TMC-0001, 2,
 * entity_person, Umair Bin Wasim) already exists`. The INSERT guarded
 * `ON CONFLICT (id) DO NOTHING` — the id PK — but the conflict that fires in
 * production is the COMPOSITE unique `wiki_pages_user_title_idx` (verified
 * against pg_indexes: plain, not partial): a same-titled person page already
 * exists under a DIFFERENT id, so the guard never matched and Brain's memory
 * of that person failed to refresh, ~2 times a day, every day.
 *
 * Under test:
 *  - a clean insert returns the deterministic id with created=true;
 *  - a composite conflict REUSES the existing row (RETURNING tells us which
 *    row won) — the caller links to the REAL page, created=false, no throw;
 *  - the SQL targets the composite index, not the id PK.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const state = vi.hoisted(() => ({
  inserts: [] as Array<{ sql: string; params: any[] }>,
  /** null = echo the deterministic id (clean insert); string = conflict winner */
  conflictWinner: null as string | null,
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/db/prisma', () => {
  const p: any = {
    user: {
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
      count: async () => 0,
    },
    wikiPage: {
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
    },
    $queryRawUnsafe: async (sql: string, ...params: any[]) => {
      if (sql.includes('INSERT INTO wiki_pages')) {
        state.inserts.push({ sql, params });
        return [{ id: state.conflictWinner ?? params[0] }];
      }
      return [];
    },
    $executeRawUnsafe: async () => 0,
  };
  return { __esModule: true, default: p, prisma: p };
});

import { ensureEntityForSender } from '../src/services/knowledge/entitySweepService';

beforeEach(() => { state.inserts = []; state.conflictWinner = null; });

const INPUT = {
  clientNumber: 'TMC-0001',
  userId: 2,
  senderEmail: 'umair.wasim@gmail.com',
  senderName: 'Umair Bin Wasim',
} as any;

describe('DEF-352 — person pages upsert on the index that actually fires', () => {
  it('clean insert: deterministic id, created=true, and the SQL targets the composite unique with RETURNING', async () => {
    const r = await ensureEntityForSender(INPUT);
    expect(state.inserts).toHaveLength(1);
    const { sql, params } = state.inserts[0];
    expect(sql).toContain('ON CONFLICT (client_number, user_id, page_type, title)');
    expect(sql).toContain('RETURNING id');
    expect(sql).not.toContain('ON CONFLICT (id)');
    expect(r).toEqual({ id: params[0], created: true });
  });

  it('composite conflict: the existing page is REUSED — caller gets the REAL id, created=false, no 23505', async () => {
    state.conflictWinner = 'pre-existing-cuid-row';
    const r = await ensureEntityForSender(INPUT);
    expect(r).toEqual({ id: 'pre-existing-cuid-row', created: false });
  });

  it('source pin: the old id-PK guard is gone from the person-page insert', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/knowledge/entitySweepService.ts'), 'utf8');
    const insertAt = src.indexOf("'entity_person', $4, 'postgres'");
    const block = src.slice(insertAt - 600, insertAt + 600);
    expect(block).toContain('ON CONFLICT (client_number, user_id, page_type, title)');
    expect(block).toContain('DO UPDATE SET last_updated_at = NOW()');
    expect(block).not.toContain('ON CONFLICT (id) DO NOTHING');
  });
});
