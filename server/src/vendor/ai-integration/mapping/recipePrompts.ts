/**
 * The AI's part of a goal feed: recipes, and which goals they feed.
 * =================================================================
 *
 * Two model calls, both governed by every comment the administrator wrote in
 * the wizard (the brief, the notes on each field, each "Ask the AI"):
 *
 *   1. RECIPES — from the source's fields and values, the figures it can give
 *      goals, each as a recipe in the fixed vocabulary of integrationRecipes.
 *      Code validates every recipe against the fields the source really sends;
 *      one that cannot be computed is dropped and said.
 *   2. RECOGNITION — which goal and key-result titles each recipe is FOR,
 *      judged by meaning (title, unit, target type), not by exact wording: "Total
 *      Bench (locked target)", "Project Hygiene: Maintain Total Bench" and
 *      "Keep my personal bench time below 5%" are one kind of goal.
 *
 * The model never computes a figure. Its recipes are shown as sentences with
 * sample figures for real people, and an administrator approves each one.
 */
import type { GoalRecipe, RecipeTerm } from './recipes';
import { validateRecipe } from './recipes';

/* ── call 1: recipes ──────────────────────────────────────────────────────── */

export const RECIPE_SYSTEM_PROMPT = `You design how an external system's data becomes the figures of performance goals.
You do NOT compute numbers. You write RECIPES in a fixed JSON vocabulary that code will compute.

THE ADMINISTRATOR'S INSTRUCTIONS ARE AUTHORITATIVE. They were written at different steps of the wizard
(the brief, notes on particular fields, questions asked later). Where an instruction says how a figure is
built — which columns, whose rows (own or the team), sum or average, a ratio — follow it exactly, and list
the instruction(s) you followed in "basedOn" (quote a few words of each). Never contradict one.

A recipe:
{
  "id": short kebab-case id, unique,
  "label": a short name for the figure (e.g. "Team bench %", "Risks converted to issues %"),
  "unit": "percent" | "numerical" | "days" | "currency"   — the unit of the figure produced,
  "shape": {"kind":"period-column","field":<the column that names the month>}
         | {"kind":"month-columns"}   — the source has one column per month ("Jan 2026", "Feb 2026", …)
         | {"kind":"snapshot"}        — the source has no month; the figure is "as of today",
  "value": {"num":[{"field":..,"sign":1|-1},...], "den":[...] (optional), "scale": number (optional)},
           — for month-columns use the field "@month" for the month column being read
           — a ratio is num ÷ den × scale (e.g. ×100 for a percentage)
  "rows": "sum" | "mean"         — several rows of ONE person in one month (e.g. one row per project): add them, or average,
  "population": "own" | "team" | "direct-team"  — the person's own rows, or the person and everyone below them, or their direct reports,
  "people": "mean" | "sum" | "pool"  — how the people combine for team populations ("pool" = Σnum ÷ Σden, only with a den),
  "year": "goal-rule" | "ratio-of-sums"  — use "ratio-of-sums" for every ratio, so a year is never an average of monthly %,
  "guards": {"min": number, "max": number} (optional; e.g. 0..100 for a percentage),
  "covers": one sentence: which goals this figure is for, by meaning,
  "basedOn": [the instructions you followed]
}

RULES
- Use ONLY fields that are in the field list, spelled exactly. Never invent a field.
- Never use a column that is a total of the year or a forecast as a month's figure.
- One recipe per distinct figure the source can give goals. Do not make a recipe the source cannot support;
  list it under "unavailable" with the reason instead.
- If the instructions do not say whose rows, use "own".

Return ONLY JSON: {"recipes":[...], "unavailable":[{"what":..,"why":..}], "summary": two sentences}`;

export interface RecipeSourceField { name: string; filled: number; total: number; samples: string[] }
export interface Instruction { where: string; text: string }

export const recipeUserMessage = (input: {
  integration: string;
  identityField: string | null;
  periodField: string | null;
  monthColumns: string[];
  fields: RecipeSourceField[];
  instructions: Instruction[];
}): string => [
  `SYSTEM: ${input.integration}`,
  `The person each row is about: ${input.identityField ?? '(not known)'}.`,
  input.periodField ? `A column names the month of each row: ${input.periodField}.` : 'No column names the month of a row.',
  input.monthColumns.length ? `Month columns: ${input.monthColumns.join(', ')}.` : 'There are no month columns.',
  '',
  "ADMINISTRATOR'S INSTRUCTIONS (authoritative):",
  ...(input.instructions.length ? input.instructions.map((i) => `- [${i.where}] ${i.text}`) : ['- (none)']),
  '',
  'FIELDS (name · filled/total · sample values):',
  ...input.fields.map((f) => `- ${f.name} · ${f.filled}/${f.total} · ${f.samples.slice(0, 6).join(' | ')}`),
].join('\n');

/** First "{"…last "}" of a model reply, parsed — or null. */
const parseJson = (text: string): unknown => {
  const t = String(text ?? '').replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
};

