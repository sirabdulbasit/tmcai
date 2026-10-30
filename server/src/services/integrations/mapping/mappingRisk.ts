/**
 * DEF-354 — Integrations Stage 1: arithmetic risk checks on a proposed KPI row
 * (design time, PURE).
 *
 * The proposer's row is a CLAIM ("column Revenue is the revenue KPI"); this
 * module checks the claim against the sheet's actual values before the admin
 * ever sees it as approvable. Ported from vm integrationFieldMapping.ts
 * assessMappingRisk / profileValues, narrowed to what a KPI number can get
 * wrong:
 *   - never_populated   — every cell the row would read is blank (vm rule 1,
 *                         `sourceDistinct === 0`). Approving it writes nothing.
 *   - value_not_numeric — fewer than MIN_NUMERIC_SHARE of the filled cells are
 *                         numbers: the column is text that LOOKS like a KPI by
 *                         name (vm's "judged by value, not by name").
 *   - period_unreadable — fewer than MIN_NUMERIC_SHARE of the numbers have a
 *                         period the RUN can read (long: the period cell; wide:
 *                         the column header), judged with the planner's own
 *                         parser and the KPI's grain — never a looser "looks
 *                         like a date" (review fix: "2/1/2026", "Jan 26",
 *                         "Q1 2026" passed here and were skipped by every run).
 * Any of them turns the row into SET_ASIDE with the arithmetic in `reason`, so
 * the admin sees WHY in numbers, never a bare "rejected" (vm FieldMapping.ts
 * :605). vm's collapses_taxonomy / value_shape_mismatch are about text columns
 * overwriting text columns and have no KPI meaning; they are not ported.
 *
 * A row that passes still gets a reason: its blast radius — how many readings
 * it would produce, counted as DISTINCT (period, dimension) subjects, never as
 * rows (vm §9 "distinct-subject counts"; vm summed per-field and overcounted).
 *
 * The numeric test is injectable (`isNumber`). Default: fieldInventory's
 * looksNumeric, the same reading the inventory showed the admin. The run's
 * own parseNumber (engine/planner) decides per cell at execution time.
 */
import type { KpiTransform } from '../types';
import { looksNumeric } from './fieldInventory';
import { monthIn, periodStartFor, planKpiReadings, type PlannerKpiDef } from '../engine/planner';
import { describeKpiRecipe, recipeTransformFields, recipeValueFields } from '../engine/kpiRecipe';

/** Below this share of numeric filled cells the row is set aside. Half, not
 *  "all": a column of numbers with a few "n/a" cells is still the KPI, and the
 *  run skips and counts those cells. */
export const MIN_NUMERIC_SHARE = 0.5;

export type MappingRiskCode = 'never_populated' | 'value_not_numeric' | 'period_unreadable' | 'none';

export interface KpiRowProfile {
  /** Cells the row reads (rows × value columns). */
  cells: number;
  /** Non-blank cells among them. */
  filled: number;
  /** Filled cells that read as numbers. */
  numeric: number;
  /** Distinct (period, dimension) subjects with a numeric value. */
  subjects: number;
  /** Numeric cells with no readable period (long: the period cell; wide: the
   *  column header). */
  periodUnreadable: number;
}

export interface MappingRisk {
  code: MappingRiskCode;
  /** True ⇒ the row becomes SET_ASIDE. */
  setAside: boolean;
  /** Plain words with the numbers (set-aside arithmetic or blast radius). */
  reason: string;
  profile: KpiRowProfile;
}

const blank = (v: unknown): boolean => v === null || v === undefined || String(v).trim() === '';

/** The value columns a transform reads (long: one; wide: every period column). */
export function transformValueColumns(t: KpiTransform): string[] {
  if (t.mode === 'recipe') return recipeValueFields(t.recipe);
  return t.mode === 'long' ? [t.valueField] : [...t.columns];
}

