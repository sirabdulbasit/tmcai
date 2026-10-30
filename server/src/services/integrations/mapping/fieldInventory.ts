/**
 * DEF-354 — Integrations Stage 1: the field inventory (design time, PURE).
 *
 * What every column of the sheet actually holds, computed from ALL rows —
 * never a sample (vm AiMapper.ts:1131 "the inventory runs over every record").
 * The admin and the proposer both judge a column by its VALUES, not its name:
 * every wrong mapping vm produced looked right by name and wrong by value
 * ("businessUnit" holding legal entities). Showing fill rate, type and real
 * samples is what makes that visible before anything is approved.
 *
 * Ported from vm `integrationFieldMapping.ts` discoverSourceFields /
 * buildFieldCoverage, narrowed to the flat shape a sheet has: every cell is a
 * string keyed by its header, so there is no dotted-path flattening and no
 * object/array type. Two deliberate differences from vm:
 *   - fields keep SHEET order (headers first, then any stray key), not
 *     "most-filled first": a wide sheet's month columns are only legible in the
 *     order the sheet has them, and the proposer reads them as a sequence;
 *   - the type is decided by a clear majority of the FILLED cells (see
 *     TYPE_MAJORITY), not "mixed" — one stray "n/a" in a column of numbers is a
 *     number column with one bad cell, which the risk check then counts.
 *
 * DEF-365: the fill counts and the "few enough values to list" decision come
 * from the vendored @tmc/ai-integration discoverSourceFields (same ≤12 rule,
 * computed over every record). Nexeo keeps, on top of it, the two deliberate
 * differences above (sheet order; majority typing — the framework types a
 * string cell as 'string', never number/date) and its sample/distinct display
 * (trimmed, first-seen order; the framework lists commonest first).
 */
import type { FieldCoverage, FieldInventoryModule, InferredFieldType } from '../types';
import { discoverSourceFields } from '../../../vendor/ai-integration/mapping/fieldInventory';

/** vm MAX_SAMPLES_PER_FIELD. */
export const MAX_SAMPLES = 3;
/** vm MAX_LISTED_VALUES: above this many distinct values the list stops
 *  describing the column and is omitted. */
export const MAX_LISTED_VALUES = 12;
/** A sample is a glimpse, not the cell: long text is shortened for display. */
export const MAX_SAMPLE_CHARS = 60;
/** Share of filled cells that must agree for a column to be called number/date. */
export const TYPE_MAJORITY = 0.8;

const isBlank = (v: unknown): boolean => v === null || v === undefined || String(v).trim() === '';

/**
 * Looks like a number to a person reading the sheet: optional currency, sign,
 * thousands separators, decimals, a trailing %, or accounting "(12)". This is
 * the INVENTORY's description only; whether a run can use the value is decided
 * by the planner's parseNumber, which the risk check uses.
 */
export function looksNumeric(raw: string): boolean {
  // The prefix allowed is a currency SYMBOL or a short code ("PKR", "Rs.") —
  // not any text: stripping every leading letter made "free text 3" a number.
  const s = raw.trim().replace(/^(?:[$€£¥₹₨]|[A-Za-z]{1,3}\.?)\s*/, '').replace(/[%\s]*$/, '');
  return /^\(?[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?\)?$/.test(s) && /\d/.test(s);
}

const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const DATE_PATTERNS: RegExp[] = [
  /^\d{4}-\d{1,2}(-\d{1,2})?([T ].*)?$/,          // 2026-01, 2026-01-31, ISO timestamps
  /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$/,          // 31/01/2026, 1.2.26
  new RegExp(`^${MONTH}[\\s\\-',/]*\\d{2,4}$`, 'i'), // Jan 2026, January-26, Jan'26
  new RegExp(`^\\d{1,2}[\\s\\-]${MONTH}[\\s\\-,]*\\d{2,4}$`, 'i'), // 31 Jan 2026
  /^(q[1-4][\s\-]*\d{4}|\d{4}[\s\-]*q[1-4])$/i,    // Q1 2026, 2026-Q1
  /^(fy|w(k|eek)?)\s*\d{1,4}([\s\-/]+\d{2,4})?$/i, // FY2026, W14 2026
];

/** Looks like a date or a period label (a month, a quarter, a week). */
export function looksLikeDate(raw: string): boolean {
  const s = raw.trim();
  return DATE_PATTERNS.some((re) => re.test(s));
}

function shorten(text: string): string {
  return text.length > MAX_SAMPLE_CHARS ? `${text.slice(0, MAX_SAMPLE_CHARS - 1)}…` : text;
}

function inferType(filledValues: string[]): InferredFieldType {
  if (filledValues.length === 0) return 'empty';
  const need = filledValues.length * TYPE_MAJORITY;
  // A plain 4-digit year is both a number and a period; as a COLUMN of values it
  // is far more often a period ("Year"), so a date majority is checked first.
  const dates = filledValues.filter(looksLikeDate).length;
  if (dates >= need) return 'date';
  const numbers = filledValues.filter(looksNumeric).length;
  if (numbers >= need) return 'number';
  return 'text';
}

/**
 * One FieldCoverage per column, from every record. Fields come in header order;
 * a key present in records but missing from `headers` (a reader that kept a
 * stray column) is appended, never dropped — every source field is accounted
 * for (vm "coverage: every source field accounted for").
 */
export const buildFieldCoverage: FieldInventoryModule['buildFieldCoverage'] = (records, headers) => {
  const rows = records ?? [];
  const order: string[] = [];
  const seen = new Set<string>();
  for (const h of headers ?? []) {
    if (!seen.has(h)) { seen.add(h); order.push(h); }
  }
  for (const r of rows) {
    for (const k of Object.keys(r ?? {})) {
      if (!seen.has(k)) { seen.add(k); order.push(k); }
    }
  }

  const total = rows.length;
  const discovered = new Map(discoverSourceFields(rows).map((f) => [f.path, f] as const));
  return order.map((field): FieldCoverage => {
    const fw = discovered.get(field);
    const filledValues: string[] = [];
    const samples: string[] = [];
    // Distinct values are only listed when few; counting stops one past the
    // limit, so a 50k-row id column costs a 13-entry set, not 50k.
    const distinct = new Set<string>();
    let overflowed = false;
    for (const r of rows) {
      const v = r?.[field];
      if (isBlank(v)) continue;
      const text = String(v).trim();
      filledValues.push(text);
      const short = shorten(text);
      if (samples.length < MAX_SAMPLES && !samples.includes(short)) samples.push(short);
      if (!overflowed) {
        distinct.add(short);
        if (distinct.size > MAX_LISTED_VALUES) overflowed = true;
      }
    }
    const cov: FieldCoverage = {
      field,
      // The framework's count over every record (blank = empty after trim, as here).
      filled: fw?.filled ?? filledValues.length,
      total,
      inferredType: inferType(filledValues),
      samples,
    };
    // Present only when it describes the column; absent (not []) otherwise.
    // Listed only when BOTH agree the column is few-valued (the framework's
    // `values` is present iff ≤12 distinct) — either one can only withhold.
    const fwFew = fw ? fw.values !== undefined : true;
    if (!overflowed && fwFew && distinct.size > 0) cov.distinct = [...distinct];
    return cov;
  });
};
