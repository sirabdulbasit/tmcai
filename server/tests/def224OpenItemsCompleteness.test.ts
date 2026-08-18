/**
 * DEF-224 — a summary that silently omits a category, and the measurement
 * mistake that let three pronoun fixes be judged against the wrong runs.
 *
 * `B06-just-do-it` has drawn the same judge complaint across three scored runs,
 * most recently **C6 80**:
 *
 *   > "It only lists 'High Priority' and 'Medium Priority' items. It's unclear
 *   >  if there are 'Low Priority' or 'No Priority' items that were omitted, or
 *   >  if these are the only items."
 *
 * The model could not have got this right. It was handed thirty rows and no
 * statement of whether thirty was all of them, nor which priorities exist. An
 * empty heading is inferable from a page only when the page is known complete —
 * DEF-197's `absenceIsInformative` principle, applied to the surface the owner
 * reads most.
 *
 * The tests are grouped by the two ways this can go wrong. Stating a category
 * is empty when it is not is the defect. Refusing to state it when the record
 * IS complete is the same defect pointing the other way — it would make Brain
 * hedge a fact it holds, which is what `guard-destroys-the-answer` looks like
 * from the inside.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  renderOpenItemsHeader,
  PRIORITY_BUCKETS,
  OPEN_ITEMS_PAGE,
  type PriorityTally,
} from '../src/services/knowledge/openItemsCompleteness';

const tally = (o: Record<string, number>): PriorityTally[] =>
  Object.entries(o).map(([k, n]) => ({
    priority: k === 'unset' ? null : k,
    _count: { _all: n },
  }));

/** B06's real shape: two high, two medium, nothing else. */
const B06 = tally({ high: 2, medium: 2 });

describe('DEF-224 — the empty bucket is a stated fact, not an inference', () => {
  it('THE B06 CASE: low and unset are named with a zero', () => {
    const out = renderOpenItemsHeader(4, B06);
    expect(out).toContain('critical=0 high=2 medium=2 low=0 unset=0');
  });

  it('and Brain is told the zero is real, because the page is every item', () => {
    const out = renderOpenItemsHeader(4, B06);
    expect(out).toContain('This is EVERY active open item (4)');
    expect(out).toContain('genuinely has none');
  });

  it('every bucket appears even when the tally mentions none of them', () => {
    const out = renderOpenItemsHeader(0, []);
    for (const p of PRIORITY_BUCKETS) expect(out, p).toContain(`${p}=0`);
    expect(out).toContain('unset=0');
  });

  it('a null priority is counted as `unset`, not folded into low', () => {
    // DRAFT rows carry a null priority. Calling that "low" would be a small lie
    // in the one line whose whole job is to be exact.
    const out = renderOpenItemsHeader(3, tally({ unset: 3 }));
    expect(out).toContain('low=0 unset=3');
  });

  it('is case-insensitive about the stored value', () => {
    expect(renderOpenItemsHeader(1, [{ priority: 'HIGH', _count: { _all: 1 } }]))
      .toContain('high=1');
  });
});

describe('DEF-224 — and it refuses to claim completeness it does not have', () => {
  it('a truncated page says so, and forbids calling a category empty', () => {
    const out = renderOpenItemsHeader(OPEN_ITEMS_PAGE, tally({ high: 40, low: 5 }));
    expect(out).toContain(`INCOMPLETE: 45 active items exist and only the newest ${OPEN_ITEMS_PAGE} are listed`);
    expect(out).toContain('do not say a category is empty');
    expect(out).not.toContain('genuinely has none');
  });

  it('a FAILED tally is not reported as "you have nothing"', () => {
    // The group-by is `.catch(() => [])`. An empty tally beside a non-empty page
    // is impossible, so it means unavailable — and printing "0 of 0" there would
    // be a fabricated completeness claim, the defect pointing the other way.
    const out = renderOpenItemsHeader(4, []);
    expect(out).toContain('could not be read this turn');
    expect(out).toContain('cannot vouch for the rest');
    expect(out).not.toContain('EVERY active open item');
  });

  it('tolerates a malformed tally row rather than throwing into the catch', () => {
    // A block that throws is a block the owner never sees at all.
    const rows = [{ priority: 'high' } as unknown as PriorityTally, ...B06];
    expect(() => renderOpenItemsHeader(4, rows)).not.toThrow();
    expect(renderOpenItemsHeader(4, rows)).toContain('high=2');
    expect(renderOpenItemsHeader(4, null)).toContain('could not be read this turn');
  });

  it('keeps the routing instruction the block existed for', () => {
    const out = renderOpenItemsHeader(4, B06);
    expect(out).toContain('use id to update/delegate/mark_done');
    expect(out).toContain('delegatee_candidateId');
  });
});

describe('DEF-224 — the page and the tally count the SAME set', () => {
  const code = (() => {
    const raw = fs.readFileSync(
      path.resolve(__dirname, '..', 'src/services/knowledge/brainComposer.ts'), 'utf8');
    // Comments stripped: a guard must read code, not prose about it (DEF-195).
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  })();

  it('there is ONE where-clause, used by both queries', () => {
    // Two hand-written clauses would drift, and a tally over a different set is
    // worse than no tally: Brain would state a total it cannot support.
    expect(code).toMatch(/const ACTIVE_WHERE = \{/);
    // Both queries name it. Counted rather than matched as a span: the `select`
    // between them is long, so a proximity regex would be pinning formatting.
    expect((code.match(/where: ACTIVE_WHERE,/g) ?? []).length).toBe(2);
    // And the clause it replaced is gone, so there is nothing left to drift from.
    const builder = code.slice(
      code.indexOf('export async function buildOpenItemsBlockForReasoning'),
      code.indexOf('buildOpenItemsBlock failed'));
    expect(builder).not.toMatch(/status: \{ in: \['NEW', 'TRIAGED'[\s\S]{0,80}\},\s*\n\s*\},\s*\n\s*select:/);
  });

  it('the page size is the shared constant, not a second literal', () => {
    expect(code).toMatch(/take: OPEN_ITEMS_PAGE,/);
    expect(code, 'no stray 30 left behind in this builder')
      .not.toMatch(/orderBy: \{ createdAt: 'desc' \},\s*\n\s*take: 30,/);
    expect(OPEN_ITEMS_PAGE).toBe(30);
  });

  it('the header comes from the shared renderer, not from a template here', () => {
    expect(code).toMatch(/return `\$\{renderOpenItemsHeader\(rows\.length, tally\)\}\\n\$\{lines\.join\('\\n'\)\}`;/);
    expect(code).toMatch(/import \{ renderOpenItemsHeader, OPEN_ITEMS_PAGE \} from '\.\/openItemsCompleteness'/);
  });

  it('a failed group-by degrades instead of losing the whole block', () => {
    // A bare `prisma.openItem.groupBy(...).catch(...)` is NOT enough: a client
    // without `groupBy` throws SYNCHRONOUSLY, `.catch` never runs, and the outer
    // try/catch returns '' — the entire block vanishes because a COUNT failed.
    // The existing `openItemsOwnerRouting` suite mocks exactly such a client and
    // caught it. Deferring into a promise chain catches both shapes.
    expect(code).toMatch(/Promise\.resolve\(\)\s*\n\s*\.then\(\(\) => \(prisma\.openItem as any\)\.groupBy\(\{/);
    expect(code).toMatch(/\.catch\(\(\) => \[\] as Array<\{ priority: string \| null; _count: \{ _all: number \} \}>\)/);
  });
});
