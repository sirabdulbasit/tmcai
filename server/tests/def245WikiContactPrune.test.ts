/**
 * DEF-245 — Prune works on the store the Contacts page renders.
 *
 * 2026-08-25. The owner pressed Prune, the duplicate contacts stayed, and he asked "after Prune i
 * am stil seeing this why?" Because Prune worked on `prisma.entity` while the page queries
 * `wiki_pages WHERE page_type='entity_person'` — 773 rows against 703, two parallel stores. Prune
 * ran correctly and invisibly. "Hamna ABAP TMC" is not an entity at all; only one Hamna entity
 * exists.
 *
 * The two rules under test are the ones that separate a merge you can trust from one that fuses
 * two colleagues:
 *   · a LID is RESOLVED from feed evidence, never guessed
 *   · duplicates group on an EXACT identifier, never on a name
 *
 * and the third that makes both safe to be wrong about: nothing is deleted, only archived, with
 * the absorbing page recorded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryRaw = vi.fn();
const execRaw = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: {
    $queryRawUnsafe: (...a: any[]) => queryRaw(...a),
    $executeRawUnsafe: (...a: any[]) => execRaw(...a),
  },
}));

import { pruneWikiContacts } from '../src/services/knowledge/wikiContactPruneService';

describe('DEF-245 — pruning the visible contact store', () => {
  beforeEach(() => { queryRaw.mockReset(); execRaw.mockReset(); });

  it('a dry run COUNTS and changes nothing — the button scans before it acts', async () => {
    queryRaw.mockResolvedValue([{ dupes: 10 }]);
    const r = await pruneWikiContacts('TMC-0001', { dryRun: true });
    expect(r.duplicatesArchived).toBe(10);
    expect(execRaw).not.toHaveBeenCalled();
  });

  it('defaults to a dry run, so an accidental call cannot mutate contacts', async () => {
    queryRaw.mockResolvedValue([{ dupes: 0 }]);
    const r = await pruneWikiContacts('TMC-0001');
    expect(r.dryRun).toBe(true);
    expect(execRaw).not.toHaveBeenCalled();
  });

  it('resolves LIDs BEFORE archiving — reversing it would leave Hamna duplicated', async () => {
    execRaw.mockResolvedValue(1);
    await pruneWikiContacts('TMC-0001', { dryRun: false });
    const [first, second] = execRaw.mock.calls.map((c) => String(c[0]));
    expect(first).toContain('waLid');        // the resolve pass
    expect(second).toContain('archived');    // the merge pass, after it
  });

  it('ARCHIVES rather than deletes, recording which page absorbed the row', async () => {
    execRaw.mockResolvedValue(1);
    await pruneWikiContacts('TMC-0001', { dryRun: false });
    const archive = String(execRaw.mock.calls[1][0]);
    expect(archive).toContain("SET status = 'archived'");
    expect(archive).toContain('mergedInto');
    expect(archive).not.toMatch(/\bDELETE\b/i);
  });

  it('groups on phone or email — never on the title', async () => {
    execRaw.mockResolvedValue(1);
    await pruneWikiContacts('TMC-0001', { dryRun: false });
    const archive = String(execRaw.mock.calls[1][0]);
    expect(archive).toContain('PARTITION BY client_number, user_id, k');
    expect(archive).not.toMatch(/PARTITION BY[^)]*title/i);
  });

  it('is tenant-scoped on every statement it runs', async () => {
    execRaw.mockResolvedValue(0);
    await pruneWikiContacts('TMC-0001', { dryRun: false });
    execRaw.mock.calls.forEach((c) => {
      expect(String(c[0])).toContain('client_number = $1');
      expect(c[1]).toBe('TMC-0001');
    });
  });

  it('survives a failing LID pass and still attempts the merge', async () => {
    execRaw.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(3);
    const r = await pruneWikiContacts('TMC-0001', { dryRun: false });
    expect(r.duplicatesArchived).toBe(3);
  });
});
