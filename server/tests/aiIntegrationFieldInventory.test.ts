/**
 * Vendored from @tmc/ai-integration c0a6ebe test/integrationFieldMapping.test.ts — imports re-pointed at
 * src/vendor/ai-integration (see src/vendor/ai-integration/VENDORED.md).
 */
/**
 * Employee suggestions must stay FIELD-WISE.
 *
 * The regression this guards: an earlier version emitted one suggestion per
 * person, so a 1,197-record directory produced ~1,200 rows for what is a single
 * decision — and implied each person was approved separately, when approval is
 * per field. These tests fail if per-record rows ever come back.
 */

import { describe, it, expect } from 'vitest';
import {
  digPath,
  discoverSourceFields,
  buildFieldCoverage,
  readRoleTargets,
  type DiscoveredField,
  assessMappingRisk,
  profileValues,
} from '../src/vendor/ai-integration/mapping/fieldInventory';

/** 4 people in the external system, 3 of whom exist in the host application. */
const records = [
  { email: 'a@x.com', departmentName: 'SLA', businessUnit: 'TMC Private Limited' },
  { email: 'b@x.com', departmentName: 'PMO', businessUnit: 'TMC Private Limited' },
  { email: 'c@x.com', departmentName: '', businessUnit: 'Xnrel Pvt Limited' },
  { email: 'ghost@x.com', departmentName: 'Nowhere', businessUnit: 'None' },
];

const users = new Map<string, Record<string, unknown>>([
  ['a@x.com', { email: 'a@x.com', empcode: 'E-1', department: 'Delivery', team: 'SAP Supply Chain' }],
  ['b@x.com', { email: 'b@x.com', empcode: 'E-2', department: 'PMO', team: 'PMO' }],
  ['c@x.com', { email: 'c@x.com', empcode: 'E-3', department: null, team: 'Digital' }],
]);

const tally = (map: Record<string, string>) =>
  tallyFieldMappings({ records, usersByIdentity: users, employeeFieldMap: map, identityField: 'email' });

describe('digPath', () => {
  it('reads nested and flat fields, and survives missing ones', () => {
    expect(digPath({ a: { b: 'x' } }, 'a.b')).toBe('x');
    expect(digPath({ a: 1 }, 'a')).toBe(1);
    expect(digPath({ a: 1 }, 'nope.deeper')).toBeUndefined();
    expect(digPath(null, 'a')).toBeUndefined();
  });
});

describe('discoverSourceFields — what the API actually returns (wizard step 3)', () => {
  it('lists every field with a fill rate and real examples', () => {
    const f = discoverSourceFields(records);
    const byPath = Object.fromEntries(f.map((x) => [x.path, x]));
    expect(Object.keys(byPath).sort()).toEqual(['businessUnit', 'departmentName', 'email']);
    expect(byPath.email!.filled).toBe(4);
    expect(byPath.email!.total).toBe(4);
    expect(byPath.departmentName!.filled).toBe(3);   // one record has ''
    expect(byPath.departmentName!.samples).toContain('SLA');
  });

  it('shows values, which is how a misleading field NAME gets caught', () => {
    const f = discoverSourceFields(records).find((x) => x.path === 'businessUnit')!;
    // The name says "unit"; the values say "legal entity". The admin sees this.
    expect(f.samples).toContain('TMC Private Limited');
  });

  it('counts every distinct value of a small-set field, so a code column reads itself', () => {
    const f = discoverSourceFields([
      { index: 'AAI' }, { index: 'ACI' }, { index: 'AAI' },
    ]).find((x) => x.path === 'index')!;
    expect(f.distinct).toBe(2);
    expect(f.values).toEqual([{ value: 'AAI', count: 2 }, { value: 'ACI', count: 1 }]);
  });

  it('puts the commonest value first — the shape of the feed, not the alphabet', () => {
    const f = discoverSourceFields([
      { state: 'running' }, { state: 'final' }, { state: 'final' },
    ]).find((x) => x.path === 'state')!;
    expect(f.values?.[0]).toEqual({ value: 'final', count: 2 });
  });

  it('counts nothing blank — an empty value is not a value', () => {
    const f = discoverSourceFields([{ a: '' }, { a: null }, { a: 'x' }])
      .find((x) => x.path === 'a')!;
    expect(f.distinct).toBe(1);
    expect(f.values).toEqual([{ value: 'x', count: 1 }]);
  });

  it('gives no list for a field that holds a different value every time, but still says how many', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `E${i}` }));
    const f = discoverSourceFields(many).find((x) => x.path === 'id')!;
    expect(f.distinct).toBe(40);
    expect(f.values).toBeUndefined();
  });

  it('flattens nested objects to dotted paths', () => {
    const f = discoverSourceFields([{ profile: { dept: 'SLA', deep: { a: 1 } } }]);
    expect(f.map((x) => x.path)).toContain('profile.dept');
  });

  it('reports arrays as arrays rather than exploding them', () => {
    const f = discoverSourceFields([{ directReports: ['a', 'b'] }])[0]!;
    expect(f.type).toBe('array');
  });

  it('marks a field that is always blank as empty, and ranks it last', () => {
    const f = discoverSourceFields([{ a: 'x', b: '' }, { a: 'y', b: null }]);
    expect(f[0]!.path).toBe('a');
    const b = f.find((x) => x.path === 'b')!;
    expect(b.type).toBe('empty');
    expect(b.filled).toBe(0);
  });

  it('calls a field mixed when the source is inconsistent', () => {
    const f = discoverSourceFields([{ v: 1 }, { v: 'two' }])[0]!;
    expect(f.type).toBe('mixed');
  });

  it('keeps samples distinct and bounded', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ v: i < 25 ? 'same' : `v${i}` }));
    const f = discoverSourceFields(many)[0]!;
    expect(f.samples).toHaveLength(3);
    expect(new Set(f.samples).size).toBe(3);
  });

  it('survives an empty record set', () => {
    expect(discoverSourceFields([])).toEqual([]);
  });
});

