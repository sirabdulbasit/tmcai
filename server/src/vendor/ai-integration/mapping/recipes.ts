/**
 * Goal recipes — how a goal's figure is built from a feed.
 * ========================================================
 *
 * The AI reads the source, the goals and every comment the administrator wrote
 * in the wizard, and writes a RECIPE: which fields, which months, whose rows,
 * how they combine. The recipe is data in a small fixed vocabulary; this module
 * checks it and computes it. The model never produces a figure — the same
 * source gives the same figure on every run, and the recipe's sentence is shown
 * wherever its figures appear. .
 *
 * What a recipe can say, from the four real feeds:
 *   shape       one row per person per month (a period column) · month COLUMNS
 *               (Bench) · a snapshot with no month (Risk, Work Packages), which
 *               counts for the last month that has passed
 *   value       a field · a sum or difference of fields · a ratio of them × scale
 *   rows        several rows of one person in one month: summed or averaged
 *   population  the person alone, or the person and everyone below them (or
 *               their direct reports) — combined by mean, sum, or pooled
 *               (Σ numerators ÷ Σ divisors)
 *   year        the goal's own rule over its cells, or the ratio of the year's
 *               totals (never an average of monthly percentages)
 *   guards      the range a figure must fall in; outside it, nothing is written
 *
 * Only months that have PASSED are produced: a month still running, or one to
 * come, is never read (a feed can carry forecast months — Bench did).
 */
import { recordPeriod, lastClosedMonth, type RecordPeriod } from './periods';

export interface RecipeTerm {
  /** A source field, or "@month" for the month column being read (month-columns shape). */
  field: string;
  sign?: 1 | -1;
}

export interface GoalRecipe {
  id: string;
  label: string;
  /** The unit of the figure produced — matched against the goal's target unit. */
  unit: 'percent' | 'numerical' | 'days' | 'currency';
  shape:
    | { kind: 'period-column'; field: string }
    | { kind: 'month-columns' }
    | { kind: 'snapshot' };
  value: { num: RecipeTerm[]; den?: RecipeTerm[]; scale?: number };
  /** Several rows of one person in one month. */
  rows: 'sum' | 'mean';
  population: 'own' | 'team' | 'direct-team';
  /** Across the population: mean of each person's figure, their sum, or pooled Σnum ÷ Σden. */
  people: 'mean' | 'sum' | 'pool';
  year: 'goal-rule' | 'ratio-of-sums';
  guards?: { min?: number; max?: number };
  /** What the AI recognised this recipe as covering, and which comment it followed — shown, never computed with. */
  covers?: string;
  basedOn?: string[];
}

export interface RecipeMonth { year: number; month: number; value: number; people: number }

export interface RecipeResult {
  months: RecipeMonth[];
  /** Set only for year: 'ratio-of-sums' — otherwise the goal's own rule makes the year. */
  year: number | null;
  issues: string[];
}

/** A cell as a source writes it. "-", blanks and text are NO figure — never 0. */
export const parseFigure = (raw: unknown): number | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim();
  if (s === '' || /^[-–—]+$/.test(s)) return null;
  const cleaned = s.replace(/[\s,](?=\d)/g, '').replace(/%$/, '');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

const monthKey = (y: number, m: number) => y * 100 + m;
const fieldsOf = (r: GoalRecipe): string[] =>
  [...r.value.num, ...(r.value.den ?? [])].map((t) => t.field);

/** Everything wrong with a recipe against the fields the source actually has — empty when it can be computed. */
export const validateRecipe = (r: GoalRecipe, sourceFields: string[]): string[] => {
  const errors: string[] = [];
  const has = new Set(sourceFields.map((f) => f.trim().toLowerCase()));
  const months = r.shape.kind === 'month-columns';
  if (r.shape.kind === 'period-column' && !has.has(r.shape.field.trim().toLowerCase())) {
    errors.push(`The field "${r.shape.field}" is not in the source.`);
  }
  if (!r.value.num.length) errors.push('The recipe reads no field.');
  for (const f of fieldsOf(r)) {
    if (f === '@month') {
      if (!months) errors.push('"@month" is only for a source with month columns.');
    } else if (!has.has(f.trim().toLowerCase())) {
      errors.push(`The field "${f}" is not in the source.`);
    }
  }
  if (months && !fieldsOf(r).includes('@month')) {
    errors.push('A source with month columns is read through "@month", the month being read.');
  }
  if (r.year === 'ratio-of-sums' && !(r.value.den && r.value.den.length)) {
    errors.push('A ratio-of-sums year needs a divisor.');
  }
  if (r.people === 'pool' && !(r.value.den && r.value.den.length)) {
    errors.push('Pooling people needs a divisor.');
  }
  if (r.value.scale !== undefined && !(Number.isFinite(r.value.scale) && r.value.scale !== 0)) {
    errors.push('The scale must be a number other than 0.');
  }
  return errors;
};

