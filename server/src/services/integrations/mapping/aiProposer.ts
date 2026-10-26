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
 */
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { callLLM } from '../../llmRouter';
import { readGsheet } from '../sources/gsheetReader';
import { readSourceConfig } from '../store/integrationStore';
import { buildFieldCoverage } from './fieldInventory';
import { assessKpiRowRisk, transformFields } from './mappingRisk';
import {
  IntegrationInputError,
  IntegrationNotFoundError,
  KPI_KEY_RE,
  type AiProposerModule,
  type FieldCoverage,
  type KpiTargetKey,
  type KpiTransform,
  type ProposeOptions,
  type ProposeResult,
  type ReadResult,
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
  targetKey?: unknown;
  newKpi?: unknown;
  transform?: unknown;
  why?: unknown;
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
  return 'transform.mode must be "long" or "wide"';
}

/** sourceField of a row: the value column (wide: the first period column,
 *  for display — types.ts SuggestionDraft). */
export function sourceFieldOf(t: KpiTransform): string {
  return t.mode === 'long' ? t.valueField : t.columns[0];
}

const pairKey = (sourceField: string, targetKey: string) => `${sourceField.toLowerCase()}::${targetKey.toLowerCase()}`;
const clip = (s: string, n = PROMPT_CELL_CHARS) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── Prompt ────────────────────────────────────────────────────────────────

export const PROPOSER_SYSTEM_PROMPT = `You map the columns of a business's Google Sheet to KPI numbers for Nexeo, a business assistant.
A KPI is one number per period (a day, a week or a month), optionally split by a dimension such as region.
You only PROPOSE: an administrator approves or rejects every row, and only approved rows are ever written.

Judge every column by its VALUES (the inventory shows fill rate, type and real samples from every row), never by its name alone.

Two layouts are possible:
- "long": one column holds the number and another holds the period. transform = {"mode":"long","valueField":"<column>","periodField":"<column>","dimensionField":"<column, optional>"}
- "wide": one column per period, the period is the column HEADER (e.g. "Jan 2026"). transform = {"mode":"wide","columns":["<column>", ...],"periodFrom":"header","dimensionField":"<column, optional>"}
dimensionField, when given, splits the KPI by the value in that column (one reading per value); omit it for a single total.

Target keys:
- "kpi:<key>" for a KPI in the catalogue you are given. Use ONLY keys from that catalogue.
- "kpi:new:<key>" for a KPI that is not in the catalogue; then also give "newKpi": {"kpiKey":"<key>","label":"<short label>","unit":"<optional unit, e.g. PKR, %, count>"}. <key> is lowercase letters, digits and underscores, starting with a letter, at most 80 characters.

Rules:
- One row per KPI. Never propose two sources for the same KPI.
- Do NOT propose anything listed as ALREADY APPROVED, and no other source for those KPIs.
- Do NOT propose a pair listed as ALREADY REJECTED unless the administrator's instruction asks for it.
- Never map identity columns (names, emails, phone numbers, ids) as KPIs.
- If something the administrator asked for cannot be done from this sheet, say so in "notices" in plain words.

Answer with ONE JSON object and nothing else, in exactly this shape, with "complete": true as the LAST key:
{"summary":"<two sentences for the administrator>","rows":[{"targetKey":"kpi:...","newKpi":{...} or omitted,"transform":{...},"why":"<one sentence>"}],"notices":["..."],"complete":true}`;

export interface PromptInputs {
  integration: { name: string; purpose: string | null; adminBrief: string | null };
  sourceLabel: string;
  adminPrompt?: string;
  coverage: FieldCoverage[];
  sampleRows: Record<string, string>[];
  catalogue: Array<{ kpiKey: string; label: string; unit: string | null; grain?: string }>;
  approved: Array<{ sourceField: string; targetKey: string; transform: KpiTransform | null }>;
  approvedFromVersion: number | null;
  rejected: Array<{ sourceField: string; targetKey: string }>;
  rowCount: number;
}