/** Every header a transform reads — the run's header check uses the same set. */
export function transformFields(t: KpiTransform): string[] {
  if (t.mode === 'recipe') return recipeTransformFields(t);
  const out = t.mode === 'long' ? [t.valueField, t.periodField] : [...t.columns];
  if (t.dimensionField) out.push(t.dimensionField);
  return out;
}

/** Count what the row would read, over EVERY record. */
export function profileKpiRow(
  records: Record<string, string>[],
  t: KpiTransform,
  isNumber: (raw: string) => boolean = looksNumeric,
  grain: string = 'month',
): KpiRowProfile {
  if (t.mode === 'recipe') return profileRecipeRow(records, t, grain).profile;
  const subjects = new Set<string>();
  let cells = 0; let filled = 0; let numeric = 0; let periodUnreadable = 0;
  for (const r of records ?? []) {
    const dim = t.dimensionField ? String(r?.[t.dimensionField] ?? '').trim() : '';
    const pairs: Array<[period: string, value: unknown]> = t.mode === 'long'
      ? [[String(r?.[t.periodField] ?? '').trim(), r?.[t.valueField]]]
      : t.columns.map((c) => [c, r?.[c]] as [string, unknown]);
    for (const [period, raw] of pairs) {
      cells++;
      if (blank(raw)) continue;
      filled++;
      if (!isNumber(String(raw).trim())) continue;
      numeric++;
      // Long: the period cell beside the value. Wide: the column HEADER is the
      // period ("Jan 2026"); a header like "Notes" can never date a reading.
      const start = period === '' ? null : periodStartFor(period, grain);
      if (!start) { periodUnreadable++; continue; }
      subjects.add(`${start}|${dim}`);
    }
  }
  return { cells, filled, numeric, subjects: subjects.size, periodUnreadable };
}

const pct = (n: number, d: number): string => (d === 0 ? '0' : (Math.round((n / d) * 1000) / 10).toString());

/**
 * DEF-365: a recipe row is judged by running the RUN'S OWN planner over every
 * record (dry, against an empty store), with the month it is now — so the
 * reading count shown at review is the count a run would produce.
 */
function profileRecipeRow(
  records: Record<string, string>[],
  t: Extract<KpiTransform, { mode: 'recipe' }>,
  grain: string,
  at: Date = new Date(),
): { profile: KpiRowProfile; anomalies: string[]; failure: string | null } {
  const def: PlannerKpiDef = { kpiKey: '__risk', label: 'this KPI', unit: null, isActive: true, sourceIntegrationId: null, grain };
  const plan = planKpiReadings(
    records ?? [],
    [{ suggestionId: 'risk', sourceField: t.recipe.periodField, targetKey: 'kpi:__risk', transform: t }],
    [def],
    new Map(),
    'normal',
    monthIn(at, 'UTC'),
  );
  const rows = (records ?? []).length;
  const cells = rows * Math.max(1, recipeValueFields(t.recipe).length);
  const unusable = plan.skipped + plan.blanks;
  return {
    profile: {
      cells,
      filled: Math.max(0, cells - plan.blanks),
      numeric: Math.max(0, cells - unusable),
      subjects: plan.readings.length,
      periodUnreadable: 0,
    },
    anomalies: plan.anomalies,
    failure: plan.failure,
  };
}

function describeSource(t: KpiTransform): string {
  if (t.mode === 'recipe') return `the recipe "${t.recipe.label}"`;
  return t.mode === 'long'
    ? `column "${t.valueField}" by "${t.periodField}"`
    : `${t.columns.length} period column${t.columns.length === 1 ? '' : 's'} ("${t.columns[0]}"${t.columns.length > 1 ? ` … "${t.columns[t.columns.length - 1]}"` : ''})`;
}

/**
 * Judge one proposed KPI row against the sheet. `targetLabel` is how the KPI
 * is named in the reason ("Revenue (kpi:revenue)").
 */
