/**
 * DEF-362 — Integrations Stage 1b: the structured record filter
 * (engine/recordFilter.ts). Pure: no prisma, no model.
 *
 * Rules pinned (spec INTEGRATIONS_DESIGN.md §2b; vm recordMatchesFilter):
 *  - nothing filters until approved: a null filter keeps every record;
 *  - every op, incl. dates compared AS DATES (after = on or after, before =
 *    strictly before) and numbers compared AS NUMBERS;
 *  - a cell that does not parse for a numeric/date op is filtered OUT;
 *  - equals ignores case, spacing and zero padding ("GL 01" = "gl1");
 *  - a condition naming a field no record carries is a problem (run fails);
 *  - all vs any;
 *  - validation is closed: unknown keys/ops, missing values, bad dates/numbers
 *    and more than 20 conditions are refused.
 */
import { describe, it, expect } from 'vitest';
import { applyRecordFilter, conditionHolds, validateRecordFilter, MAX_FILTER_CONDITIONS } from '../src/services/integrations/engine/recordFilter';
import { IntegrationInputError, FILTER_OPS, type FilterOp, type RecordFilter } from '../src/services/integrations/types';

const R = (o: Record<string, string>) => o;
const RECORDS = [
  R({ name: 'Acme', status: 'Active', revenue: '1,200', since: '2025-03-10', grade: 'GL 01', note: '' }),
  R({ name: 'Beta', status: 'inactive', revenue: '800', since: '2024-12-31', grade: 'GL13', note: 'vip' }),
  R({ name: 'Gamma', status: 'ACTIVE', revenue: 'n/a', since: 'soon', grade: 'gl1', note: 'VIP client' }),
  R({ name: 'Delta', status: 'Active', revenue: '2000', since: 'Jan 2025', grade: 'GL9', note: '' }),
];
const names = (f: RecordFilter | null) => applyRecordFilter(RECORDS, f).kept.map((r) => r.name);
const one = (field: string, op: FilterOp, value?: string): RecordFilter => ({ match: 'all', conditions: [{ field, op, ...(value !== undefined ? { value } : {}) }] });

describe('applyRecordFilter — nothing filters until approved', () => {
  it('null filter keeps every record and counts nothing', () => {
    const o = applyRecordFilter(RECORDS, null);
    expect(o.kept).toHaveLength(4);
    expect(o.filteredOut).toBe(0);
    expect(o.problems).toEqual([]);
  });
});

describe('every op', () => {
  it('equals / not_equals ignore case, spacing and zero padding', () => {
    expect(names(one('status', 'equals', 'active'))).toEqual(['Acme', 'Gamma', 'Delta']);
    expect(names(one('grade', 'equals', 'GL1'))).toEqual(['Acme', 'Gamma']);
    expect(names(one('status', 'not_equals', 'Active'))).toEqual(['Beta']);
  });
  it('contains / not_contains are case-insensitive', () => {
    expect(names(one('note', 'contains', 'vip'))).toEqual(['Beta', 'Gamma']);
    expect(names(one('note', 'not_contains', 'VIP'))).toEqual(['Acme', 'Delta']);
  });
  it('numeric ops compare NUMBERS ("1,200" > "800"; "9" < "10"), and a non-number is filtered out', () => {
    expect(names(one('revenue', 'greater_than', '1000'))).toEqual(['Acme', 'Delta']);
    expect(names(one('revenue', 'greater_or_equal', '800'))).toEqual(['Acme', 'Beta', 'Delta']);
    expect(names(one('revenue', 'less_than', '1200'))).toEqual(['Beta']);
    expect(names(one('revenue', 'less_or_equal', '1200'))).toEqual(['Acme', 'Beta']);
    // Gamma ("n/a") never matches either side — not treated as zero.
    expect(names(one('revenue', 'less_than', '99999'))).not.toContain('Gamma');
    expect(conditionHolds({ x: '9' }, { field: 'x', op: 'less_than', value: '10' })).toBe(true);
  });
  it('after = on or after, before = strictly before; dates parsed, never string order', () => {
    // "2025 onwards": Jan 2025 (→ 2025-01-01) is kept, 2024-12-31 is not; "soon" never matches.
    expect(names(one('since', 'after', '2025-01-01'))).toEqual(['Acme', 'Delta']);
    expect(names(one('since', 'before', '2025-01-01'))).toEqual(['Beta']);
    // String order would put "Jan 2025" after "2025-03-10"; date order does not.
    expect(names(one('since', 'after', '2025-02-01'))).toEqual(['Acme']);
  });
  it('is_blank / is_not_blank take no value', () => {
    expect(names(one('note', 'is_blank'))).toEqual(['Acme', 'Delta']);
    expect(names(one('note', 'is_not_blank'))).toEqual(['Beta', 'Gamma']);
  });
  it('covers every op in FILTER_OPS', () => {
    for (const op of FILTER_OPS) expect(typeof conditionHolds(RECORDS[0], { field: 'since', op, value: '2025-01-01' })).toBe('boolean');
  });
});

