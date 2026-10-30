/**
 * DEF-354 — Integrations Stage 1: the AI mapping proposer (DESIGN TIME ONLY).
 *
 * The ONE module under services/integrations/ that calls a model (spec §1: the
 * model proposes what each source field means; every run is deterministic
 * code). It reads the sheet, takes stock of every column, asks the model which
 * columns feed which KPI, then checks every answer against the sheet before the
 * admin sees it. It writes ONE new mapping version and its suggestion rows in
 * one transaction — and nothing else: no KPI reading, no KPI definition (the
 * admin approving a `kpi:new:` row is what creates a definition — mappingStore).
 *
 * Ported from vm integrationAiMapper.ts (proposeMapping / buildUserMessage /
 * validate), integrationMappingDelta.ts (carryApprovedMapping) and the
 * rejected-pairs feedback (integrationSyncService.listRejectedMappings), with
 * the vm goal/employee vocabulary replaced by KPI targets. Rules enforced here:
 *   - a new proposal KEEPS what is approved (vm §9): every APPROVED row of the
 *     previous version is copied unchanged (carried_from_id set) and is listed
 *     to the model as settled, so it proposes only the rest;
 *   - rejected pairs are settled ACROSS ALL VERSIONS (vm fed back only one row
 *     kind; notes_vm-mapper §3 gap a) — re-proposing one is dropped unless the
 *     admin's instruction this time asks for it;
 *   - proposable ≠ writable: a key outside the active catalogue is dropped
 *     unless the model proposes it as a NEW KPI; a KPI another integration feeds
 *     is set aside (vm §9 "one field, one owner"); a second source aimed at an
 *     already-fed KPI is set aside, never merged (vm MappingDelta.ts:124);
 *   - arithmetic beats the model's word: mappingRisk turns a never-populated or
 *     non-numeric row into SET_ASIDE with the numbers in `reason`;
 *   - a truncated answer is never half-saved: the JSON contract ends with
 *     `"complete": true`, and an answer without it is an error (callLLM returns
 *     no finishReason, so the sentinel is the only truncation guard —
 *     notes_vm-mapper §1.3 gap 1).
 *
 * DEF-362 (Stage 1b, spec §2b "Review & Mapping") widens what a row may be.
 * The model gets, in order: the AI's reading of the API document, the admin's
 * remarks, filter words, connect instructions, the field inventory, per-field
 * notes, the KPI catalogue, approved rows kept and rejected pairs settled. For
 * every field it proposes one of:
 *   - KPI (Stage 1 shapes, unchanged checks);
 *   - Context — `context:per_record` (title field + body fields ⇒ one knowledge
 *     page per record) or `context:table` (chosen columns ⇒ one page); every
 *     field named must be a real field, and a title that is never filled or a
 *     per-record set larger than integrations.max_context_pages is said in
 *     numbers (SET_ASIDE / reason), never discovered at run time;
 *   - the ONE structured filter row made from the filter words, validated
 *     against the real fields (engine/recordFilter.validateRecordFilter) and
 *     counted against the records read ("keeps 412 of 980"); a filter that
 *     keeps nothing is SET_ASIDE. Nothing filters until it is approved;
 *   - "not used", with the reason. DECISION: these become NOTICES (and
 *     spec.notUsed), not suggestion rows — a row is something an admin can
 *     approve into a run, and "not used" writes nothing, so it must not sit in
 *     the approvable list or count toward "≥1 approved row" at turn-on.
 * Every row carries `followed`: which remark / filter words / instruction it
 * followed (the owner's "every row says which remark it followed").
 */
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { callLLM } from '../../llmRouter';
import { readSource, sourceProblem } from '../sources';
import { getBehaviorValue } from '../../behaviorConfig';
import { buildFieldCoverage } from './fieldInventory';
import { assessKpiRowRisk, transformFields, transformValueColumns } from './mappingRisk';
import { readKpiRecipe } from '../engine/kpiRecipe';
import { applyRecordFilter, validateRecordFilter } from '../engine/recordFilter';
import {
  FILTER_TARGET_KEY,
  IntegrationInputError,
  IntegrationNotFoundError,
  KPI_KEY_RE,
  type AiProposerModule,
  type ContextTargetKey,
  type ContextTransform,
  type FieldCoverage,
  type KpiTargetKey,
  type KpiTransform,
  type ProposeOptions,
  type ProposeResult,
  type ReadResult,
  type RecordFilter,
  type TargetKind,
} from '../types';

const log = createLogger('integrations-proposer');

export const PROPOSER_PURPOSE = 'integration_mapping';
/** The mapping call takes far longer than the router's 15 s default (vm took
 *  minutes on wide sources; notes_vm-mapper §1.3 gap 3). */
export const PROPOSER_TIMEOUT_MS = 180_000;
/** Pro then Claude, never the Flash fallback: Flash forces thinking to 0 and the
 *  mapping answer would silently change model (notes §1.3 gap 4). The provider
 *  that answered is reported in the result either way. */
export const PROPOSER_PROVIDERS = ['gemini', 'claude'] as const;
/** Rows shown to the model so it can SEE the layout (long vs wide). The
 *  inventory, not these rows, is the evidence — it covers every record. */
export const PROMPT_SAMPLE_ROWS = 5;
const PROMPT_CELL_CHARS = 60;

/** A proposal that could not be produced, in words the admin can act on.
 *  `code` maps to a 400 in the route's error table. */
export class ProposalError extends Error {
  readonly code = 'INTEGRATION_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'ProposalError';
  }
}

/** Progress callback for the job overlay (proposalJobs). Plain text only. */
export type ProposalStageFn = (stage: string) => void;

// ── The model's answer ────────────────────────────────────────────────────

interface RawRow {
  /** 'kpi' | 'context' | 'filter' | 'not_used'. Absent ⇒ 'kpi' (Stage 1 answers). */
  kind?: unknown;
  targetKey?: unknown;
  newKpi?: unknown;
  transform?: unknown;
  /** filter rows: the RecordFilter. */
  filter?: unknown;
  /** not_used rows: the field set aside. */
  field?: unknown;
  why?: unknown;
  /** DEF-362: which remark / filter words / instruction the row followed. */
  followed?: unknown;
}

export interface ParsedAnswer {
  summary: string;
  rows: RawRow[];
  notices: string[];
}

/**
 * Strict parse of the model's reply. Leniency is limited to ONE surrounding
 * markdown code fence (models add it even when told not to); there is no
 * "find the first {…}" salvage, because a salvaged half-answer is exactly the
 * truncated proposal the sentinel exists to refuse.
 */