export function assessKpiRowRisk(
  records: Record<string, string>[],
  t: KpiTransform,
  targetLabel: string,
  isNumber?: (raw: string) => boolean,
  grain: string = 'month',
): MappingRisk {
  const src = describeSource(t);
  const rows = (records ?? []).length;
  if (t.mode === 'recipe') {
    const r = profileRecipeRow(records, t, grain);
    const p = r.profile;
    if (r.failure) {
      return { code: 'period_unreadable', setAside: true, profile: p, reason: `Set aside: ${r.failure.replace(/this KPI \(__risk\)|"this KPI" \(__risk\)/g, targetLabel)}` };
    }
    if (p.subjects === 0) {
      return {
        code: 'never_populated', setAside: true, profile: p,
        reason: `Set aside: ${src} gives no monthly figure from the ${rows} record${rows === 1 ? '' : 's'} read`
          + `${r.anomalies.length ? ` (${r.anomalies.slice(0, 2).join(' ')})` : ''}, so ${targetLabel} would never get a reading.`,
      };
    }
    const notes = r.anomalies.slice(0, 3).map((a) => a.replace(/"__risk"\s?/g, '').replace(/recipe __risk/g, 'the recipe'));
    return {
      code: 'none', setAside: false, profile: p,
      reason: `Computes ${targetLabel}: ${describeKpiRecipe(t.recipe, t.dimensionField)} `
        + `${p.subjects} monthly reading${p.subjects === 1 ? '' : 's'} from ${rows} record${rows === 1 ? '' : 's'}`
        + `${notes.length ? `; ${notes.join(' ')}` : ''}.`,
    };
  }
  const p = profileKpiRow(records, t, isNumber, grain);

  // vm rule 1: nothing to read ⇒ approving it can never write anything.
  if (p.filled === 0) {
    return {
      code: 'never_populated', setAside: true, profile: p,
      reason: `Set aside: ${src} is blank in all ${rows} row${rows === 1 ? '' : 's'} (0 of ${p.cells} cells filled), so ${targetLabel} would never get a reading.`,
    };
  }
  if (p.numeric < p.filled * MIN_NUMERIC_SHARE) {
    return {
      code: 'value_not_numeric', setAside: true, profile: p,
      reason: `Set aside: only ${p.numeric} of ${p.filled} filled cells in ${src} are numbers (${pct(p.numeric, p.filled)}%), `
        + `below the ${MIN_NUMERIC_SHARE * 100}% needed to treat it as ${targetLabel}.`,
    };
  }

  const dated = p.numeric - p.periodUnreadable;
  if (p.subjects === 0 || dated < p.numeric * MIN_NUMERIC_SHARE) {
    return {
      code: 'period_unreadable', setAside: true, profile: p,
      reason: `Set aside: ${p.numeric} numbers found in ${src}, but only ${dated} have a period a run can read `
        + `(${p.periodUnreadable} with a blank, ambiguous or unrecognised period${grain !== 'month' ? `, or one coarser than per ${grain}` : ''}), `
        + `so ${targetLabel} could not be dated reliably.`,
    };
  }

  const parts = [
    `Feeds ${targetLabel} from ${src}: ${p.subjects} distinct reading${p.subjects === 1 ? '' : 's'} from ${rows} row${rows === 1 ? '' : 's'}`
      + (t.dimensionField ? `, split by "${t.dimensionField}"` : ''),
    `${p.filled} of ${p.cells} cells filled (${pct(p.filled, p.cells)}%)`,
  ];
  const notNumbers = p.filled - p.numeric;
  if (notNumbers > 0) parts.push(`${notNumbers} filled cell${notNumbers === 1 ? ' is' : 's are'} not a number and will be skipped`);
  if (p.periodUnreadable > 0) parts.push(`${p.periodUnreadable} value${p.periodUnreadable === 1 ? ' has' : 's have'} no readable period and will be skipped`);
  if (p.cells - p.filled > 0) parts.push(`blanks are skipped and never overwrite a stored figure`);
  return { code: 'none', setAside: false, profile: p, reason: `${parts.join('; ')}.` };
}