describe('match all vs any; counts; problems', () => {
  it('all = every condition, any = at least one; filteredOut counted', () => {
    const conds = [{ field: 'status', op: 'equals' as const, value: 'active' }, { field: 'revenue', op: 'greater_than' as const, value: '1500' }];
    const all = applyRecordFilter(RECORDS, { match: 'all', conditions: conds });
    expect(all.kept.map((r) => r.name)).toEqual(['Delta']);
    expect(all.filteredOut).toBe(3);
    expect(names({ match: 'any', conditions: conds })).toEqual(['Acme', 'Gamma', 'Delta']);
  });
  it('a field no record carries is a problem, never a silent pass or drop', () => {
    const o = applyRecordFilter(RECORDS, one('Region', 'equals', 'North'));
    expect(o.problems).toHaveLength(1);
    expect(o.problems[0]).toMatch(/"Region" is not in the data/);
  });
});

describe('validateRecordFilter — closed', () => {
  const bad = (raw: unknown, fields?: string[]) => expect(() => validateRecordFilter(raw, fields)).toThrow(IntegrationInputError);
  it('accepts a good filter and normalises it', () => {
    expect(validateRecordFilter({ match: 'any', conditions: [{ field: ' status ', op: 'equals', value: ' Active ' }, { field: 'note', op: 'is_blank' }] }))
      .toEqual({ match: 'any', conditions: [{ field: 'status', op: 'equals', value: 'Active' }, { field: 'note', op: 'is_blank' }] });
  });
  it('refuses unknown keys, unknown ops, missing values, bad dates and numbers, unknown fields, too many conditions', () => {
    bad({ match: 'all', conditions: [{ field: 'a', op: 'equals', value: 'x' }], sql: 'drop' });
    bad({ match: 'all', conditions: [{ field: 'a', op: 'regex', value: 'x' }] });
    bad({ match: 'all', conditions: [{ field: 'a', op: 'equals' }] });
    bad({ match: 'all', conditions: [{ field: 'a', op: 'after', value: '2025' }] });
    bad({ match: 'all', conditions: [{ field: 'a', op: 'greater_than', value: 'lots' }] });
    bad({ match: 'all', conditions: [{ field: 'a', op: 'equals', value: 'x', extra: 1 }] });
    bad({ match: 'some', conditions: [{ field: 'a', op: 'equals', value: 'x' }] });
    bad({ match: 'all', conditions: [] });
    bad({ match: 'all', conditions: [{ field: 'Region', op: 'equals', value: 'x' }] }, ['status']);
    bad({ match: 'all', conditions: Array.from({ length: MAX_FILTER_CONDITIONS + 1 }, () => ({ field: 'a', op: 'is_blank' })) });
  });
});