export function parseProposerAnswer(text: string): ParsedAnswer {
  let body = (text ?? '').trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(body);
  if (fence) body = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ProposalError('The AI answer was cut off or was not valid JSON, so nothing was saved. Please try again.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProposalError('The AI answer was not a mapping object, so nothing was saved. Please try again.');
  }
  const o = parsed as Record<string, unknown>;
  // The sentinel: the contract ends with it, so its absence means the model
  // stopped early even though what it did send happened to parse.
  if (o.complete !== true) {
    throw new ProposalError('The AI answer was incomplete (no completion marker), so nothing was saved. Please try again.');
  }
  if (!Array.isArray(o.rows)) {
    throw new ProposalError('The AI answer had no list of mapping rows, so nothing was saved. Please try again.');
  }
  return {
    summary: typeof o.summary === 'string' ? o.summary.trim() : '',
    rows: o.rows.filter((r): r is RawRow => !!r && typeof r === 'object' && !Array.isArray(r)),
    notices: Array.isArray(o.notices) ? o.notices.filter((n): n is string => typeof n === 'string' && !!n.trim()).map((n) => n.trim()) : [],
  };
}

/** A transform the sheet can actually serve: every column it names is a real
 *  header (exact match — the run's header check is exact too). */
export function readTransform(raw: unknown, headers: string[]): KpiTransform | string {
  if (!raw || typeof raw !== 'object') return 'no transform';
  const t = raw as Record<string, unknown>;
  const has = new Set(headers);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const dim = t.dimensionField == null || t.dimensionField === '' ? undefined : str(t.dimensionField);
  if (dim === null) return 'dimensionField is not a column name';
  if (dim !== undefined && !has.has(dim)) return `column "${dim}" is not in the sheet`;
  if (t.mode === 'long') {
    const valueField = str(t.valueField);
    const periodField = str(t.periodField);
    if (!valueField || !periodField) return 'long layout needs valueField and periodField';
    for (const f of [valueField, periodField]) if (!has.has(f)) return `column "${f}" is not in the sheet`;
    if (valueField === periodField || valueField === dim) return 'the value column is also used as period or dimension';
    return dim ? { mode: 'long', valueField, periodField, dimensionField: dim } : { mode: 'long', valueField, periodField };
  }
  if (t.mode === 'wide') {
    if (!Array.isArray(t.columns) || t.columns.length === 0) return 'wide layout needs a list of period columns';
    const columns: string[] = [];
    for (const c of t.columns) {
      if (typeof c !== 'string' || !has.has(c)) return `column "${String(c)}" is not in the sheet`;
      if (!columns.includes(c)) columns.push(c);
    }
    if (dim && columns.includes(dim)) return 'the dimension column is also listed as a period column';
    return dim
      ? { mode: 'wide', columns, periodFrom: 'header', dimensionField: dim }
      : { mode: 'wide', columns, periodFrom: 'header' };
  }
  if (t.mode === 'recipe') {
    // DEF-365: a computed KPI (count / sum / ratio per month), checked by the
    // framework's validateRecipe against the real headers (engine/kpiRecipe).
    const recipe = readKpiRecipe(t.recipe, headers);
    if (typeof recipe === 'string') return recipe;
    if (dim && [recipe.periodField, recipe.valueField, recipe.numeratorField, recipe.denominatorField].includes(dim)) {
      return 'the dimension column is also used by the recipe';
    }
    return dim ? { mode: 'recipe', recipe, dimensionField: dim } : { mode: 'recipe', recipe };
  }
  return 'transform.mode must be "long", "wide" or "recipe"';
}

/** sourceField of a row: the value column (wide: the first period column,
 *  for display — types.ts SuggestionDraft). */
export function sourceFieldOf(t: KpiTransform): string {
  if (t.mode === 'recipe') return transformValueColumns(t)[0] ?? t.recipe.periodField;
  return t.mode === 'long' ? t.valueField : t.columns[0];
}

const pairKey = (sourceField: string, targetKey: string) => `${sourceField.toLowerCase()}::${targetKey.toLowerCase()}`;
const clip = (s: string, n = PROMPT_CELL_CHARS) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── Prompt ────────────────────────────────────────────────────────────────

export const PROPOSER_SYSTEM_PROMPT = `You map the fields of a business data source (a Google Sheet or an API) for Nexeo, a business assistant.
You only PROPOSE: an administrator approves or rejects every row, and only approved rows are ever used.

Judge every field by its VALUES (the inventory shows fill rate, type and real samples from every record), never by its name alone.
Follow the administrator's words: the remarks, the filter words, the connect instructions and any additional instruction. When a row follows one of them, quote or name it in "followed".

Each row has a "kind":

1. "kpi" — a KPI number: one number per period (a day, a week or a month), optionally split by a dimension such as region.
   Two layouts are possible:
   - "long": one field holds the number and another holds the period. transform = {"mode":"long","valueField":"<field>","periodField":"<field>","dimensionField":"<field, optional>"}
   - "wide": one field per period, the period is the field NAME (e.g. "Jan 2026"). transform = {"mode":"wide","columns":["<field>", ...],"periodFrom":"header","dimensionField":"<field, optional>"}
   - "recipe": the number is COMPUTED from the records, per month: a count of records, a sum of one field, or a ratio of two fields' totals. transform = {"mode":"recipe","recipe":{"measure":"count"|"sum"|"ratio","periodField":"<field dating each record>","valueField":"<field, sum only>","numeratorField":"<field, ratio only>","denominatorField":"<field, ratio only>","scale":<ratio only, e.g. 100 for a percentage>,"label":"<plain words, e.g. New customers per month>"},"dimensionField":"<field, optional>"}
     Use a recipe only when the data holds no field that already IS the number, and only for a KPI kept per month. Code computes it from every record; only months that have ended are counted. Never use a recipe to count identity fields' values as a KPI of their own (e.g. a count of emails is fine as "records per month", but never a sum of ids or phone numbers).
   dimensionField, when given, splits the KPI by its value (one reading per value); omit it for a single total.
   Target keys: "kpi:<key>" for a KPI in the catalogue you are given (use ONLY catalogue keys), or "kpi:new:<key>" for a KPI not in it, with "newKpi": {"kpiKey":"<key>","label":"<short label>","unit":"<optional unit, e.g. PKR, %, count>"}. <key> is lowercase letters, digits and underscores, starting with a letter, at most 80 characters.
   One row per KPI; never two sources for the same KPI.
   A "long" or "wide" row COPIES a number already in the data. When the instruction asks for a count, total or ratio the data does not hold as a field, use a "recipe" row; NEVER force a "long" row onto unrelated fields (e.g. a salary as a value with a hire date as the period). If no field can date the records, a recipe cannot be built either: say so in a "not_used" row's "why".

2. "context" — knowledge the assistant should be able to read and quote (descriptions, statuses, names, notes, terms):
   - per record: {"kind":"context","targetKey":"context:per_record","transform":{"mode":"per_record","titleField":"<field naming the record>","bodyFields":["<field>", ...]}} — one knowledge page per record;
   - one table: {"kind":"context","targetKey":"context:table","transform":{"mode":"table","columns":["<field>", ...]}} — one page holding the chosen fields of every record (small reference lists).

3. "filter" — AT MOST ONE row, only when the administrator gave filter words: their words as conditions on REAL fields.
   {"kind":"filter","filter":{"match":"all" or "any","conditions":[{"field":"<field>","op":"<op>","value":"<text>"}]}}
   ops: equals, not_equals, contains, not_contains, greater_than, greater_or_equal, less_than, less_or_equal (numbers), after, before (dates, e.g. "2025-01-01"), is_blank, is_not_blank (no value).
   If part of the filter words cannot be expressed on the fields you see, leave that part out and say so in "notices".

4. "not_used" — a field you deliberately do not use: {"kind":"not_used","field":"<field>","why":"<reason>"}.

Rules:
- Do NOT propose anything listed as ALREADY APPROVED (and no other source for those KPIs, and no second filter if one is approved).
- Do NOT propose a pair listed as ALREADY REJECTED unless the administrator's instruction asks for it.
- Never map identity fields (names, emails, phone numbers, ids) as KPIs; they may title a Context page.
- Use ONLY field names exactly as they appear in the inventory.
- If something the administrator asked for cannot be done from this data, say so in "notices" in plain words.

Answer with ONE JSON object and nothing else, in exactly this shape, with "complete": true as the LAST key:
{"summary":"<two sentences for the administrator>","rows":[{"kind":"kpi","targetKey":"kpi:...","newKpi":{...} or omitted,"transform":{...},"why":"<one sentence>","followed":"<the remark or instruction it followed, or omitted>"}],"notices":["..."],"complete":true}`;