/** The user message: one labelled block per input (spec §2.3). Pure. */
export function buildProposerUserMessage(p: PromptInputs): string {
  const blocks: string[] = [];
  blocks.push(`INTEGRATION: ${p.integration.name}\nSOURCE: ${p.sourceLabel} (${p.rowCount} data rows)`);
  if (p.integration.purpose?.trim()) blocks.push(`WHY IT IS BEING CONNECTED:\n${p.integration.purpose.trim()}`);
  if (p.integration.adminBrief?.trim()) blocks.push(`ADMINISTRATOR'S BRIEF:\n${p.integration.adminBrief.trim()}`);
  if (p.adminPrompt?.trim()) blocks.push(`ADDITIONAL INSTRUCTION (takes priority over everything above):\n${p.adminPrompt.trim()}`);

  blocks.push(`FIELD INVENTORY (computed from all ${p.rowCount} rows, in sheet order):\n${p.coverage.map((c) => {
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
  sourceField: string;
  targetKey: string;
  transform: unknown;
  coverage: unknown;
  samples: unknown;
  newKpi: unknown;
  reason: string | null;
  decidedBy: number | null;
  decidedAt: Date | null;
}

/** One suggestion row ready to insert (minus the ids the transaction adds). */
export interface PlannedSuggestion {
  sourceField: string;
  targetKey: string;
  transform: KpiTransform | null;
  coverage: FieldCoverage | null;
  samples: string[];
  newKpi: { kpiKey: string; label: string; unit?: string } | null;
  status: 'PENDING' | 'APPROVED' | 'SET_ASIDE';
  reason: string;
  carriedFromId: string | null;
  decidedBy: number | null;
  decidedAt: Date | null;
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
}

/** Turn the model's rows into suggestion rows. Pure; every refusal leaves a
 *  notice, never a silent drop the admin cannot see. */
export function validateProposal(v: ValidateInputs): { rows: PlannedSuggestion[]; notices: string[] } {
  const notices: string[] = [];
  const rows: PlannedSuggestion[] = [];
  const byKey = new Map(v.defs.map((d) => [d.kpiKey, d]));
  const covOf = new Map(v.coverage.map((c) => [c.field, c]));
  const rejected = new Set(v.rejected.map((r) => pairKey(r.sourceField, r.targetKey)));

  // Carried rows first, unchanged: they are the approved state (vm §9).
  const fed = new Map<string, string>(); // kpiKey → what feeds it in this version
  const carriedPairs = new Set<string>();
  for (const c of v.carried) {
    const t = c.transform as KpiTransform | null;
    rows.push({
      sourceField: c.sourceField,
      targetKey: c.targetKey,
      transform: t,
      coverage: (c.coverage as FieldCoverage | null) ?? null,
      samples: Array.isArray(c.samples) ? (c.samples as unknown[]).map(String) : [],
      newKpi: (c.newKpi as PlannedSuggestion['newKpi']) ?? null,
      status: 'APPROVED',
      reason: c.reason ?? '',
      carriedFromId: c.id,
      decidedBy: c.decidedBy,
      decidedAt: c.decidedAt,
    });
    fed.set(kpiKeyOf(c.targetKey), `the approved row from "${c.sourceField}"`);
    carriedPairs.add(pairKey(c.sourceField, c.targetKey));
    // The approved row stays approved; the admin must still learn the sheet
    // moved under it, because the run's header check will fail it.
    const missing = t ? transformFields(t).filter((f) => !v.read.headers.includes(f)) : [];
    if (missing.length) {
      notices.push(`The approved mapping for ${c.targetKey} reads ${missing.map((m) => `"${m}"`).join(', ')}, which the sheet no longer has — runs will fail until it is withdrawn or the column is restored.`);
    }
  }

  for (const raw of v.answer.rows) {
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
    let reopened = false;
    // Both spellings: a `kpi:new:` row rejected before approval keeps that
    // spelling, while the same KPI may be in the catalogue by now.
    if (rejected.has(pairKey(sourceField, `kpi:${kpiKey}`)) || rejected.has(pairKey(sourceField, `kpi:new:${kpiKey}`))) {
      if (!v.hasAdminPrompt) {
        notices.push(`Not proposed again: "${sourceField}" → ${kpiKey} was rejected earlier.`);
        continue;
      }
      reopened = true;
    }

    const coverage = covOf.get(sourceField) ?? null;
    const samples = samplesOf(t, covOf);
    const why = typeof raw.why === 'string' && raw.why.trim() ? ` AI: ${raw.why.trim()}` : '';
    const base = { sourceField, targetKey, transform: t, coverage, samples, newKpi, carriedFromId: null, decidedBy: null, decidedAt: null };

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
      reason: `${reopened ? 'Rejected earlier; proposed again because of your instruction. ' : ''}${risk.reason}${why}`,
    });
  }
  return { rows, notices };
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
  const cols = t.mode === 'long' ? [t.valueField] : t.columns;
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
    select: { id: true, name: true, purpose: true, adminBrief: true, sourceConfig: true },
  });
  if (!integ) throw new IntegrationNotFoundError(integrationId);
  const cfg = readSourceConfig(integ.sourceConfig);
  if (!cfg) throw new IntegrationInputError('Connect a Google Sheet before asking for a mapping.', 'link');

  onStage('Reading the sheet');
  const read = await readGsheet(cn, cfg);
  if (read.records.length === 0) {
    throw new ProposalError('The sheet has no data rows, so there is nothing to map.');
  }

  onStage(`Taking stock of ${read.headers.length} columns across ${read.rowCount} rows`);
  const coverage = buildFieldCoverage(read.records, read.headers);

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
        id: true, sourceField: true, targetKey: true, transform: true, coverage: true, samples: true,
        newKpi: true, reason: true, decidedBy: true, decidedAt: true,
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
    approved: carried.map((c) => ({ sourceField: c.sourceField, targetKey: c.targetKey, transform: (c.transform as KpiTransform | null) ?? null })),
    approvedFromVersion: carried.length && previous ? previous.version : null,
    rejected,
    rowCount: read.rowCount,
  });

  onStage('Asking the AI what each column means');
  const budget = proposerBudget(coverage.length);
  const reply = await callLLM(PROPOSER_SYSTEM_PROMPT, userMessage, {
    purpose: PROPOSER_PURPOSE,
    clientNumber: cn,
    userId: opts.actorId,
    timeoutMs: PROPOSER_TIMEOUT_MS,
    providers: [...PROPOSER_PROVIDERS],
    ...budget,
  });

  onStage('Checking the proposal against the sheet');
  const answer = parseProposerAnswer(reply.text);
  const { rows, notices: checkNotices } = validateProposal({
    integrationId, answer, read, coverage, defs, carried, rejected, hasAdminPrompt: !!opts.prompt?.trim(),
  });

  const notices = [...answer.notices, ...checkNotices];
  if (read.truncated) {
    notices.unshift(`Only the first ${read.rowCount} rows were read${read.truncatedReason ? ` (${read.truncatedReason})` : ''}; the mapping is judged on those.`);
  }
  for (const a of read.anomalies) notices.push(a);
  const summary = answer.summary || (rows.length ? 'Mapping proposed.' : 'No KPI could be mapped from this sheet.');

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
        spec: JSON.parse(JSON.stringify({ coverage, provider: reply.provider, notices })),
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
          targetKind: 'kpi',
          sourceField: r.sourceField.slice(0, 255),
          targetKey: r.targetKey,
          transform: r.transform ? JSON.parse(JSON.stringify(r.transform)) : undefined,
          coverage: r.coverage ? JSON.parse(JSON.stringify(r.coverage)) : undefined,
          samples: r.samples,
          newKpi: r.newKpi ? JSON.parse(JSON.stringify(r.newKpi)) : undefined,
          status: r.status,
          reason: r.reason,
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

export const proposeMapping: AiProposerModule['proposeMapping'] = (cn, integrationId, opts) =>
  runProposal(cn, integrationId, opts);