/** The months a source's month columns stand for, by header ("Jan 2026" → 2026-01). */
const monthColumns = (record: Record<string, unknown>): Array<{ header: string; year: number; month: number }> =>
  Object.keys(record).flatMap((h) => {
    const p = recordPeriod(h);
    return p && 'month' in p ? [{ header: h, year: p.year, month: p.month }] : [];
  });

const termSum = (terms: RecipeTerm[], rec: Record<string, unknown>, monthHeader: string | null): number | null => {
  let total = 0;
  for (const t of terms) {
    const v = parseFigure(t.field === '@month' ? (monthHeader ? rec[monthHeader] : null) : rec[t.field]);
    if (v === null) return null; // a missing part leaves no figure, never a partial sum
    total += (t.sign ?? 1) * v;
  }
  return total;
};

/**
 * The figure for each passed month of the owner's goal, from every record of
 * the people the recipe says to read. Pure: the caller supplies the records of
 * a person and the population of the owner.
 */
export const evaluateRecipe = (
  r: GoalRecipe,
  ctx: {
    owner: string;
    recordsOf: (person: string) => Array<Record<string, unknown>>;
    populationOf: (owner: string) => string[];
    now: { year: number; month: number };
  },
): RecipeResult => {
  const issues: string[] = [];
  const scale = r.value.scale ?? 1;
  const ratio = !!(r.value.den && r.value.den.length);
  const passed = (y: number, m: number) => y === ctx.now.year && monthKey(y, m) < monthKey(ctx.now.year, ctx.now.month);
  const snap = lastClosedMonth(ctx.now);
  const people = r.population === 'own' ? [ctx.owner] : ctx.populationOf(ctx.owner);

  // person → month → the readings of that person's rows in that month
  type Cell = { num: number[]; den: number[] };
  const byMonth = new Map<number, Map<string, Cell>>();
  const add = (person: string, y: number, m: number, num: number | null, den: number | null) => {
    if (!passed(y, m) || num === null || (ratio && den === null)) return;
    const k = monthKey(y, m);
    const persons = byMonth.get(k) ?? new Map<string, Cell>();
    const c = persons.get(person) ?? { num: [], den: [] };
    c.num.push(num);
    if (ratio) c.den.push(den!);
    persons.set(person, c);
    byMonth.set(k, persons);
  };

  for (const person of people) {
    for (const rec of ctx.recordsOf(person)) {
      if (r.shape.kind === 'month-columns') {
        for (const col of monthColumns(rec)) {
          add(person, col.year, col.month, termSum(r.value.num, rec, col.header), ratio ? termSum(r.value.den!, rec, col.header) : null);
        }
      } else {
        const p: RecordPeriod | null = r.shape.kind === 'period-column' ? recordPeriod(rec[r.shape.field]) : snap;
        if (!p || !('month' in p)) continue;
        const pm = p as { year: number; month: number };
        add(person, pm.year, pm.month, termSum(r.value.num, rec, null), ratio ? termSum(r.value.den!, rec, null) : null);
      }
    }
  }

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const mean = (xs: number[]) => sum(xs) / xs.length;
  const months: RecipeMonth[] = [];
  let yearNum = 0; let yearDen = 0;
  for (const k of [...byMonth.keys()].sort((a, b) => a - b)) {
    const y = Math.floor(k / 100); const m = k % 100;
    const persons = [...byMonth.get(k)!.values()];
    // Each person's rows first (a person with three projects is one person).
    const pn = persons.map((c) => (r.rows === 'mean' ? mean(c.num) : sum(c.num)));
    const pd = persons.map((c) => (ratio ? (r.rows === 'mean' ? mean(c.den) : sum(c.den)) : 1));
    let value: number | null;
    if (ratio && r.people === 'pool') {
      const d = sum(pd);
      value = d > 0 ? (sum(pn) / d) * scale : null;
      if (value !== null) { yearNum += sum(pn); yearDen += d; }
    } else {
      const each = persons.map((_, i) => (ratio ? (pd[i]! > 0 ? (pn[i]! / pd[i]!) * scale : null) : pn[i]! * scale))
        .filter((v): v is number => v !== null);
      value = each.length ? (r.people === 'sum' ? sum(each) : mean(each)) : null;
      if (ratio && value !== null) { yearNum += sum(pn); yearDen += sum(pd); }
    }
    if (value === null) { issues.push(`${y}-${String(m).padStart(2, '0')}: nothing to divide by — left blank.`); continue; }
    const lo = r.guards?.min; const hi = r.guards?.max;
    if ((lo !== undefined && value < lo) || (hi !== undefined && value > hi)) {
      issues.push(`${y}-${String(m).padStart(2, '0')}: ${Math.round(value * 100) / 100} is outside ${lo ?? '−∞'}–${hi ?? '∞'} — not written.`);
      continue;
    }
    months.push({ year: y, month: m, value: Math.round(value * 100) / 100, people: persons.length });
  }
  const year = r.year === 'ratio-of-sums' && yearDen > 0 ? (yearNum / yearDen) * scale : null;
  return { months, year, issues };
};