export interface PromptInputs {
  integration: { name: string; purpose: string | null; adminBrief: string | null };
  sourceLabel: string;
  adminPrompt?: string;
  coverage: FieldCoverage[];
  sampleRows: Record<string, string>[];
  catalogue: Array<{ kpiKey: string; label: string; unit: string | null; grain?: string }>;
  approved: Array<{ sourceField: string; targetKey: string; transform: unknown }>;
  approvedFromVersion: number | null;
  rejected: Array<{ sourceField: string; targetKey: string }>;
  rowCount: number;
  // DEF-362 (all optional, so a Stage 1 sheet prompt is unchanged).
  /** The AI's reading of the API document (summary + what it did not say). */
  docReading?: { summary: string; gaps: string[] } | null;
  filterInstructions?: string | null;
  connectInstructions?: string | null;
  /** Deterministic notes per field (id field, constant, never filled…). */
  fieldNotes?: string[];
  /** 'API' or 'sheet' — wording only. */
  sourceNoun?: string;
}

const PROMPT_DOC_SUMMARY_CHARS = 3000;
const PROMPT_DOC_GAPS = 15;

/** The user message: one labelled block per input, in the spec §2b order. Pure. */
export function buildProposerUserMessage(p: PromptInputs): string {
  const blocks: string[] = [];
  const noun = p.sourceNoun ?? 'sheet';
  blocks.push(`INTEGRATION: ${p.integration.name}\nSOURCE: ${p.sourceLabel} (${p.rowCount} data ${noun === 'API' ? 'records' : 'rows'})`);
  if (p.integration.purpose?.trim()) blocks.push(`WHY IT IS BEING CONNECTED:\n${p.integration.purpose.trim()}`);
  // Spec §2b order: document reading → remarks → filter words → connect
  // instructions → inventory → per-field notes → catalogue → approved → rejected.
  if (p.docReading && (p.docReading.summary.trim() || p.docReading.gaps.length)) {
    const gaps = p.docReading.gaps.slice(0, PROMPT_DOC_GAPS);
    blocks.push(`WHAT THE API DOCUMENT SAYS (an earlier AI reading of it):\n${clip(p.docReading.summary.trim(), PROMPT_DOC_SUMMARY_CHARS)}${
      gaps.length ? `\nWhat the document did not say:\n${gaps.map((g) => `- ${g}`).join('\n')}` : ''}`);
  }
  if (p.integration.adminBrief?.trim()) blocks.push(`ADMINISTRATOR'S BRIEF:\n${p.integration.adminBrief.trim()}`);
  if (p.filterInstructions?.trim()) {
    blocks.push(`FILTER WORDS (turn these into the ONE "filter" row, on real fields only):\n${p.filterInstructions.trim()}`);
  }
  if (p.connectInstructions?.trim()) {
    blocks.push(`HOW THE ADMINISTRATOR WANTS THIS DATA MAPPED (said after seeing one record):\n${p.connectInstructions.trim()}`);
  }
  if (p.adminPrompt?.trim()) blocks.push(`ADDITIONAL INSTRUCTION (takes priority over everything above):\n${p.adminPrompt.trim()}`);

  blocks.push(`FIELD INVENTORY (computed from all ${p.rowCount} ${noun === 'API' ? 'records' : 'rows'}, in ${noun} order):\n${p.coverage.map((c) => {
    const parts = [`- "${c.field}": ${c.inferredType}, filled ${c.filled}/${c.total}`];
    if (c.samples.length) parts.push(`samples ${JSON.stringify(c.samples)}`);
    if (c.distinct && c.distinct.length) parts.push(`all values ${JSON.stringify(c.distinct)}`);
    return parts.join('; ');
  }).join('\n')}`);

  if (p.sampleRows.length) {
    blocks.push(`FIRST ${p.sampleRows.length} ROWS (layout only — the inventory is the evidence):\n${p.sampleRows
      .map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clip(String(v ?? ''))]))))
      .join('\n')}`);
  }

  if (p.fieldNotes?.length) blocks.push(`FIELD NOTES:\n${p.fieldNotes.map((n) => `- ${n}`).join('\n')}`);

  blocks.push(p.catalogue.length
    ? `KPI CATALOGUE (active; use "kpi:<key>"):\n${p.catalogue.map((k) =>
      `- ${k.kpiKey}: ${k.label}${k.unit ? ` (${k.unit})` : ''}${k.grain ? `, per ${k.grain}` : ''}`).join('\n')}`
    : 'KPI CATALOGUE: empty — propose new KPIs with "kpi:new:<key>" and "newKpi".');

  if (p.approved.length) {
    blocks.push(`ALREADY APPROVED${p.approvedFromVersion != null ? ` (v${p.approvedFromVersion})` : ''} — kept as they are; do NOT propose these, or another source for the same KPI:\n${p.approved
      .map((a) => `- ${a.targetKey} ← ${a.transform ? JSON.stringify(a.transform) : `"${a.sourceField}"`}`).join('\n')}`);
  }
  if (p.rejected.length) {
    blocks.push(`ALREADY REJECTED by the administrator — do NOT propose again unless the instruction asks:\n${p.rejected
      .map((r) => `- "${r.sourceField}" → ${r.targetKey}`).join('\n')}`);
  }
  return blocks.join('\n\n');
}