const asTerms = (v: unknown): RecipeTerm[] => (Array.isArray(v) ? v : []).flatMap((t) => {
  const field = String((t as { field?: unknown })?.field ?? '').trim();
  if (!field) return [];
  return [{ field, ...((t as { sign?: unknown }).sign === -1 ? { sign: -1 as const } : {}) }];
});

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(String(v)) ? (String(v) as T) : fallback;

/**
 * The model's recipes, each checked against the fields the source sends —
 * the ones that can be computed, and why the rest were dropped.
 */
export const parseRecipeProposal = (text: string, sourceFields: string[]): {
  recipes: GoalRecipe[]; dropped: string[]; unavailable: string[]; summary: string;
} => {
  const raw = parseJson(text) as { recipes?: unknown[]; unavailable?: unknown[]; summary?: unknown } | null;
  if (!raw) return { recipes: [], dropped: ['The AI did not return usable recipes.'], unavailable: [], summary: '' };
  const recipes: GoalRecipe[] = []; const dropped: string[] = []; const ids = new Set<string>();
  for (const r of Array.isArray(raw.recipes) ? raw.recipes : []) {
    const o = r as Record<string, unknown>;
    const shapeIn = (o.shape ?? {}) as Record<string, unknown>;
    const kind = pick(shapeIn.kind, ['period-column', 'month-columns', 'snapshot'] as const, 'snapshot');
    const shape: GoalRecipe['shape'] = kind === 'period-column'
      ? { kind, field: String(shapeIn.field ?? '') } : { kind };
    const v = (o.value ?? {}) as Record<string, unknown>;
    const den = asTerms(v.den);
    const scale = Number(v.scale);
    let id = String(o.id ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60) || 'recipe';
    while (ids.has(id)) id = `${id}-2`;
    const g = (o.guards ?? {}) as Record<string, unknown>;
    const recipe: GoalRecipe = {
      id,
      label: String(o.label ?? id).slice(0, 120),
      unit: pick(o.unit, ['percent', 'numerical', 'days', 'currency'] as const, 'numerical'),
      shape,
      value: { num: asTerms(v.num), ...(den.length ? { den } : {}), ...(Number.isFinite(scale) && scale !== 0 && scale !== 1 ? { scale } : {}) },
      rows: pick(o.rows, ['sum', 'mean'] as const, 'sum'),
      population: pick(o.population, ['own', 'team', 'direct-team'] as const, 'own'),
      people: pick(o.people, ['mean', 'sum', 'pool'] as const, 'mean'),
      year: pick(o.year, ['goal-rule', 'ratio-of-sums'] as const, den.length ? 'ratio-of-sums' : 'goal-rule'),
      ...((Number.isFinite(Number(g.min)) || Number.isFinite(Number(g.max)))
        ? { guards: { ...(Number.isFinite(Number(g.min)) ? { min: Number(g.min) } : {}), ...(Number.isFinite(Number(g.max)) ? { max: Number(g.max) } : {}) } }
        : {}),
      ...(o.covers ? { covers: String(o.covers).slice(0, 400) } : {}),
      ...(Array.isArray(o.basedOn) ? { basedOn: o.basedOn.map((x) => String(x).slice(0, 200)).slice(0, 8) } : {}),
    };
    // A pooled population needs a divisor; without one it means "mean".
    if (recipe.people === 'pool' && !den.length) recipe.people = 'mean';
    const errors = validateRecipe(recipe, sourceFields);
    if (errors.length) { dropped.push(`"${recipe.label}" cannot be computed: ${errors.join(' ')}`); continue; }
    ids.add(id);
    recipes.push(recipe);
  }
  const unavailable = (Array.isArray(raw.unavailable) ? raw.unavailable : []).map((u) => {
    const x = u as Record<string, unknown>;
    return `${String(x.what ?? 'A figure')}: ${String(x.why ?? 'not in the source')}`;
  });
  return { recipes, dropped, unavailable, summary: String(raw.summary ?? '').trim() };
};

/* ── call 2: recognition ──────────────────────────────────────────────────── */

export const RECOGNITION_SYSTEM_PROMPT = `You decide which performance goals a figure is for, by MEANING — not by exact wording.
For each goal title, answer with the recipe whose figure measures what the goal measures, or null.
- Match the meaning: "Total Bench (locked target)", "Project Hygiene: Maintain Total Bench" and "Keep my personal bench time below 5%"
  all measure bench. A title that only mentions the word in passing (e.g. "Improve utilization") is NOT a match.
- The goal's unit must be the recipe's unit (a % goal takes a percent figure; a numerical goal a numerical one).
- The goal's direction must fit the figure: a "lower is better" figure (bench, risks converted, missing punches) does not fit a goal
  whose target type is Increase / Stay Above with a high target such as 95%.
- Follow the administrator's instructions where they say which goals a figure is or is not for.
- A line starting "[key result]" is a key result, otherwise a goal — echo the title EXACTLY as given, prefix included.
- confidence: 0..1. reason: at most 12 words.
Return ONLY JSON: {"decisions":[{"title": <exactly as given>, "recipe": <recipe id or null>, "confidence": number, "reason": string}]}`;