describe('buildFieldCoverage — every source field accounted for', () => {
  const discovered = discoverSourceFields([
    { email: 'a@x.com', departmentName: 'SLA', gender: 'female', reportsTo: 'Salik', empty: '' },
  ]);
  const blocked = (src: string): string | null => {
    const f = src.toLowerCase();
    if (f === 'email') return 'Used to identify the person — never written over.';
    if (f.startsWith('reportsto')) return 'Reporting line.';
    return null;
  };

  it('lists every field, not only the mapped ones', () => {
    const c = buildFieldCoverage(discovered, { departmentName: 'department' }, blocked);
    expect(c.map((x) => x.source).sort())
      .toEqual(['departmentName', 'email', 'empty', 'gender', 'reportsTo']);
  });

  it('shows what a mapped field updates', () => {
    const c = buildFieldCoverage(discovered, { departmentName: 'department' }, blocked);
    const dep = c.find((x) => x.source === 'departmentName')!;
    expect(dep.status).toBe('mapped');
    expect(dep.target).toBe('department');
  });

  it('separates blocked-by-rule from simply-not-mapped', () => {
    const c = buildFieldCoverage(discovered, {}, blocked);
    expect(c.find((x) => x.source === 'email')!.status).toBe('blocked');
    expect(c.find((x) => x.source === 'reportsTo')!.status).toBe('blocked');
    // gender is not blocked by any rule — it simply was not mapped.
    expect(c.find((x) => x.source === 'gender')!.status).toBe('unmapped');
  });

  it('says when a field is always empty rather than blaming the mapping', () => {
    const c = buildFieldCoverage(discovered, {}, blocked);
    expect(c.find((x) => x.source === 'empty')!.note).toMatch(/always empty/i);
  });

  it('carries a real example so the meaning is visible', () => {
    const c = buildFieldCoverage(discovered, {}, blocked);
    expect(c.find((x) => x.source === 'departmentName')!.example).toBe('SLA');
  });

  it('matches the source field case-insensitively', () => {
    const c = buildFieldCoverage(discovered, { DEPARTMENTNAME: 'department' }, blocked);
    expect(c.find((x) => x.source === 'departmentName')!.status).toBe('mapped');
  });
});

describe('assessMappingRisk — catch in code what a name match hides', () => {
  const shape = (o: Partial<Parameters<typeof assessMappingRisk>[0]> = {}) => ({
    sourceDistinct: 50, sourceAvgLength: 14,
    targetDistinct: 52, targetAvgLength: 16, overwrites: 0, ...o,
  });

  it('blocks the real businessUnit → team case', () => {
    // 10 legal entities replacing 52 delivery teams for 924 people.
    const r = assessMappingRisk(shape({ sourceDistinct: 10, targetDistinct: 52, overwrites: 924 }));
    expect(r.severity).toBe('block');
    expect(r.code).toBe('collapses_taxonomy');
    expect(r.reason).toContain('924');
  });

  it('blocks the real location → city case', () => {
    // 83-character postal addresses into a field holding "Lahore".
    const r = assessMappingRisk(shape({
      sourceDistinct: 6, sourceAvgLength: 83, targetDistinct: 11, targetAvgLength: 7, overwrites: 700,
    }));
    expect(r.severity).toBe('block');
    // Collapse is checked first and also applies here; either verdict is a block.
    expect(['collapses_taxonomy', 'value_shape_mismatch']).toContain(r.code);
  });

  it('allows departmentName → department, which EXPANDS the taxonomy', () => {
    // 67 source values into 23 existing — more detail, not less.
    expect(assessMappingRisk(shape({
      sourceDistinct: 67, targetDistinct: 23, overwrites: 836,
    })).severity).toBe('none');
  });

  it('allows a narrow source when it is only filling blanks', () => {
    // Nothing is destroyed if there was nothing there.
    expect(assessMappingRisk(shape({
      sourceDistinct: 10, targetDistinct: 52, overwrites: 0,
    })).severity).toBe('none');
  });

  it('blocks a field that is empty in every record', () => {
    const r = assessMappingRisk(shape({ sourceDistinct: 0 }));
    expect(r.code).toBe('never_populated');
  });

  it('does not fire on a small target where low variety is normal', () => {
    // e.g. country: 2 distinct values is not evidence of anything.
    expect(assessMappingRisk(shape({
      sourceDistinct: 2, targetDistinct: 3, overwrites: 500,
    })).severity).toBe('none');
  });

  it('allows long values into a field that already holds long values', () => {
    expect(assessMappingRisk(shape({
      sourceAvgLength: 80, targetAvgLength: 75, overwrites: 100,
    })).severity).toBe('none');
  });
});