/** Most per-field notes in the prompt (a wide API record can have hundreds of fields). */
export const MAX_FIELD_NOTES = 60;

/**
 * DEF-362 per-field notes: facts about a field the inventory line does not
 * say outright, computed from ALL records (pure). The model is told which
 * field identifies a record (so it titles/keys Context with it and never
 * makes it a KPI), which never vary, and which are never filled.
 */
export function buildFieldNotes(coverage: FieldCoverage[], idField: string | null): string[] {
  const notes: string[] = [];
  for (const c of coverage) {
    if (notes.length >= MAX_FIELD_NOTES) break;
    if (idField && c.field === idField) {
      notes.push(`"${c.field}" identifies a record (the connection's id field): use it to key or title Context, never as a KPI.`);
      continue;
    }
    if (c.total > 0 && c.filled === 0) {
      notes.push(`"${c.field}" is never filled in the ${c.total} records read.`);
      continue;
    }
    if (c.total > 1 && c.filled === c.total && c.distinct && c.distinct.length === 1) {
      notes.push(`"${c.field}" has the same value ("${clip(c.distinct[0])}") in every record.`);
      continue;
    }
    if (c.field.includes('.')) {
      notes.push(`"${c.field}" is nested in the API answer (under "${c.field.slice(0, c.field.lastIndexOf('.'))}").`);
    }
  }
  return notes;
}

/** vm mappingCallBudget, re-based for Nexeo's router where thinking is ADDED to
 *  maxTokens rather than taken from it (notes §1.3 gap 5). */
export function proposerBudget(fieldCount: number): { maxTokens: number; thinkingBudget: number } {
  return { maxTokens: Math.min(PROPOSER_MAX_TOKENS, 8_192 + fieldCount * 60), thinkingBudget: 4_096 };
}

/** The router passes one maxTokens to every provider. The Claude fallback is a
 *  NON-streaming messages.create, which @anthropic-ai/sdk refuses before
 *  sending when 3600·max_tokens/128000 > 600 s (max_tokens > 21 333) — so a
 *  budget above that made the fallback for wide sheets impossible. */
export const PROPOSER_MAX_TOKENS = 21_000;

// ── Validation of the answer against the sheet and the catalogue ──────────

interface DefRef { kpiKey: string; label: string; unit: string | null; isActive: boolean; sourceIntegrationId: string | null; grain?: string | null }

export interface CarriedRow {
  id: string;
  /** Absent ⇒ 'kpi' (Stage 1 rows). */
  targetKind?: string | null;
  sourceField: string;
  targetKey: string;
  transform: unknown;
  coverage: unknown;
  samples: unknown;
  newKpi: unknown;
  reason: string | null;
  followed?: string | null;
  decidedBy: number | null;
  decidedAt: Date | null;
}

/** One suggestion row ready to insert (minus the ids the transaction adds). */
export interface PlannedSuggestion {
  targetKind: TargetKind;
  sourceField: string;
  targetKey: string;
  transform: KpiTransform | ContextTransform | RecordFilter | null;
  coverage: FieldCoverage | null;
  samples: string[];
  newKpi: { kpiKey: string; label: string; unit?: string } | null;
  status: 'PENDING' | 'APPROVED' | 'SET_ASIDE';
  reason: string;
  /** DEF-362: the remark / filter words / instruction this row followed. */
  followed: string | null;
  carriedFromId: string | null;
  decidedBy: number | null;
  decidedAt: Date | null;
}

/** A field the model deliberately left out, with why (spec §2b "Not used"). */
export interface NotUsedField {
  field: string;
  reason: string;
}

export interface ValidateInputs {
  integrationId: string;
  answer: ParsedAnswer;
  read: Pick<ReadResult, 'records' | 'headers'>;
  coverage: FieldCoverage[];
  /** EVERY definition of the tenant (active and inactive) — inactive keys are
   *  refused, and a "new" key that already exists is not new. */
  defs: DefRef[];
  carried: CarriedRow[];
  rejected: Array<{ sourceField: string; targetKey: string }>;
  /** The admin gave an instruction this time: it may override a rejection. */
  hasAdminPrompt: boolean;
  // DEF-362 (optional so Stage 1 callers are unchanged).
  /** apiConfig.idField — the Context page key. A per-record row on records
   *  that lack it would produce no page at all. */
  idField?: string | null;
  /** The admin gave filter words (or an instruction): a filter row may exist. */
  hasFilterWords?: boolean;
  /** integrations.max_context_pages. */
  maxContextPages?: number;
}

/** Longest `followed` kept (it is a quote or a name, not an essay). */
export const FOLLOWED_MAX_CHARS = 300;
/** Context transforms: most fields one row may name. */
export const MAX_CONTEXT_FIELDS = 40;

function followedOf(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? clip(raw.trim(), FOLLOWED_MAX_CHARS) : null;
}

/** The kind of a model row; absent ⇒ 'kpi' so a Stage 1-shaped answer still maps. */
function kindOfRow(raw: RawRow): string {
  if (typeof raw.kind === 'string' && raw.kind.trim()) return raw.kind.trim().toLowerCase();
  const key = typeof raw.targetKey === 'string' ? raw.targetKey.trim() : '';
  if (key.startsWith('context:')) return 'context';
  if (key === FILTER_TARGET_KEY) return 'filter';
  return 'kpi';
}

/**
 * A Context transform the data can actually serve: every field it names is a
 * real field (exact match — the run's header check is exact too). Returns the
 * transform with its target key, or the problem in words.
 */