/** How a candidate is shown to the model — and echoed back: a key result is marked, so a goal and a key result with one title stay apart. */
export const candidateLine = (t: TitleCandidate): string => `${t.kind === 'kr' ? '[key result] ' : ''}${t.title}`;

export interface TitleCandidate {
  title: string;
  goals: number;
  integrationDriven: number;
  units: string[];
  types: string[];
  kind: 'goal' | 'kr';
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'your', 'their', 'this', 'that', 'each', 'goal', 'goals', 'month', 'total', 'number', 'count', 'rate', 'percentage', 'percent', 'ensure', 'maintain', 'manage', 'improve', 'reduce', 'keep', 'target', 'locked', 'within', 'below', 'above']);
const words = (s: string): string[] => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));
const stem = (w: string): string => w.replace(/(ings|ing|ies|es|s|ed)$/, '');

/**
 * The titles worth asking the AI about: those sharing a meaningful word with a
 * recipe (its label, what it covers, its fields) or with the administrator's
 * instructions. Thousands of unrelated titles never reach the model; a variant
 * wording of a fed goal almost always shares its key noun ("bench", "risk",
 * "punch", "package").
 */
export const shortlistTitles = (
  candidates: TitleCandidate[],
  recipes: GoalRecipe[],
  instructions: Instruction[],
): TitleCandidate[] => {
  const vocab = new Set<string>();
  for (const r of recipes) {
    for (const w of [...words(r.label), ...words(r.covers ?? ''), ...[...r.value.num, ...(r.value.den ?? [])].flatMap((t) => words(t.field))]) vocab.add(stem(w));
  }
  for (const i of instructions) for (const w of words(i.text)) vocab.add(stem(w));
  return candidates.filter((c) => words(c.title).some((w) => vocab.has(stem(w))));
};

export const recognitionUserMessage = (recipes: GoalRecipe[], describe: (r: GoalRecipe) => string, titles: TitleCandidate[], instructions: Instruction[]): string => [
  'RECIPES:',
  ...recipes.map((r) => `- ${r.id} · unit ${r.unit} · ${describe(r)}${r.covers ? ` · for: ${r.covers}` : ''}`),
  '',
  "ADMINISTRATOR'S INSTRUCTIONS:",
  ...(instructions.length ? instructions.map((i) => `- [${i.where}] ${i.text}`) : ['- (none)']),
  '',
  'GOAL TITLES (title · how many goals · how many set to Integration · units · target types · goal or key result):',
  ...titles.map((t) => `- ${candidateLine(t)} · ${t.goals} · ${t.integrationDriven} · ${t.units.join('/') || 'no unit'} · ${t.types.join('/') || '-'}`),
].join('\n');

/** The model's decisions, kept only for titles it was asked about and recipes that exist. */
export const parseRecognition = (text: string, recipeIds: Set<string>, titles: Set<string>): Array<{
  title: string; recipe: string | null; confidence: number; reason: string;
}> => {
  const raw = parseJson(text) as { decisions?: unknown[] } | null;
  if (!raw || !Array.isArray(raw.decisions)) return [];
  return raw.decisions.flatMap((d) => {
    const x = d as Record<string, unknown>;
    const title = String(x.title ?? '');
    if (!titles.has(title)) return [];
    const recipe = x.recipe != null && recipeIds.has(String(x.recipe)) ? String(x.recipe) : null;
    const confidence = Math.max(0, Math.min(1, Number(x.confidence) || 0));
    return [{ title, recipe, confidence, reason: String(x.reason ?? '').slice(0, 300) }];
  });
};

/** A decision strong enough to feed a goal without a person checking it first. */
export const RECOGNITION_THRESHOLD = 0.7;

/* ── at each run: source drift ────────────────────────────────────────────── */

/**
 * Approved recipes the source can no longer compute — a field they read is
 * gone or renamed. Those recipes PAUSE for the run (nothing written, never 0)
 * and the run says which and why.
 */
export const recipesBrokenBy = (recipes: GoalRecipe[], sourceFields: string[]): Array<{ id: string; label: string; why: string }> =>
  recipes.flatMap((r) => {
    const errors = validateRecipe(r, sourceFields);
    return errors.length ? [{ id: r.id, label: r.label, why: errors.join(' ') }] : [];
  });

/** Fields the source sends now that the mapping's field table did not have. */
export const newSourceFields = (known: string[], now: string[]): string[] => {
  if (known.length === 0) return [];
  const k = new Set(known.map((f) => f.trim().toLowerCase()));
  return now.filter((f) => !k.has(f.trim().toLowerCase()));
};
