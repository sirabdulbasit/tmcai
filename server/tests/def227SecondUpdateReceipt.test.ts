/**
 * DEF-227 — the field-name receipt came back, from a second implementation
 * that DEF-212, DEF-219 and DEF-220 never touched.
 *
 * `iter-17-post-build.json`, `B04-outstanding-question-ignored`, C6 **75**:
 *
 *     Updated "Define rules for Brain's responsiveness to new vs. existing
 *     contacts": priority=high.
 *
 * That is verbatim the string three consecutive DEFs were written to remove.
 * DEF-220 replaced it on the inline composer branch with a fact composed from
 * the fields — *"The open item "X" was updated: its priority is now high."*
 *
 * **There are two implementations of this update.** `applyOpenItemUpdate` is
 * the shared one, and its own docblock says so — *"the single implementation
 * used by BOTH the inline reasoning path and the confirmed-plan dispatcher"*,
 * written after a confirmed plan died with `[Unknown pending action kind]`. It
 * shares the WRITE. It did not share the RECEIPT: it built its own
 * `Updated "…": …` string, and on the confirmed path that string IS the reply.
 *
 * So the class is `protection-with-two-implementations`, and the shape is the
 * one this session has now hit four times: a fix lands on one path while the
 * live turn goes through the other (DEF-222 → DEF-223 was the same story about
 * `assembleSystemPrompt` versus `reasoningCompose`).
 *
 * The fix keeps the receipt — DEF-144 ruled it stays the audit record — and
 * stops it being the sentence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const findFirst = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());

vi.mock('../src/db/prisma', () => ({
  default: { openItem: { findFirst, update } },
}));
vi.mock('../src/utils/logger', () => ({
  default: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { applyOpenItemUpdate } from '../src/services/openItems/applyOpenItemUpdate';
import { curatedMarkerMeaning } from '../src/services/knowledge/answerSanitizer';
import { isSystemMarker, stripMarkerEnvelope } from '../src/services/knowledge/systemMarker';

const B04_TITLE = "Define rules for Brain's responsiveness to new vs. existing contacts";

const ITEM = {
  id: 'item-b04', title: B04_TITLE, status: 'DRAFT',
  priority: 'medium', dueDate: null, metadata: null,
};

const meaningOf = (m: string) => curatedMarkerMeaning(stripMarkerEnvelope(m));

beforeEach(() => {
  findFirst.mockReset();
  update.mockReset();
  findFirst.mockResolvedValue(ITEM);
  update.mockResolvedValue({ id: 'item-b04' });
});

const apply = (over: Record<string, unknown> = {}) => applyOpenItemUpdate({
  clientNumber: 'TMC-0001', userId: 2, openItemId: 'item-b04', priority: 'high', ...over,
} as any);

describe('DEF-227 — THE B04 STRING, on the path that produced it', () => {
  it('the owner-facing value is no longer the field-name receipt', async () => {
    const r = await apply();
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain('priority=high');
    expect(r.message).not.toContain(`Updated "${B04_TITLE}"`);
  });

  it('it is a stamped marker whose meaning is composed from the fields', async () => {
    const r = await apply();
    expect(isSystemMarker(r.message)).toBe(true);
    expect(meaningOf(r.message))
      .toBe(`The open item "${B04_TITLE}" was updated: its priority is now high.`);
  });

  it('the receipt still exists, unchanged, as the AUDIT record (DEF-144)', async () => {
    const r = await apply();
    expect(r.receipt).toBe(`Updated "${B04_TITLE}": priority=high.`);
  });

  it('the applied fields travel as DATA, from the payload the database received', async () => {
    const r = await apply({ dueDateRaw: undefined, title: 'Renamed item' });
    expect(r.applied).toEqual([
      { f: 'priority', v: 'high' },
      { f: 'title', v: 'Renamed item' },
    ]);
    expect(r.title).toBe('Renamed item');
  });

  it('the DRAFT→NEW transition is stated in his words, not the schema\'s', async () => {
    findFirst.mockResolvedValue({ ...ITEM, dueDate: new Date('2026-08-20T00:00:00Z') });
    const meaning = meaningOf((await apply()).message)!;
    expect(meaning).toContain('it is now a live item rather than a draft');
    expect(meaning, 'NEW is a schema word').not.toContain('NEW');
  });
});

describe('DEF-227 — fail-closed is unchanged', () => {
  it('an internal-only payload keeps the RECEIPT as the message', async () => {
    // Nothing in the shared vocabulary was written, so no fact can be composed.
    // An uncurated marker would reach him as the neutral fallback, which says
    // less than the true-by-construction receipt — the DEF-220 rule, unchanged.
    const r = await apply({ priority: 'not-a-priority', note: undefined, title: undefined });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('no recognised fields');
  });

  it('a missing item still returns its bracketed error, not a marker', async () => {
    findFirst.mockResolvedValue(null);
    const r = await apply();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('id not found');
    expect(isSystemMarker(r.message)).toBe(false);
  });

  it('an unnormalisable priority is DROPPED, and the fact never claims it', async () => {
    // Written expecting `applied` to be empty; it is not, because `note` maps to
    // `description`, which IS in the shared vocabulary. Recording the real
    // behaviour rather than bending it to my guess — and the property that
    // actually matters is stronger: "urgent-ish" was not written, so the fact
    // must not mention a priority at all.
    const r = await apply({ priority: 'urgent-ish', note: 'owner context' });
    expect(r.applied).toEqual([{ f: 'description', v: 'owner context' }]);
    const meaning = meaningOf(r.message)!;
    expect(meaning).toContain('its note has been updated');
    expect(meaning, 'a dropped field is never claimed').not.toMatch(/priority/i);
    expect(r.receipt, 'and the audit receipt does not claim it either')
      .not.toMatch(/priority=/);
  });
});

describe('DEF-227 — one vocabulary, and the confirmed caller passes the fact through', () => {
  const src = (rel: string) => {
    const raw = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
    // Comments stripped: a guard must read code, not prose about it (DEF-195).
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  };

  it('the shared module imports the vocabulary rather than restating it', () => {
    const mod = src('src/services/openItems/applyOpenItemUpdate.ts');
    expect(mod).toMatch(/import \{\s*appliedChanges,\s*actionAppliedMarker,/);
    expect(mod, 'no second sentence composer here')
      .not.toContain('was updated: its priority');
  });

  it('the confirmed-plan caller returns `r.message`, not `r.receipt`', () => {
    const composer = src('src/services/knowledge/brainComposer.ts');
    expect(composer).toMatch(/return \{ ok: r\.ok, artifactId: r\.artifactId, message: r\.message \};/);
    expect(composer, 'returning the receipt here is the defect')
      .not.toMatch(/message: r\.receipt/);
  });

  it('BOTH update paths now build the marker from the same two helpers', () => {
    // The inline branch (DEF-220) and the shared module (DEF-227). If a third
    // producer appears without them, this count is the thing that notices.
    const composer = src('src/services/knowledge/brainComposer.ts');
    const mod = src('src/services/openItems/applyOpenItemUpdate.ts');
    for (const [name, code] of [['composer', composer], ['shared module', mod]] as const) {
      expect(code, `${name}: appliedChanges`).toMatch(/appliedChanges\(/);
      expect(code, `${name}: actionAppliedMarker`).toMatch(/actionAppliedMarker\(\{/);
    }
  });
});