export function readContextProposal(raw: RawRow, headers: string[]):
  { targetKey: ContextTargetKey; transform: ContextTransform } | string {
  const has = new Set(headers);
  const t = (raw.transform && typeof raw.transform === 'object' ? raw.transform : raw) as Record<string, unknown>;
  const key = typeof raw.targetKey === 'string' ? raw.targetKey.trim() : '';
  const mode = t.mode ?? (key === 'context:table' ? 'table' : key === 'context:per_record' ? 'per_record' : undefined);
  if (key && key !== `context:${String(mode)}`) return `target "${key}" does not match layout "${String(mode)}"`;
  const fieldList = (v: unknown, what: string): string[] | string => {
    if (!Array.isArray(v) || v.length === 0) return `needs a list of ${what}`;
    const out: string[] = [];
    for (const f of v) {
      if (typeof f !== 'string' || !has.has(f)) return `field "${String(f)}" is not in the data`;
      if (!out.includes(f)) out.push(f);
    }
    if (out.length > MAX_CONTEXT_FIELDS) return `names ${out.length} fields; at most ${MAX_CONTEXT_FIELDS}`;
    return out;
  };
  if (mode === 'per_record') {
    const titleField = typeof t.titleField === 'string' ? t.titleField : '';
    if (!titleField) return 'a per-record page needs a title field';
    if (!has.has(titleField)) return `field "${titleField}" is not in the data`;
    const body = fieldList(t.bodyFields, 'body fields');
    if (typeof body === 'string') return body;
    return { targetKey: 'context:per_record', transform: { mode: 'per_record', titleField, bodyFields: body } };
  }
  if (mode === 'table') {
    const columns = fieldList(t.columns, 'columns');
    if (typeof columns === 'string') return columns;
    return { targetKey: 'context:table', transform: { mode: 'table', columns } };
  }
  return 'a Context row is "per_record" or "table"';
}

/** Every field a stored transform reads, whatever its kind (header check of
 *  carried rows). Unknown shapes read nothing. */
export function fieldsOfTransform(kind: string, t: unknown): string[] {
  if (!t || typeof t !== 'object') return [];
  const o = t as Record<string, unknown>;
  if (kind === 'context') {
    if (o.mode === 'per_record') return [String(o.titleField ?? ''), ...(Array.isArray(o.bodyFields) ? o.bodyFields.map(String) : [])].filter(Boolean);
    if (o.mode === 'table') return Array.isArray(o.columns) ? o.columns.map(String) : [];
    return [];
  }
  if (kind === 'filter') {
    return Array.isArray(o.conditions)
      ? [...new Set(o.conditions.map((c) => String((c as Record<string, unknown>)?.field ?? '')).filter(Boolean))]
      : [];
  }
  if (o.mode === 'recipe') {
    const r = readKpiRecipe(o.recipe);
    return typeof r === 'string' ? [] : transformFields({ mode: 'recipe', recipe: r, ...(typeof o.dimensionField === 'string' && o.dimensionField ? { dimensionField: o.dimensionField } : {}) });
  }
  return o.mode === 'long' || o.mode === 'wide' ? transformFields(o as unknown as KpiTransform) : [];
}

/** Turn the model's rows into suggestion rows. Pure; every refusal leaves a
 *  notice, never a silent drop the admin cannot see. */
