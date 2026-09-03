/**
 * DEF-303 — the real cause of the 22021 loop, and the guard that keeps the fix from being tidied
 * away.
 *
 * `substring()` on a TOAST-**compressed** text column can be served from a PARTIAL detoast, and
 * the sliced prefix can end mid-character, failing encoding validation. Measured against the
 * live database on 2026-09-03, on the 45 affected `wiki_pages` rows:
 *
 *   length used   old form fails on   new form fails on
 *   800 (person)        45/45                0/45
 *   600 (topic)         20/45                0/45
 *   280 (criticality)   11/45                0/45
 *   220 (brainAsk)      20/45                0/45
 *
 * The counts VARY BY LENGTH, which is the signature of the diagnosis: whether the slice boundary
 * splits a character depends on where you cut, not on what the row contains. Content-based
 * corruption cannot produce that pattern.
 *
 * WHY THIS GUARD EXISTS AT ALL. The fix is `|| ''`. It looks like noise, it reads like a
 * leftover, and removing it restores a ~200k/day error loop with NO visible change in behaviour,
 * because every uncompressed row keeps working. That is precisely the kind of change a future
 * editor makes while cleaning up. So the concatenation is named, and this test fails if any call
 * site goes back to the raw form.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toastSafeSnippet } from '../src/db/toastSafeText';

const SRC = join(__dirname, '..', 'src');

describe('DEF-303 — the snippet expression forces a full detoast', () => {
  it('concatenates, which is the part that does the work', () => {
    const sql = toastSafeSnippet('body_markdown', 800);
    expect(sql).toContain("|| ''");
    expect(sql).toContain('SUBSTRING(');
    expect(sql).toContain('1, 800');
  });

  it('still renders a NULL column as empty, as every call site expected', () => {
    expect(toastSafeSnippet('body_markdown', 220)).toContain("COALESCE(body_markdown,'')");
  });

  it('refuses a nonsense length rather than building invalid SQL', () => {
    // The length is interpolated, so it must be an integer. A caller passing a string is a
    // SQL-injection shape as well as a bug.
    expect(() => toastSafeSnippet('body_markdown', 0)).toThrow();
    expect(() => toastSafeSnippet('body_markdown', -1)).toThrow();
    expect(() => toastSafeSnippet('body_markdown', 1.5)).toThrow();
    expect(() => toastSafeSnippet('body_markdown', '10; DROP TABLE x' as unknown as number)).toThrow();
  });
});

describe('DEF-303 — no call site truncates body_markdown the unsafe way', () => {
  const FILES = [
    'routes/brainAskRoutes.ts',
    'services/triage/criticalityEngineService.ts',
    'services/knowledge/conceptSynthesizerService.ts',
  ];

  it('every known truncation site goes through the helper', () => {
    for (const f of FILES) {
      const src = readFileSync(join(SRC, f), 'utf-8');
      expect(src, f).toContain('toastSafeSnippet');
    }
  });

  it('the raw SUBSTRING form appears nowhere in src', () => {
    // A grep-shaped guard on purpose: the failure mode is a NEW call site written the old way,
    // which no behavioural test would notice until production started failing again.
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync(
      `grep -rn "SUBSTRING(COALESCE(body_markdown" ${SRC} || true`, { encoding: 'utf-8' });
    // Only the helper itself may name the pattern, and it builds it rather than inlining it.
    const offenders = out.split('\n').filter(Boolean).filter((l) => !l.includes('toastSafeText.ts'));
    expect(offenders).toEqual([]);
  });

  it('no call site truncates body_markdown with left() either', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync(
      `grep -rniE "(left|substr)\\(\\s*body_markdown" ${SRC} || true`, { encoding: 'utf-8' });
    const offenders = out.split('\n').filter(Boolean).filter((l) => !l.includes('toastSafeText.ts'));
    expect(offenders).toEqual([]);
  });
});