describe('profileValues', () => {
  it('counts distinct non-blank values and their mean length', () => {
    const p = profileValues(['SLA', 'SLA', 'PMO', '', null, '   ']);
    expect(p.distinct).toBe(2);
    expect(p.avgLength).toBeCloseTo(3, 5);
  });

  it('reports zero for an entirely empty field', () => {
    expect(profileValues(['', null, undefined])).toEqual({ distinct: 0, avgLength: 0 });
  });
});

describe('readRoleTargets — what each field does in a goal or working-profile feed', () => {
  it('names the identity, the figure, the period and the label of a goal feed', () => {
    const r = readRoleTargets(
      { identityField: 'EmployeeCode', valueField: 'No of Absents', periodField: 'MonthYear', labelField: 'Competency' },
      'goals', new Map(),
    );
    expect(Object.keys(r).sort()).toEqual(['Competency', 'EmployeeCode', 'MonthYear', 'No of Absents']);
    expect(r['No of Absents']!.target).toMatch(/goal/i);
    expect(r['EmployeeCode']!.note).toMatch(/person/i);
  });

  it('names each working-profile attribute by its label, not its key', () => {
    const r = readRoleTargets(
      { identityField: 'employee_id', ewpFieldMap: { award: 'functionOutput' } },
      'ewp', new Map([['functionOutput', 'Function Output']]),
    );
    expect(r['award']!.target).toBe('Function Output');
    expect(r['employee_id']).toBeDefined();
  });

  it('does not claim a goal figure for a working-profile feed', () => {
    const r = readRoleTargets({ valueField: 'award' }, 'ewp', new Map());
    expect(r['award']).toBeUndefined();
  });

  it('claims nothing for a role the connector leaves unset', () => {
    expect(readRoleTargets({}, 'goals', new Map())).toEqual({});
  });

  it('names the goal title each field feeds, and every title a shared field feeds', () => {
    const r = readRoleTargets({
      goalTitleMap: {
        'Missing Punches': 'No of Missing Punch',
        'Attendance Marking': 'No of Check-In Permitted Locations',
        'Geo attendance': 'No of Check-In Permitted Locations',
      },
    }, 'goals', new Map());
    expect(r['No of Missing Punch']!.target).toBe('goal: Missing Punches');
    expect(r['No of Check-In Permitted Locations']!.target).toBe('goal: Attendance Marking, Geo attendance');
    expect(r['No of Missing Punch']!.note).toMatch(/set to Integration/);
  });
});

describe('buildFieldCoverage — a role carries its own sentence', () => {
  it('uses the note it is given rather than "Updates <target>."', () => {
    const c = buildFieldCoverage(
      [{ path: 'MonthYear', type: 'string', filled: 200, total: 200, samples: ['Sep-2026'], distinct: 12 }],
      { MonthYear: { target: 'period', note: 'The period each figure belongs to.' } },
      () => null,
    );
    expect(c[0]).toMatchObject({ status: 'mapped', target: 'period', note: 'The period each figure belongs to.' });
  });
});

/**
 * The field table carries what the field holds, not one example.
 *
 * "What this system sends" and this table both listed every field, and the
 * panel was removed as the duplicate. The one thing only the panel had was the
 * breakdown — "index: AAI 118, ACI 82" — which is what showed that DAL sends
 * two scores per person. One example value hides that, so the table takes it.
 */
describe('buildFieldCoverage — what each field holds', () => {
  const d = (over: Partial<DiscoveredField>): DiscoveredField => ({
    path: 'index', type: 'string', filled: 200, total: 200, samples: ['AAI'], distinct: 2, ...over,
  });

  it('carries every value and its count for a field holding few', () => {
    const c = buildFieldCoverage(
      [d({ values: [{ value: 'AAI', count: 118 }, { value: 'ACI', count: 82 }] })], {}, () => null,
    );
    expect(c[0]!.values).toEqual([{ value: 'AAI', count: 118 }, { value: 'ACI', count: 82 }]);
    expect(c[0]!.distinct).toBe(2);
  });

  it('carries the count and the examples for a field holding many', () => {
    const c = buildFieldCoverage(
      [d({ path: 'employee_id', distinct: 118, samples: ['C-101', 'C-102', 'C-103'] })], {}, () => null,
    );
    expect(c[0]!.values).toBeUndefined();
    expect(c[0]!.distinct).toBe(118);
    expect(c[0]!.samples).toEqual(['C-101', 'C-102', 'C-103']);
  });
});
