/**
 * DEF-362 — Integrations Stage 1b: the structured record filter (spec
 * INTEGRATIONS_DESIGN.md §2b, Review & Mapping). PURE: no I/O, no model.
 *
 * The admin writes filter words ("only active customers, 2025 onwards"); the
 * proposer turns them into a RecordFilter row the admin approves like any
 * other row. NOTHING filters until it is approved (vm §9 "proposable ≠
 * writable"): applyRecordFilter(records, null) keeps everything.
 *
 * Semantics (ported from vm integrationSyncEngine.recordMatchesFilter, with the
 * Stage 1b contract in types.ts where they differ):
 *   - equals / not_equals: case-insensitive, internal spacing ignored, and
 *     zero-padding after an alpha prefix ignored ("GL 01" = "GL1") — vm: a raw
 *     string compare made `equals GL13` match nobody.
 *   - contains / not_contains: case-insensitive, spacing ignored, no padding
 *     rule (stripping zeros inside a substring changes what "E-007" means).
 *   - greater/less ops compare NUMBERS (planner.parseNumber). A cell or value
 *     that is not a number does NOT match — "revenue above 1000" must not sweep
 *     in rows with no revenue (vm "a record with no comparable value is
 *     excluded rather than silently treated as zero"). vm fell back to string
 *     order; types.ts closes that, since "9" > "10" as strings.
 *   - after / before compare DATES (planner.parsePeriod), never string order.
 *     `after X` keeps dates ON OR AFTER X, `before X` keeps dates strictly
 *     BEFORE X: the owner's words are "2025 onwards", and the pair then splits
 *     time cleanly into [X, Y) with no day counted twice or dropped.
 *     An unparseable cell does not match.
 *   - a condition naming a field that no record carries is a PROBLEM, which
 *     fails the run (an unconfigured target fails the run, vm §9) — it never
 *     silently keeps or drops everyone.
 */
import {
  FILTER_OPS,
  IntegrationInputError,
  VALUELESS_FILTER_OPS,
  type FilterCondition,
  type FilterOp,
  type FilterOutcome,
  type RecordFilter,
  type RecordFilterModule,
} from '../types';
import { parseNumber, parsePeriod } from './planner';

/** Closed cap on conditions (types.ts RecordFilterModule). */
export const MAX_FILTER_CONDITIONS = 20;

const flat = (s: string): string => s.toLowerCase().replace(/\s+/g, '');
const code = (s: string): string => flat(s).replace(/^([a-z]+)0+(\d)/, '$1$2');

/** Decimal-string compare without float rounding: both are canonical
 *  ("-12.5", "1234"), as planner.parseNumber returns them. */
function compareDecimal(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  // Canonical strings up to NUMERIC(20,6) precision compare exactly enough as
  // doubles for a keep/drop decision; equality is checked on the strings.
  if (a === b) return 0;
  return na < nb ? -1 : na > nb ? 1 : 0;
}

/** Does ONE condition hold for this record? */
export function conditionHolds(rec: Record<string, string>, c: FilterCondition): boolean {
  const actual = String(rec[c.field] ?? '').trim();
  if (c.op === 'is_blank') return actual === '';
  if (c.op === 'is_not_blank') return actual !== '';
  const wanted = String(c.value ?? '').trim();
  switch (c.op) {
    case 'equals': return code(actual) === code(wanted);
    case 'not_equals': return code(actual) !== code(wanted);
    case 'contains': return flat(actual).includes(flat(wanted));
    case 'not_contains': return !flat(actual).includes(flat(wanted));
    case 'greater_than': case 'greater_or_equal': case 'less_than': case 'less_or_equal': {
      const a = parseNumber(actual);
      const b = parseNumber(wanted);
      if (a === null || b === null) return false;
      const k = compareDecimal(a, b);
      if (c.op === 'greater_than') return k > 0;
      if (c.op === 'greater_or_equal') return k >= 0;
      if (c.op === 'less_than') return k < 0;
      return k <= 0;
    }
    case 'after': case 'before': {
      const a = parsePeriod(actual);
      const b = parsePeriod(wanted);
      if (a === null || b === null) return false;
      // ISO YYYY-MM-DD strings order like the dates they name.
      return c.op === 'after' ? a >= b : a < b;
    }
    default: return false;
  }
}

