/**
 * DEF-365 — KPI recipes: a figure COMPUTED from the records (count / sum /
 * ratio per month, optionally per dimension value). PURE: no I/O, no clock, no
 * model — the run engine imports it.
 *
 * The arithmetic is the vendored @tmc/ai-integration recipe engine
 * (src/vendor/ai-integration/mapping/recipes.ts, commit c0a6ebe): a Nexeo
 * KpiRecipe is compiled to a framework GoalRecipe and checked with its
 * validateRecipe; the planner evaluates it with evaluateRecipe. The framework
 * models PEOPLE (an owner, a population); a KPI has none, so the compiled
 * recipe is always population 'own' with one synthetic owner per dimension
 * value (or one for the total). Nexeo keeps, around it, its own stricter cell
 * rules (planner.classifyValue / parsePeriodDetailed) — the framework only ever
 * sees canonical numbers and "YYYY-MM" periods.
 */
import { validateRecipe, type GoalRecipe } from '../../../vendor/ai-integration/mapping/recipes';
import type { KpiRecipe, KpiTransform } from '../types';

/** The synthetic field a count recipe reads: every prepared record carries "1". */
export const COUNT_FIELD = '@row';

const MEASURES = new Set(['count', 'sum', 'ratio']);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Every source field the recipe reads (the run's header check uses the same list). */
export function recipeFields(r: KpiRecipe): string[] {
  const out = [r.periodField];
  if (r.measure === 'sum' && r.valueField) out.push(r.valueField);
  if (r.measure === 'ratio') {
    if (r.numeratorField) out.push(r.numeratorField);
    if (r.denominatorField) out.push(r.denominatorField);
  }
  return out;
}

/** The value fields (what the risk check samples). */
export function recipeValueFields(r: KpiRecipe): string[] {
  return recipeFields(r).slice(1);
}

/** The framework recipe this KPI recipe is computed by. */
export function toGoalRecipe(r: KpiRecipe): GoalRecipe {
  const num = r.measure === 'count' ? [{ field: COUNT_FIELD }]
    : r.measure === 'sum' ? [{ field: r.valueField ?? '' }]
      : [{ field: r.numeratorField ?? '' }];
  return {
    id: 'kpi',
    label: r.label,
    unit: r.measure === 'ratio' && r.scale === 100 ? 'percent' : 'numerical',
    shape: { kind: 'period-column', field: r.periodField },
    value: r.measure === 'ratio'
      ? { num, den: [{ field: r.denominatorField ?? '' }], ...(r.scale !== undefined ? { scale: r.scale } : {}) }
      : { num },
    rows: 'sum',
    population: 'own',
    // Pooled (Σnum ÷ Σden) for a ratio — never an average of per-row ratios.
    people: r.measure === 'ratio' ? 'pool' : 'sum',
    year: 'goal-rule',
  };
}

/**
 * A stored or proposed recipe, checked: the KpiRecipe, or the reason it is not
 * one. With `headers`, every field must be a real header (exact match) — the
 * framework's validateRecipe decides that, plus Nexeo's own rules.
 */
export function readKpiRecipe(raw: unknown, headers?: string[]): KpiRecipe | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'recipe is missing';
  const o = raw as Record<string, unknown>;
  const measure = typeof o.measure === 'string' ? o.measure : '';
  if (!MEASURES.has(measure)) return 'recipe.measure must be "count", "sum" or "ratio"';
  const periodField = str(o.periodField);
  if (!periodField) return 'a recipe needs a periodField';
  const label = (str(o.label) ?? '').trim().slice(0, 200);
  const r: KpiRecipe = { measure: measure as KpiRecipe['measure'], periodField, label: label || `${measure} per month` };
  if (measure === 'sum') {
    const v = str(o.valueField);
    if (!v) return 'a sum recipe needs a valueField';
    r.valueField = v;
  }
  if (measure === 'ratio') {
    const n = str(o.numeratorField); const d = str(o.denominatorField);
    if (!n || !d) return 'a ratio recipe needs numeratorField and denominatorField';
    if (n === d) return 'the numerator and denominator are the same field';
    r.numeratorField = n; r.denominatorField = d;
    if (o.scale !== undefined && o.scale !== null) {
      const sc = Number(o.scale);
      if (!Number.isFinite(sc) || sc <= 0 || sc > 1_000_000) return 'recipe.scale must be a positive number';
      r.scale = sc;
    }
  }
  if (recipeValueFields(r).includes(r.periodField)) return 'the period field is also used as a value';
  if (headers) {
    if (headers.includes(COUNT_FIELD)) return `the source has a field named "${COUNT_FIELD}", which recipes reserve`;
    const errors = validateRecipe(toGoalRecipe(r), [...headers, ...(r.measure === 'count' ? [COUNT_FIELD] : [])]);
    // validateRecipe compares case-insensitively; the run's header check is exact.
    const missing = recipeFields(r).filter((f) => !headers.includes(f));
    if (missing.length) return `column "${missing[0]}" is not in the source`;
    if (errors.length) return errors[0]!;
  }
  return r;
}

/** Plain words for the admin — the StepReview row and the run report. */
export function describeKpiRecipe(r: KpiRecipe, dimensionField?: string): string {
  const what = r.measure === 'count'
    ? 'Counts the records'
    : r.measure === 'sum'
      ? `Adds up "${r.valueField}"`
      : `Divides the total of "${r.numeratorField}" by the total of "${r.denominatorField}"${r.scale && r.scale !== 1 ? ` × ${r.scale}` : ''}`;
  const split = dimensionField ? `, separately for each "${dimensionField}"` : '';
  return `${what} per month (dated by "${r.periodField}")${split}; only months that have ended; blanks and non-numbers are skipped.`;
}

/** The transform's fields when it is a recipe; [] otherwise. */
export function recipeTransformFields(t: KpiTransform): string[] {
  if (t.mode !== 'recipe') return [];
  return t.dimensionField ? [...recipeFields(t.recipe), t.dimensionField] : recipeFields(t.recipe);
}