/** The sentence shown on the mapping row, in the run report and on the goal. */
export const describeRecipe = (r: GoalRecipe): string => {
  const term = (ts: RecipeTerm[]) => ts.map((t, i) => `${i === 0 ? (t.sign === -1 ? '−' : '') : (t.sign === -1 ? ' − ' : ' + ')}${t.field === '@month' ? "each month's column" : t.field}`).join('');
  const ratio = !!(r.value.den && r.value.den.length);
  const what = ratio
    ? `(${term(r.value.num)}) ÷ (${term(r.value.den!)})${r.value.scale && r.value.scale !== 1 ? ` × ${r.value.scale}` : ''}`
    : `${term(r.value.num)}${r.value.scale && r.value.scale !== 1 ? ` × ${r.value.scale}` : ''}`;
  const who = r.population === 'own'
    ? (r.rows === 'sum' ? ", the person's rows added first" : ", the person's rows averaged")
    : `, ${r.people === 'mean' ? 'averaged' : r.people === 'sum' ? 'added up' : 'pooled'} over the person and ${r.population === 'team' ? 'everyone below them' : 'their direct reports'}`;
  const when = r.shape.kind === 'snapshot'
    ? '; the snapshot counts for the last month that has passed'
    : '; only months that have passed';
  const year = r.year === 'ratio-of-sums' ? "; the year is the ratio of the year's totals" : '';
  return `${r.label}: ${what}${who}${when}${year}; "-" is no figure.`;
};

/** A goal's or key result's assignment to a recipe, as stored per integration. */
export interface RecipeDecision {
  kind: 'goal' | 'kr';
  id: number;
  recipeId: string;
  status: 'active' | 'rejected' | 'none' | 'review';
  mappingVersion: number | null;
  titleSeen: string | null;
}

/**
 * Which goals and key results an integration's approved recipes feed — the one
 * rule a run writes by and the goal form explains by, so the two cannot differ.
 *
 * The assignments the running mapping version carries first, then the decisions
 * taken since: an administrator's rejection always holds; any other decision
 * holds only for the version it was taken against (a newer version asks again),
 * and feeds only when it is active and names an approved recipe. `decided` is
 * what recognition must not ask about again: key → the title the decision was
 * taken against (null = whatever the title).
 */
export const recipeTargetsFrom = (input: {
  /** The approved recipes of the running version. */
  recipes: GoalRecipe[];
  versioned: Array<{ kind: 'goal' | 'kr'; id: number; recipeId: string }>;
  decisions: RecipeDecision[];
  mappingVersion: number | null;
}): { targets: Map<string, GoalRecipe>; decided: Map<string, string | null> } => {
  const byId = new Map(input.recipes.map((r) => [r.id, r] as const));
  const targets = new Map<string, GoalRecipe>();
  for (const a of input.versioned) {
    const r = byId.get(a.recipeId);
    if (r) targets.set(`${a.kind}:${a.id}`, r);
  }
  const decided = new Map<string, string | null>(input.versioned.map((a) => [`${a.kind}:${a.id}`, null]));
  for (const a of input.decisions) {
    const key = `${a.kind}:${a.id}`;
    if (a.status === 'rejected') { targets.delete(key); decided.set(key, null); continue; }
    if (a.mappingVersion !== input.mappingVersion) continue; // stale: asked again
    decided.set(key, a.titleSeen);
    const r = a.status === 'active' ? byId.get(a.recipeId) : undefined;
    if (r) targets.set(key, r); else targets.delete(key);
  }
  return { targets, decided };
};