export function validateProposal(v: ValidateInputs): { rows: PlannedSuggestion[]; notices: string[]; notUsed: NotUsedField[] } {
  const notices: string[] = [];
  const notUsed: NotUsedField[] = [];
  const rows: PlannedSuggestion[] = [];
  const byKey = new Map(v.defs.map((d) => [d.kpiKey, d]));
  const covOf = new Map(v.coverage.map((c) => [c.field, c]));
  const rejected = new Set(v.rejected.map((r) => pairKey(r.sourceField, r.targetKey)));
  const total = v.read.records.length;

  // Carried rows first, unchanged: they are the approved state (vm §9) —
  // KPI, Context and the filter alike.
  const fed = new Map<string, string>(); // kpiKey → what feeds it in this version
  const carriedPairs = new Set<string>();
  let filterTaken: string | null = null; // DEF-362: at most ONE filter row per version
  for (const c of v.carried) {
    const kind = (c.targetKind ?? 'kpi') as TargetKind;
    rows.push({
      targetKind: kind,
      sourceField: c.sourceField,
      targetKey: c.targetKey,
      transform: (c.transform as PlannedSuggestion['transform']) ?? null,
      coverage: (c.coverage as FieldCoverage | null) ?? null,
      samples: Array.isArray(c.samples) ? (c.samples as unknown[]).map(String) : [],
      newKpi: (c.newKpi as PlannedSuggestion['newKpi']) ?? null,
      status: 'APPROVED',
      reason: c.reason ?? '',
      followed: c.followed ?? null,
      carriedFromId: c.id,
      decidedBy: c.decidedBy,
      decidedAt: c.decidedAt,
    });
    if (kind === 'kpi') fed.set(kpiKeyOf(c.targetKey), `the approved row from "${c.sourceField}"`);
    if (kind === 'filter') filterTaken = 'the approved filter';
    carriedPairs.add(pairKey(c.sourceField, c.targetKey));
    // The approved row stays approved; the admin must still learn the data
    // moved under it, because the run's header check will fail it.
    const missing = fieldsOfTransform(kind, c.transform).filter((f) => !v.read.headers.includes(f));
    if (missing.length) {
      notices.push(`The approved mapping for ${c.targetKey} reads ${missing.map((m) => `"${m}"`).join(', ')}, which the ${v.idField !== undefined ? 'data' : 'sheet'} no longer has — runs will fail until it is withdrawn or the column is restored.`);
    }
  }

  /** Rejected earlier ⇒ dropped unless this instruction reopens it. */
  const settled = (sourceField: string, keys: string[], label: string): 'drop' | 'reopened' | 'open' => {
    if (!keys.some((k) => rejected.has(pairKey(sourceField, k)))) return 'open';
    if (!v.hasAdminPrompt) {
      notices.push(`Not proposed again: "${sourceField}" → ${label} was rejected earlier.`);
      return 'drop';
    }
    return 'reopened';
  };
  const REOPENED = 'Rejected earlier; proposed again because of your instruction. ';

  for (const raw of v.answer.rows) {
    const kind = kindOfRow(raw);
    const followed = followedOf(raw.followed);
    const why = typeof raw.why === 'string' && raw.why.trim() ? ` AI: ${raw.why.trim()}` : '';

    // ── Not used: a notice, never an approvable row (see header) ──
    if (kind === 'not_used') {
      const field = typeof raw.field === 'string' ? raw.field.trim() : '';
      if (!field || !v.read.headers.includes(field)) continue;
      const reason = typeof raw.why === 'string' && raw.why.trim() ? clip(raw.why.trim(), 300) : 'no reason given';
      notUsed.push({ field, reason });
      notices.push(`Not used: "${field}" — ${reason}${followed ? ` (followed: ${followed})` : ''}`);
      continue;
    }

    // ── Context (DEF-362) ──
    if (kind === 'context') {
      const c = readContextProposal(raw, v.read.headers);
      if (typeof c === 'string') {
        notices.push(`Dropped a Context proposal: ${c}.`);
        continue;
      }
      const t = c.transform;
      const sourceField = t.mode === 'per_record' ? t.titleField : t.columns[0];
      if (carriedPairs.has(pairKey(sourceField, c.targetKey))) continue;
      if (rows.some((r) => r.targetKind === 'context' && r.carriedFromId === null
          && JSON.stringify(r.transform) === JSON.stringify(t))) continue; // the model repeated itself
      const s = settled(sourceField, [c.targetKey], c.targetKey);
      if (s === 'drop') continue;
      const coverage = covOf.get(sourceField) ?? null;
      const base = {
        targetKind: 'context' as const, sourceField, targetKey: c.targetKey, transform: t, coverage,
        samples: (coverage?.samples ?? []).slice(0, 3), newKpi: null, followed,
        carriedFromId: null, decidedBy: null, decidedAt: null,
      };
      const prefix = s === 'reopened' ? REOPENED : '';
      if (t.mode === 'per_record') {
        // Arithmetic beats the model's word: count what would become a page.
        const titled = v.read.records.filter((r) => String(r[t.titleField] ?? '').trim() !== '').length;
        const idField = v.idField ?? null;
        const keyed = idField ? v.read.records.filter((r) => String(r[idField] ?? '').trim() !== '').length : titled;
        if (titled === 0) {
          rows.push({ ...base, status: 'SET_ASIDE', reason: `${prefix}Set aside: the title field "${t.titleField}" is blank in all ${total} records, so no page could be named.${why}` });
          continue;
        }
        if (idField && keyed === 0) {
          rows.push({ ...base, status: 'SET_ASIDE', reason: `${prefix}Set aside: the id field "${idField}" is blank or missing in all ${total} records, so no page could be kept up to date.${why}` });
          continue;
        }
        const pages = Math.min(titled, keyed);
        const cap = v.maxContextPages ?? Infinity;
        const capNote = pages > cap ? ` Only the first ${cap} would be written (limit integrations.max_context_pages) — narrow the filter or use one table page.` : '';
        rows.push({
          ...base, status: 'PENDING',
          reason: `${prefix}Context: about ${Math.min(pages, cap)} knowledge page(s), one per record titled by "${t.titleField}" (${titled} of ${total} records have a title), with ${t.bodyFields.length} field(s) each.${capNote}${why}`,
        });
      } else {
        const filled = t.columns.filter((f) => (covOf.get(f)?.filled ?? 0) > 0).length;
        if (filled === 0) {
          rows.push({ ...base, status: 'SET_ASIDE', reason: `${prefix}Set aside: none of the ${t.columns.length} chosen columns is filled in any of the ${total} records.${why}` });
          continue;
        }
        rows.push({
          ...base, status: 'PENDING',
          reason: `${prefix}Context: one knowledge page holding ${t.columns.length} column(s) of all ${total} records.${why}`,
        });
      }
      continue;
    }

    // ── The filter (DEF-362): at most one, only from the admin's words ──
    if (kind === 'filter') {
      if (!v.hasFilterWords) {
        notices.push('Dropped a proposed filter: you gave no filter words, and nothing is filtered unless you ask for it.');
        continue;
      }
      if (filterTaken) {
        notices.push(`Dropped a second filter: ${filterTaken} already decides which records are used.`);
        continue;
      }
      let filter: RecordFilter;
      try {
        // Validated against the REAL fields: a condition on a field the data
        // does not have would fail every run (an unconfigured target).
        filter = validateRecordFilter(raw.filter ?? raw.transform, v.read.headers);
      } catch (err) {
        notices.push(`Dropped the proposed filter: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const sourceField = filter.conditions[0].field;
      if (carriedPairs.has(pairKey(sourceField, FILTER_TARGET_KEY))) continue;
      const s = settled(sourceField, [FILTER_TARGET_KEY], 'the filter');
      if (s === 'drop') continue;
      filterTaken = 'the filter proposed above';
      const outcome = applyRecordFilter(v.read.records, filter);
      const coverage = covOf.get(sourceField) ?? null;
      const base = {
        targetKind: 'filter' as const, sourceField, targetKey: FILTER_TARGET_KEY, transform: filter, coverage,
        samples: (coverage?.samples ?? []).slice(0, 3), newKpi: null, followed,
        carriedFromId: null, decidedBy: null, decidedAt: null,
      };
      const prefix = s === 'reopened' ? REOPENED : '';
      if (outcome.kept.length === 0) {
        rows.push({ ...base, status: 'SET_ASIDE', reason: `${prefix}Set aside: this filter keeps 0 of the ${total} records read — every record would be filtered out.${why}` });
        continue;
      }
      rows.push({
        ...base, status: 'PENDING',
        reason: `${prefix}Filter: keeps ${outcome.kept.length} of the ${total} records read (${outcome.filteredOut} filtered out). Nothing is filtered until you approve it.${why}`,
      });
      continue;
    }

    if (kind !== 'kpi') {
      notices.push(`Dropped a row of unknown kind "${clip(kind, 30)}".`);
      continue;
    }

    // ── KPI (Stage 1, unchanged) ──
    const rawKey = typeof raw.targetKey === 'string' ? raw.targetKey.trim() : '';
    const t = readTransform(raw.transform, v.read.headers);
    if (typeof t === 'string') {
      notices.push(`Dropped a proposal for ${rawKey || 'an unnamed KPI'}: ${t}.`);
      continue;
    }
    const sourceField = sourceFieldOf(t);

    // Resolve the target: catalogue key, or a properly declared new KPI.
    let targetKey: KpiTargetKey;
    let newKpi: PlannedSuggestion['newKpi'] = null;
    let label: string;
    const nk = readNewKpi(raw.newKpi);
    const m = /^kpi:(?:new:)?(.+)$/.exec(rawKey);
    const key = m ? m[1] : '';
    const def = byKey.get(key);
    if (def) {
      // A "new" KPI that already exists is the existing one — never a duplicate definition.
      if (!def.isActive) {
        notices.push(`Dropped ${rawKey}: the KPI "${def.label}" is switched off in the catalogue.`);
        continue;
      }
      targetKey = `kpi:${key}`;
      label = `${def.label} (kpi:${key})`;
    } else if (m && nk && nk.kpiKey === key && KPI_KEY_RE.test(key)) {
      // Outside the catalogue is allowed ONLY as a declared new KPI.
      targetKey = `kpi:new:${key}`;
      newKpi = nk;
      label = `new KPI "${nk.label}" (kpi:${key})`;
    } else {
      notices.push(`Dropped ${rawKey || 'a row with no target'}: not a KPI in the catalogue${m ? ' and not proposed as a valid new KPI' : ''}.`);
      continue;
    }

    const kpiKey = kpiKeyOf(targetKey);
    const pair = pairKey(sourceField, targetKey);
    if (carriedPairs.has(pair)) continue; // already approved and carried — nothing new

    // Settled by the admin earlier: dropped unless this instruction reopens it.
    // Both spellings: a `kpi:new:` row rejected before approval keeps that
    // spelling, while the same KPI may be in the catalogue by now.
    const s = settled(sourceField, [`kpi:${kpiKey}`, `kpi:new:${kpiKey}`], kpiKey);
    if (s === 'drop') continue;
    const reopened = s === 'reopened';

    const coverage = covOf.get(sourceField) ?? null;
    const samples = samplesOf(t, covOf);
    const base = { targetKind: 'kpi' as const, sourceField, targetKey, transform: t, coverage, samples, newKpi, followed, carriedFromId: null, decidedBy: null, decidedAt: null };

    // One field, one owner — across integrations (vm §9) …
    if (def && def.sourceIntegrationId && def.sourceIntegrationId !== v.integrationId) {
      rows.push({ ...base, status: 'SET_ASIDE', reason: `Set aside: ${label} is already fed by another integration. Free it there first.${why}` });
      continue;
    }
    // … and within this version: a second source is set aside, never merged.
    const feeder = fed.get(kpiKey);
    if (feeder) {
      rows.push({ ...base, status: 'SET_ASIDE', reason: `Set aside: ${label} is already fed by ${feeder}. Withdraw that approval first.${why}` });
      continue;
    }

    const risk = assessKpiRowRisk(v.read.records, t, label, undefined, def?.grain ?? 'month');
    if (!risk.setAside) fed.set(kpiKey, `"${sourceField}" in this proposal`);
    rows.push({
      ...base,
      status: risk.setAside ? 'SET_ASIDE' : 'PENDING',
      reason: `${reopened ? REOPENED : ''}${risk.reason}${why}`,
    });
  }
  return { rows, notices, notUsed };
}

function kpiKeyOf(targetKey: string): string {
  return targetKey.replace(/^kpi:(?:new:)?/, '');
}

function readNewKpi(raw: unknown): { kpiKey: string; label: string; unit?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  const kpiKey = typeof n.kpiKey === 'string' ? n.kpiKey.trim() : '';
  const label = typeof n.label === 'string' ? n.label.trim().slice(0, 200) : '';
  if (!KPI_KEY_RE.test(kpiKey) || !label) return null;
  const unit = typeof n.unit === 'string' && n.unit.trim() ? n.unit.trim().slice(0, 20) : undefined;
  return unit ? { kpiKey, label, unit } : { kpiKey, label };
}

/** 2–3 real values the row reads (wide: gathered across its period columns). */
function samplesOf(t: KpiTransform, covOf: Map<string, FieldCoverage>): string[] {
  const cols = t.mode === 'recipe' ? (transformValueColumns(t).length ? transformValueColumns(t) : [t.recipe.periodField])
    : t.mode === 'long' ? [t.valueField] : t.columns;
  const out: string[] = [];
  for (const c of cols) {
    for (const s of covOf.get(c)?.samples ?? []) {
      if (out.length >= 3) return out;
      if (!out.includes(s)) out.push(s);
    }
  }
  return out;
}

// ── proposeMapping ────────────────────────────────────────────────────────

/**
 * proposeMapping with a progress callback (proposalJobs passes one for the
 * overlay). The contract function below is this without the callback.
 */
export async function runProposal(
  cn: string,
  integrationId: string,
  opts: ProposeOptions,
  onStage: ProposalStageFn = () => {},
): Promise<ProposeResult> {
  const integ = await prisma.integrationSync.findFirst({
    where: { id: integrationId, clientNumber: cn },
    select: {
      id: true, name: true, purpose: true, adminBrief: true, sourceKind: true, sourceConfig: true, apiConfig: true,
      // DEF-362: the admin's words and the document reading feed the prompt.
      filterInstructions: true, connectInstructions: true, apiDocReading: true,
    },
  });
  if (!integ) throw new IntegrationNotFoundError(integrationId);
  // DEF-362: gsheet | api through the source router.
  const problem = sourceProblem(integ);
  if (problem) {
    throw new IntegrationInputError(
      integ.sourceKind !== 'api' && integ.sourceKind !== 'file' ? 'Connect a Google Sheet before asking for a mapping.' : problem.message, problem.field);
  }

  const isApi = integ.sourceKind === 'api';
  onStage(isApi ? 'Reading the API' : 'Reading the sheet');
  const read = await readSource(cn, integ);
  if (read.records.length === 0) {
    throw new ProposalError(isApi
      ? 'The API returned no records, so there is nothing to map.'
      : 'The sheet has no data rows, so there is nothing to map.');
  }

  onStage(`Taking stock of ${read.headers.length} ${isApi ? 'fields' : 'columns'} across ${read.rowCount} ${isApi ? 'records' : 'rows'}`);
  const coverage = buildFieldCoverage(read.records, read.headers);
  const idField = isApi ? idFieldOf(integ.apiConfig) : null;
  const maxContextPages = await getBehaviorValue('integrations.max_context_pages', { clientNumber: cn })
    .then((n) => (typeof n === 'number' && n > 0 ? n : DEFAULT_MAX_CONTEXT_PAGES))
    .catch(() => DEFAULT_MAX_CONTEXT_PAGES);
  const filterWords = integ.filterInstructions?.trim() || null;

  const [defs, versions, rejectedRows] = await Promise.all([
    prisma.kpiDefinition.findMany({
      where: { clientNumber: cn },
      select: { kpiKey: true, label: true, unit: true, grain: true, isActive: true, sourceIntegrationId: true },
      orderBy: { kpiKey: 'asc' },
    }),
    prisma.integrationMappingVersion.findMany({
      where: { clientNumber: cn, integrationId },
      select: { id: true, version: true },
      orderBy: { version: 'desc' },
      take: 1,
    }),
    // Rejections are settled across EVERY version, not just the last one.
    prisma.integrationSuggestion.findMany({
      where: { clientNumber: cn, integrationId, status: 'REJECTED' },
      select: { sourceField: true, targetKey: true },
      distinct: ['sourceField', 'targetKey'],
    }),
  ]);
  const previous = versions[0] ?? null;
  // The previous version carries the approved state forward by construction
  // (each version carries its predecessor's approved rows), so its APPROVED
  // rows are exactly "what is approved now", including withdrawals made on it.
  const carried: CarriedRow[] = previous
    ? await prisma.integrationSuggestion.findMany({
      where: { clientNumber: cn, integrationId, mappingVersionId: previous.id, status: 'APPROVED' },
      select: {
        id: true, targetKind: true, sourceField: true, targetKey: true, transform: true, coverage: true, samples: true,
        newKpi: true, reason: true, followed: true, decidedBy: true, decidedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    })
    : [];
  const rejected = rejectedRows.map((r) => ({ sourceField: r.sourceField, targetKey: r.targetKey }));

  const userMessage = buildProposerUserMessage({
    integration: { name: integ.name, purpose: integ.purpose, adminBrief: integ.adminBrief },
    sourceLabel: read.sourceLabel,
    adminPrompt: opts.prompt,
    coverage,
    sampleRows: read.records.slice(0, PROMPT_SAMPLE_ROWS),
    catalogue: defs.filter((d) => d.isActive).map((d) => ({ kpiKey: d.kpiKey, label: d.label, unit: d.unit, grain: d.grain })),
    approved: carried.map((c) => ({ sourceField: c.sourceField, targetKey: c.targetKey, transform: c.transform ?? null })),
    approvedFromVersion: carried.length && previous ? previous.version : null,
    rejected,
    rowCount: read.rowCount,
    docReading: isApi ? docReadingOf(integ.apiDocReading) : null,
    filterInstructions: filterWords,
    connectInstructions: integ.connectInstructions,
    fieldNotes: buildFieldNotes(coverage, idField),
    sourceNoun: isApi ? 'API' : 'sheet',
  });

  onStage(`Asking the AI what each ${isApi ? 'field' : 'column'} means`);
  const budget = proposerBudget(coverage.length);
  const reply = await callLLM(PROPOSER_SYSTEM_PROMPT, userMessage, {
    purpose: PROPOSER_PURPOSE,
    clientNumber: cn,
    userId: opts.actorId,
    timeoutMs: PROPOSER_TIMEOUT_MS,
    providers: [...PROPOSER_PROVIDERS],
    ...budget,
  });

  onStage(`Checking the proposal against the ${isApi ? 'data' : 'sheet'}`);
  const answer = parseProposerAnswer(reply.text);
  const { rows, notices: checkNotices, notUsed } = validateProposal({
    integrationId, answer, read, coverage, defs, carried, rejected, hasAdminPrompt: !!opts.prompt?.trim(),
    idField, maxContextPages,
    // A filter row exists only when the admin asked for filtering (spec §2b:
    // "turns the filter words into a proposed structured filter").
    hasFilterWords: !!filterWords || !!opts.prompt?.trim(),
  });

  const notices = [...answer.notices, ...checkNotices];
  if (filterWords && !rows.some((r) => r.targetKind === 'filter')) {
    notices.push(`Your filter words ("${clip(filterWords, 120)}") did not become a filter, so every record is used. Reword them using the field names, or ask again.`);
  }
  if (read.truncated) {
    notices.unshift(`Only the first ${read.rowCount} rows were read${read.truncatedReason ? ` (${read.truncatedReason})` : ''}; the mapping is judged on those.`);
  }
  for (const a of read.anomalies) notices.push(a);
  const summary = answer.summary || (rows.length ? 'Mapping proposed.' : `Nothing could be mapped from this ${isApi ? 'API' : 'sheet'}.`);

  onStage('Saving the proposal');
  // ONE transaction: the version and every one of its rows, or nothing (vm
  // createMappingVersionWithRows). The number is taken inside it; the unique
  // (integration_id, version) index refuses a concurrent duplicate.
  const saved = await prisma.$transaction(async (tx) => {
    const last = await tx.integrationMappingVersion.findFirst({
      where: { clientNumber: cn, integrationId },
      select: { version: true },
      orderBy: { version: 'desc' },
    });
    const version = (last?.version ?? 0) + 1;
    const created = await tx.integrationMappingVersion.create({
      data: {
        clientNumber: cn,
        integrationId,
        version,
        status: 'DRAFT',
        spec: JSON.parse(JSON.stringify({ coverage, provider: reply.provider, notices, notUsed })),
        adminPrompt: opts.prompt?.trim() || null,
        aiSummary: summary,
        createdBy: opts.actorId,
      },
      select: { id: true, version: true },
    });
    // Every older DRAFT is replaced by this one (frozen: no approve, no turn-on).
    // Otherwise an admin could approve/activate a stale draft whose approvals
    // the NEXT proposal — which carries from the latest version — never sees.
    await tx.integrationMappingVersion.updateMany({
      where: { clientNumber: cn, integrationId, status: 'DRAFT', id: { not: created.id } },
      data: { status: 'SUPERSEDED' },
    });
    if (rows.length) {
      await tx.integrationSuggestion.createMany({
        data: rows.map((r) => ({
          clientNumber: cn,
          integrationId,
          mappingVersionId: created.id,
          targetKind: r.targetKind,
          sourceField: r.sourceField.slice(0, 255),
          targetKey: r.targetKey,
          transform: r.transform ? JSON.parse(JSON.stringify(r.transform)) : undefined,
          coverage: r.coverage ? JSON.parse(JSON.stringify(r.coverage)) : undefined,
          samples: r.samples,
          newKpi: r.newKpi ? JSON.parse(JSON.stringify(r.newKpi)) : undefined,
          status: r.status,
          reason: r.reason,
          followed: r.followed,
          carriedFromId: r.carriedFromId,
          decidedBy: r.decidedBy,
          decidedAt: r.decidedAt,
        })),
      });
    }
    return created;
  });

  const counts = {
    pending: rows.filter((r) => r.status === 'PENDING').length,
    approvedCarried: rows.filter((r) => r.status === 'APPROVED').length,
    // Derived from the rows, never a separate counter (vm declared one and
    // never incremented it — notes §2.6).
    setAside: rows.filter((r) => r.status === 'SET_ASIDE').length,
  };
  log.info('mapping proposed', { clientNumber: cn, integrationId, version: saved.version, provider: reply.provider, ...counts, notices: notices.length });
  return {
    mappingVersion: saved.version,
    versionId: saved.id,
    summary,
    provider: reply.provider,
    counts,
    notices,
  };
}

/** Fallback when behavior integrations.max_context_pages cannot be read. */
const DEFAULT_MAX_CONTEXT_PAGES = 500;

function idFieldOf(apiConfig: unknown): string | null {
  const v = (apiConfig as Record<string, unknown> | null)?.idField;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The stored ApiDocReading's summary and gaps, or null. The text was redacted
 *  by the document reader before it was stored. */
function docReadingOf(raw: unknown): { summary: string; gaps: string[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const summary = typeof r.summary === 'string' ? r.summary : '';
  const gaps = Array.isArray(r.gaps) ? r.gaps.filter((g): g is string => typeof g === 'string') : [];
  return summary || gaps.length ? { summary, gaps } : null;
}

export const proposeMapping: AiProposerModule['proposeMapping'] = (cn, integrationId, opts) =>
  runProposal(cn, integrationId, opts);