export function recordMatches(rec: Record<string, string>, f: RecordFilter): boolean {
  if (!f.conditions.length) return true;
  return f.match === 'any'
    ? f.conditions.some((c) => conditionHolds(rec, c))
    : f.conditions.every((c) => conditionHolds(rec, c));
}

export const applyRecordFilter: RecordFilterModule['applyRecordFilter'] = (records, filter): FilterOutcome => {
  if (!filter || !filter.conditions?.length) return { kept: records, filteredOut: 0, problems: [] };
  const problems: string[] = [];
  if (records.length > 0) {
    // Flattened API records may omit a key in some records ('' is the blank);
    // a field NO record carries is a mapping the data does not support.
    const seen = new Set<string>();
    for (const r of records) for (const k of Object.keys(r)) seen.add(k);
    for (const f of new Set(filter.conditions.map((c) => c.field))) {
      if (!seen.has(f)) problems.push(`Field "${f}" is not in the data, so the approved filter cannot be applied.`);
    }
  }
  if (problems.length) return { kept: [], filteredOut: 0, problems };
  const kept = records.filter((r) => recordMatches(r, filter));
  return { kept, filteredOut: records.length - kept.length, problems };
};

function isOp(x: unknown): x is FilterOp {
  return typeof x === 'string' && (FILTER_OPS as readonly string[]).includes(x);
}

/** Closed validation: unknown keys are refused, not ignored (the same rule as
 *  the integration whitelist), so a model-invented option cannot ride in. */
export const validateRecordFilter: RecordFilterModule['validateRecordFilter'] = (raw, fields) => {
  const bad = (msg: string): never => { throw new IntegrationInputError(`Filter: ${msg}`, 'filter'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('must be an object with "match" and "conditions".');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'match' && k !== 'conditions') bad(`unknown key "${k}".`);
  const match = o.match ?? 'all';
  if (match !== 'all' && match !== 'any') bad('"match" must be "all" or "any".');
  if (!Array.isArray(o.conditions) || o.conditions.length === 0) bad('needs at least one condition.');
  const list = o.conditions as unknown[];
  if (list.length > MAX_FILTER_CONDITIONS) bad(`at most ${MAX_FILTER_CONDITIONS} conditions.`);
  const known = fields ? new Set(fields) : null;
  const conditions: FilterCondition[] = list.map((c, i) => {
    const n = i + 1;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return bad(`condition ${n} is not an object.`);
    const cc = c as Record<string, unknown>;
    for (const k of Object.keys(cc)) if (k !== 'field' && k !== 'op' && k !== 'value') bad(`condition ${n} has unknown key "${k}".`);
    if (typeof cc.field !== 'string' || !cc.field.trim()) bad(`condition ${n} has no field.`);
    const field = (cc.field as string).trim();
    if (known && !known.has(field)) bad(`condition ${n} names "${field}", which is not in the data.`);
    if (!isOp(cc.op)) return bad(`condition ${n} has an unknown operation "${String(cc.op)}".`);
    const op = cc.op;
    if (VALUELESS_FILTER_OPS.includes(op)) return { field, op };
    if (typeof cc.value !== 'string' && typeof cc.value !== 'number') bad(`condition ${n} ("${op}") needs a value.`);
    const value = String(cc.value).trim();
    if (!value) bad(`condition ${n} ("${op}") needs a value.`);
    if ((op === 'after' || op === 'before') && parsePeriod(value) === null) {
      bad(`condition ${n}: "${value}" is not a date (use e.g. 2025-01-01 or Jan 2025).`);
    }
    if (/^(greater|less)_/.test(op) && parseNumber(value) === null) {
      bad(`condition ${n}: "${value}" is not a number.`);
    }
    return { field, op, value };
  });
  return { match: match as 'all' | 'any', conditions };
};

export const recordFilter: RecordFilterModule = { applyRecordFilter, validateRecordFilter };
