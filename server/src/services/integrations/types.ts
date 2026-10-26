/**
 * DEF-354 — Integrations Stage 1: THE shared contracts.
 *
 * Every module under services/integrations/ (sources, mapping, store, engine,
 * schedule) and the admin route import their shapes from here, so a field name
 * cannot drift between the module that writes it and the one that reads it.
 * Spec: server/docs/INTEGRATIONS_DESIGN.md (§2). Ported from vm
 * 06_INTEGRATION.md §8/§9; the vm rule each shape serves is named next to it.
 *
 * This file is types, constants and error classes ONLY. It imports nothing —
 * in particular no AI provider — because engine/** imports it and the engine
 * must stay model-free by construction (spec §1, test-pinned). The module
 * signatures at the bottom are the contracts the parallel builders implement
 * exactly (`export const x: Module['x'] = ...` or `satisfies`).
 *
 * Conventions every implementation follows:
 *   - `cn` (clientNumber) is the FIRST parameter of every service function and
 *     is in every `where` / raw SQL statement (AGENTS tenant rule; the Prisma
 *     extension does not cover raw SQL or `create`).
 *   - Timestamps cross the API as ISO-8601 strings; in the DB they are
 *     TIMESTAMPTZ. A KPI period is a calendar date string `YYYY-MM-DD`.
 *   - KPI values travel as canonical decimal STRINGS (e.g. "1234.5"), never JS
 *     floats: the column is NUMERIC(20,6) and a float round-trip would invent
 *     changes the IS DISTINCT FROM guard then writes.
 */

// ── Enumerations (mirror the CHECK constraints in 20261026_integrations_core) ──

export const SOURCE_KINDS = ['gsheet'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];

export const INTEGRATION_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED'] as const;
export type IntegrationStatus = typeof INTEGRATION_STATUSES[number];

export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'once'] as const;
export type Frequency = typeof FREQUENCIES[number];

/** Is a blank from this source normal, or a sign it broke? A blank NEVER
 *  overwrites under either policy (vm §9); the policy only decides whether the
 *  blank is reported as an anomaly. */
export const BLANK_POLICIES = ['normal', 'abnormal'] as const;
export type BlankPolicy = typeof BLANK_POLICIES[number];

export const VERSION_STATUSES = ['DRAFT', 'APPROVED', 'SUPERSEDED'] as const;
export type VersionStatus = typeof VERSION_STATUSES[number];

export const SUGGESTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'SET_ASIDE', 'BLANK'] as const;
export type SuggestionStatus = typeof SUGGESTION_STATUSES[number];

/** Stage 1 maps to KPI numbers only; later stages widen this and the CHECK. */
export const TARGET_KINDS = ['kpi'] as const;
export type TargetKind = typeof TARGET_KINDS[number];

/** RUNNING is the mutex state (partial unique index). PARTIAL = completed and
 *  wrote, but the read was truncated (ReadResult.truncated) — the admin must
 *  know part of the sheet was never seen. */
export const RUN_STATUSES = ['RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'ABORTED'] as const;
export type RunStatus = typeof RUN_STATUSES[number];

export const RUN_TRIGGERS = ['manual', 'scheduled'] as const;
export type RunTrigger = typeof RUN_TRIGGERS[number];

export const KPI_DIRECTIONS = ['up', 'down'] as const;
export type KpiDirection = typeof KPI_DIRECTIONS[number];

export const KPI_GRAINS = ['day', 'week', 'month'] as const;
export type KpiGrain = typeof KPI_GRAINS[number];

/** kpi_definitions.kpi_key — same pattern as the DB CHECK. */
export const KPI_KEY_RE = /^[a-z][a-z0-9_]{0,79}$/;

/** targetKey forms: an existing catalogue KPI, or one the proposer names new
 *  (approving that row creates the definition — spec §2.3). */
export type KpiTargetKey = `kpi:${string}` | `kpi:new:${string}`;

/** `triggeredBy` of a scheduled run; a manual run uses `user:<id>`. */
export const SCHEDULER_ACTOR = 'scheduler';

// ── Source (spec §2.2) ────────────────────────────────────────────────────

/** Stored in integration_syncs.source_config. The export URL is REBUILT from
 *  sheetId + gid alone (vm integrationSheetLink): `link` is kept for display
 *  only and is never fetched, so a pasted link cannot send the server anywhere
 *  else. A tab is never silently swapped: gid is always explicit. */
export interface GsheetSourceConfig {
  sheetId: string;
  /** Numeric tab id as a string ("0" for the first tab). */
  gid: string;
  tabLabel?: string;
  link: string;
}

/** What a reader needs to know about the integration it reads. */
export interface IntegrationSourceRef {
  id: string;
  sourceKind: SourceKind;
  sourceConfig: GsheetSourceConfig;
}

export interface ReadResult {
  /** One object per data row, keyed by header. Cells are raw trimmed strings;
   *  an empty cell is '' (never undefined) so blank detection is uniform. */
  records: Record<string, string>[];
  headers: string[];
  rowCount: number;
  /** True when a cap (rows or bytes) stopped the read early. */
  truncated: boolean;
  truncatedReason?: string;
  /** Plain-language oddities found while reading (duplicate headers, ragged
   *  rows…). Reported, never silently corrected. */
  anomalies: string[];
  /** Human label for messages, e.g. "Sales 2026 › Monthly". */
  sourceLabel: string;
}

/** Connect-step test (spec §2.2: a 200 with 0 rows is NOT ok). */
export interface TestResult {
  ok: boolean;
  rows: number;
  columns: string[];
  sampleRow: Record<string, string> | null;
  /** Why it failed, in words the admin can act on (e.g. "not shared"). */
  reason?: string;
}

export interface SourceReader {
  test(cn: string, integ: IntegrationSourceRef): Promise<TestResult>;
  read(cn: string, integ: IntegrationSourceRef): Promise<ReadResult>;
}

// ── Mapping (design time, spec §2.3) ──────────────────────────────────────

export type InferredFieldType = 'number' | 'date' | 'text' | 'empty';

/** Field inventory computed from ALL rows (vm buildFieldCoverage). */
export interface FieldCoverage {
  field: string;
  /** Rows where the cell is non-blank. */
  filled: number;
  total: number;
  inferredType: InferredFieldType;
  /** 2–3 real values from the sheet. */
  samples: string[];
  /** All distinct values, present only when they are few. */
  distinct?: string[];
}

/**
 * How a KPI is laid out in the sheet.
 *  - long: one value column + a period column (+ optional dimension column).
 *  - wide: one column per period; the period comes from each column HEADER.
 * dimensionField, when set, makes dimensionKey `<dimensionField>=<cell>`;
 * absent ⇒ dimensionKey '' (the total).
 */
export type KpiTransform =
  | { mode: 'long'; valueField: string; periodField: string; dimensionField?: string }
  | { mode: 'wide'; columns: string[]; periodFrom: 'header'; dimensionField?: string };

/** What the proposer hands mappingStore to persist as one suggestion row.
 *  For mode 'wide', sourceField = transform.columns[0] (display), and the
 *  header check uses every transform column. */
export interface SuggestionDraft {
  targetKind: 'kpi';
  sourceField: string;
  targetKey: KpiTargetKey;
  transform: KpiTransform;
  coverage: FieldCoverage;
  samples: string[];
  /** Blast radius / set-aside arithmetic, in plain words. */
  reason: string;
  /** Present iff targetKey is `kpi:new:<key>`; key must match KPI_KEY_RE. */
  newKpi?: { kpiKey: string; label: string; unit?: string };
}

export interface ProposeOptions {
  prompt?: string;
  actorId: number;
}

export interface ProposeResult {
  /** The new version NUMBER (1, 2, …). */
  mappingVersion: number;
  versionId: string;
  summary: string;
  /** Which provider answered (for display / audit); a plain string so this
   *  file never imports the LLM layer. */
  provider: string;
  counts: { pending: number; approvedCarried: number; setAside: number };
  /** "Could not be done" notices from the proposer and the risk checks. */
  notices: string[];
}

export type JobState = 'running' | 'done' | 'failed';

/** In-memory proposal job (TTL = behavior `integrations.proposal_job_ttl_ms`). */
export interface ProposalJobStatus {
  jobId: string;
  integrationId: string;
  state: JobState;
  startedAt: string;
  finishedAt: string | null;
  result: ProposeResult | null;
  error: string | null;
}

// ── Planning and the run (execution time, spec §2.4) ──────────────────────

export type ValueVerdict =
  /** value: canonical decimal string (see header). */
  | { kind: 'ok'; value: string }
  /** Blank, policy 'normal' — skip quietly. */
  | { kind: 'blank_expected'; reason: string }
  /** Blank, policy 'abnormal' — skip, keep the existing figure, report it. */
  | { kind: 'blank_alert'; reason: string }
  /** Present but not a number — skip and count. */
  | { kind: 'invalid'; reason: string };

/** The APPROVED suggestion rows of ONE version, as the planner consumes them.
 *  Computed when the run starts, never stored (vm §8 "a computed value must
 *  not also be settable"). */
export interface ApprovedKpiRow {
  suggestionId: string;
  sourceField: string;
  /** Always `kpi:<key>` by now: approving `kpi:new:<key>` rewrites it. */
  targetKey: `kpi:${string}`;
  transform: KpiTransform;
}

export interface KpiDefinitionRef {
  kpiKey: string;
  label: string;
  unit: string | null;
  isActive: boolean;
  sourceIntegrationId: string | null;
}

/** `${kpiKey}|${periodStart}|${dimensionKey}` — the identity of one reading,
 *  used for the `existing` map, distinct-subject counts and run-change rows. */
export type ReadingKey = string;

/** Current values the integration's planned keys already hold (canonical
 *  decimal strings), keyed by ReadingKey. Absent key ⇒ no row yet. */
export type ExistingReadings = Map<ReadingKey, string>;

export interface PlannedReading {
  kpiKey: string;
  /** YYYY-MM-DD, first day of the period. */
  periodStart: string;
  /** '' = total; otherwise `<dimensionField>=<value>`. */
  dimensionKey: string;
  value: string;
  /** Where it came from, e.g. "row 14 › Revenue" — for the change row. */
  sourceKey: string;
  /** Existing value, or null when this creates the reading. A plan only ever
   *  contains readings whose value differs from `before`. */
  before: string | null;
}

export interface KpiPlan {
  /** Only real changes (value differs from existing, or no row yet). */
  readings: PlannedReading[];
  /** Keys whose value already matched — not written, not counted as writes. */
  unchanged: number;
  blanks: number;
  /** Non-numeric or unparseable period — skipped and counted. */
  skipped: number;
  /** Distinct ReadingKeys touched by `readings`. */
  subjectsAffected: number;
  anomalies: string[];
  /** Set when an approved row targets a KPI definition that is inactive or
   *  missing ⇒ the run FAILS, writing nothing (vm §9 "unconfigured target fails
   *  the run"). Never a silent drop. */
  failure: string | null;
}

export interface CapVerdict {
  wouldTrip: boolean;
  /** Percentage of owned readings this run would change (one decimal). */
  pct: number;
  cap: number;
}

export interface ScheduleConfig {
  frequency: Frequency;
  /** 'HH:MM' in `timezone`. Applies to every frequency (vm ignored it for
   *  weekly/monthly; spec §2.5 says "with a time"). */
  runTime: string;
  /** 0 = Sunday … 6. Required for weekly. */
  dayOfWeek: number | null;
  /** 1–31, or -1 = last day; clamped to the month's length. Required for monthly. */
  dayOfMonth: number | null;
}

export interface RunCounts {
  recordsRead: number;
  filteredOut: number;
  skipped: number;
  setAside: number;
  blanks: number;
  /** Distinct subjects (ReadingKeys), never row counts (vm §9). */
  subjectsAffected: number;
  writes: number;
}

export interface RunOptions {
  dryRun: boolean;
  trigger: RunTrigger;
  /** `user:<id>` or SCHEDULER_ACTOR. */
  triggeredBy: string;
  /** Dry runs only: the on-screen version. Live runs always use
   *  approved_version_id and reject a different versionId. */
  versionId?: string;
  /** Called once, right after the run row (the mutex) is inserted, with its id.
   *  runJobs.startRun uses it to return the runId before the run finishes. */
  onStarted?: (runId: string) => void;
}

export interface EngineResult extends RunCounts {
  runId: string;
  dryRun: boolean;
  status: Exclude<RunStatus, 'RUNNING'>;
  changePercent: number;
  /** Reported on EVERY run, dry runs included, as a scheduled run would see it
   *  (spec §2.4 step 5). Only a scheduled live run acts on it. */
  capVerdict: CapVerdict;
  anomalies: string[];
  error?: string;
}

export interface RunStatusView {
  runId: string;
  integrationId: string;
  status: RunStatus;
  dryRun: boolean;
  trigger: RunTrigger;
  mappingVersionId: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Null while RUNNING. */
  result: EngineResult | null;
  error: string | null;
  /** 'user:<id>' for a manual run, 'scheduler' for a scheduled one (Run History "Who"). */
  triggeredBy: string | null;
}

export interface RunChangeDTO {
  id: string;
  op: 'create' | 'update';
  subjectKey: ReadingKey;
  subjectLabel: string | null;
  targetKey: string;
  sourceKey: string | null;
  beforeValue: string | null;
  afterValue: string | null;
  createdAt: string;
}

export interface DispatchResult {
  claimed: number;
  started: number;
  skipped: number;
}

// ── Errors (routes map them to HTTP codes) ────────────────────────────────

/** 409 / scheduler skip: the integration already has a RUNNING run (23505 on
 *  integration_runs_one_running). */
export class RunBusyError extends Error {
  readonly code = 'RUN_BUSY';
  constructor(readonly integrationId: string) {
    super(`Integration ${integrationId} already has a run in progress.`);
    this.name = 'RunBusyError';
  }
}

/** 404. Also what a wrong-tenant id produces — never a 403 that confirms the
 *  id exists in another tenant. */
export class IntegrationNotFoundError extends Error {
  readonly code = 'INTEGRATION_NOT_FOUND';
  constructor(readonly integrationId: string) {
    super(`Integration ${integrationId} not found.`);
    this.name = 'IntegrationNotFoundError';
  }
}

/** The tenant's designated Google account token could not be read/decrypted
 *  (or none is designated) for a private sheet. The test/run fails with this
 *  reason; nothing falls back to another account. */
export class CredentialUnreadableError extends Error {
  readonly code = 'CREDENTIAL_UNREADABLE';
  constructor(reason: string) {
    super(reason);
    this.name = 'CredentialUnreadableError';
  }
}

/** 400: IntegrationInput / KpiDefinitionInput failed the closed whitelist or a
 *  field validation. `field` names the offending key. */
export class IntegrationInputError extends Error {
  readonly code = 'INTEGRATION_INPUT';
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'IntegrationInputError';
  }
}

/** 409: turn-on preconditions not met (spec §2.5). `reasons` are shown to the
 *  admin verbatim. */
export class ActivationRefusedError extends Error {
  readonly code = 'ACTIVATION_REFUSED';
  constructor(readonly reasons: string[]) {
    super(`Cannot turn on: ${reasons.join('; ')}`);
    this.name = 'ActivationRefusedError';
  }
}

// ── Wizard / store DTOs (spec §2.6, §2.7) ─────────────────────────────────

export interface WizardStage {
  step: 1 | 2 | 3 | 4 | 5;
  label: string;
  done: boolean;
}

/** Facts deriveWizardStage reads — derived, never a stored pointer (vm P:313).
 *  Stage 1 order: ACTIVE → PAUSED → hasSuccessfulDryRun → hasApproval →
 *  hasMapping → connectionTested → hasSource → not connected. */
export interface StageFacts {
  status: IntegrationStatus;
  /** source_config holds a parsed sheet. */
  hasSource: boolean;
  /** connection_tested_at set AND fingerprint matches the current config. */
  connectionTested: boolean;
  /** A mapping version exists. */
  hasMapping: boolean;
  /** The latest version has ≥1 APPROVED suggestion. */
  hasApproval: boolean;
  /** A SUCCESS dry run exists for the latest version + current fingerprint. */
  hasSuccessfulDryRun: boolean;
}

/** What the API returns. Never carries a secret or the raw fingerprint. */
export interface IntegrationDTO {
  id: string;
  name: string;
  purpose: string | null;
  adminBrief: string | null;
  sourceKind: SourceKind;
  sourceConfig: GsheetSourceConfig | null;
  status: IntegrationStatus;
  frequency: Frequency;
  runTime: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  timezone: string;
  changeCapPct: number;
  blankPolicy: BlankPolicy;
  connectionTestedAt: string | null;
  /** Tested AND the tested fingerprint is the current config's. */
  connectionOk: boolean;
  activatedAt: string | null;
  approvedVersionId: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  stage: WizardStage;
}

/**
 * The CLOSED whitelist a client may send on POST / PUT (vm §9 "permissions are
 * never accepted from the client"). Status, approval, activation, timestamps,
 * fingerprint and createdBy are absent ON PURPOSE. Unknown keys are REJECTED
 * (IntegrationInputError), not ignored. The sheet arrives as a link and is
 * parsed server-side (parseSheetLink); sheetId/gid are never taken raw.
 */
export interface IntegrationInput {
  name?: string;
  purpose?: string | null;
  adminBrief?: string | null;
  sourceKind?: SourceKind;
  /** Pasted Google Sheet link; changing it clears connection_tested_at. */
  link?: string;
  tabLabel?: string | null;
  frequency?: Frequency;
  runTime?: string;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  /** Validated with isValidTimezone; defaults to the creator's zone. */
  timezone?: string;
  changeCapPct?: number;
  blankPolicy?: BlankPolicy;
}

/** Runtime copy of the whitelist, for the unknown-key check. */
export const INTEGRATION_INPUT_KEYS: ReadonlyArray<keyof IntegrationInput> = [
  'name', 'purpose', 'adminBrief', 'sourceKind', 'link', 'tabLabel',
  'frequency', 'runTime', 'dayOfWeek', 'dayOfMonth', 'timezone',
  'changeCapPct', 'blankPolicy',
];

export interface MappingVersionDTO {
  id: string;
  version: number;
  status: VersionStatus;
  aiSummary: string | null;
  adminPrompt: string | null;
  /** {filter?, coverage: FieldCoverage[], provider, notices: string[]} */
  spec: Record<string, unknown>;
  approvedBy: number | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface SuggestionDTO {
  id: string;
  mappingVersionId: string;
  targetKind: TargetKind;
  sourceField: string;
  targetKey: string;
  transform: KpiTransform | null;
  coverage: FieldCoverage | null;
  samples: string[];
  newKpi: { kpiKey: string; label: string; unit?: string } | null;
  status: SuggestionStatus;
  reason: string | null;
  carriedFromId: string | null;
  decidedBy: number | null;
  decidedAt: string | null;
}

export interface SuggestionDecisionResult {
  updated: number;
  /** kpi_keys created by approving `kpi:new:` rows. */
  createdKpis: string[];
  /** Rows not changed, with why (e.g. KPI owned by another integration —
   *  vm §9 "one field, one owner"; not PENDING). */
  refused: Array<{ id: string; reason: string }>;
}

export interface KpiDefinitionDTO {
  id: string;
  kpiKey: string;
  label: string;
  unit: string | null;
  direction: KpiDirection;
  grain: KpiGrain;
  sourceIntegrationId: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface KpiDefinitionInput {
  kpiKey: string;
  label: string;
  unit?: string | null;
  direction?: KpiDirection;
  grain?: KpiGrain;
}

// ── MODULE SIGNATURES (implemented exactly by the parallel builders) ─────

/** sources/gsheetReader.ts */
export interface GsheetReaderModule {
  /** Caps from behaviorConfig: integrations.sheet_max_bytes / sheet_timeout_ms /
   *  max_rows. An HTML answer = "not shared / sign-in needed". */
  readGsheet(cn: string, cfg: GsheetSourceConfig): Promise<ReadResult>;
  /** Reads for real; ok only with ≥1 data row. */
  testGsheet(cn: string, cfg: GsheetSourceConfig): Promise<TestResult>;
  /** Throws IntegrationInputError('…', 'link') on anything that is not a
   *  docs.google.com spreadsheet link. Missing gid ⇒ '0'. */
  parseSheetLink(link: string): GsheetSourceConfig;
}

/** mapping/fieldInventory.ts (pure) */
export interface FieldInventoryModule {
  buildFieldCoverage(records: Record<string, string>[], headers: string[]): FieldCoverage[];
}

/** mapping/aiProposer.ts — the ONLY module that calls a model (callLLM via
 *  llmRouter, purpose 'integration_mapping'). Creates a new version that
 *  carries every APPROVED row of the previous one and proposes the rest. */
export interface AiProposerModule {
  proposeMapping(cn: string, integrationId: string, opts: ProposeOptions): Promise<ProposeResult>;
}

/** mapping/proposalJobs.ts — in-memory, TTL integrations.proposal_job_ttl_ms. */
export interface ProposalJobsModule {
  /** Throws IntegrationNotFoundError; refuses (IntegrationInputError) when the
   *  connection has not passed its test (spec §2.2). */
  startProposalJob(cn: string, integrationId: string, opts: ProposeOptions): Promise<{ jobId: string }>;
  /** Null when unknown, expired, or belonging to another tenant/integration. */
  getProposalJob(cn: string, integrationId: string, jobId: string): ProposalJobStatus | null;
}

/** store/integrationStore.ts */
export interface IntegrationStoreModule {
  listIntegrations(cn: string): Promise<IntegrationDTO[]>;
  getIntegration(cn: string, id: string): Promise<IntegrationDTO | null>;
  /** Status forced DRAFT; timezone defaults to resolveUserTimezone(actorId). */
  createIntegration(cn: string, input: IntegrationInput, actorId: number): Promise<IntegrationDTO>;
  /** Closed whitelist. Editing link/tab clears connection_tested_at and
   *  connection_fingerprint. Throws IntegrationNotFoundError / IntegrationInputError. */
  updateIntegration(cn: string, id: string, patch: IntegrationInput): Promise<IntegrationDTO>;
  /** Cascade removes versions, suggestions, runs; KPI readings stay. */
  deleteIntegration(cn: string, id: string): Promise<void>;
  deriveWizardStage(facts: StageFacts): WizardStage;
  /** On ok: stores tested_at = now() and the fingerprint of the CURRENT config.
   *  On failure: clears both. */
  recordConnectionTest(cn: string, id: string, result: TestResult): Promise<IntegrationDTO>;
  /** sha256 hex of the canonical route config (sourceKind + sheetId + gid).
   *  The ONE definition used by recordConnectionTest, the run row and activate,
   *  so "the tested connection is the one runs use" compares like with like. */
  connectionFingerprint(sourceKind: SourceKind, cfg: GsheetSourceConfig): string;
}

/** store/mappingStore.ts */
export interface MappingStoreModule {
  /** versionId omitted ⇒ the latest version. */
  listSuggestions(cn: string, integrationId: string, versionId?: string):
    Promise<{ version: MappingVersionDTO | null; suggestions: SuggestionDTO[] }>;
  /** Field-wise approval on ONE version. Approving `kpi:new:<key>` creates the
   *  definition (source_integration_id = this integration) and rewrites the
   *  targetKey to `kpi:<key>`. A KPI owned by another integration is refused. */
  approveSuggestions(cn: string, integrationId: string, versionId: string,
    ids: string[] | 'all', actorId: number): Promise<SuggestionDecisionResult>;
  rejectSuggestions(cn: string, integrationId: string, versionId: string,
    ids: string[] | 'all', actorId: number): Promise<SuggestionDecisionResult>;
  listKpiDefinitions(cn: string): Promise<KpiDefinitionDTO[]>;
  createKpiDefinition(cn: string, input: KpiDefinitionInput, actorId?: number): Promise<KpiDefinitionDTO>;
  /** ONE transaction (spec §2.5): ≥1 approved row on versionId; a SUCCESS dry
   *  run for that version with the current connection fingerprint; valid
   *  schedule. Then: version APPROVED (previous SUPERSEDED), status ACTIVE,
   *  activated_at = now() only if not already active, next_run_at computed.
   *  NEVER runs anything. Throws ActivationRefusedError. */
  activate(cn: string, id: string, versionId: string, actorId: number): Promise<IntegrationDTO>;
  pause(cn: string, id: string): Promise<IntegrationDTO>;
}

/** engine/planner.ts — PURE, no I/O, no model. */
export interface PlannerModule {
  classifyValue(raw: unknown, policy: BlankPolicy): ValueVerdict;
  /** Canonical decimal string, or null when not a number. Strips thousands
   *  separators, currency symbols, a trailing %; "(12)" ⇒ "-12". */
  parseNumber(raw: string): string | null;
  /** A period cell or wide-column header ⇒ 'YYYY-MM-DD' (first day of the
   *  period), or null when unparseable. */
  parsePeriod(raw: string): string | null;
  planKpiReadings(
    records: Record<string, string>[],
    approvedRows: ApprovedKpiRow[],
    defs: KpiDefinitionRef[],
    existing: ExistingReadings,
    policy?: BlankPolicy,
  ): KpiPlan;
  /** owned = readings this integration already owns; owned 0 never trips
   *  (first load). Trips when pct > capPct. */
  changeCapVerdict(changed: number, owned: number, capPct: number): CapVerdict;
  /** The slot owed at `now`, or null. Never a slot before activatedAt; never
   *  for 'once'; never one already claimed (lastSlotAt >= slot). */
  isDue(schedule: ScheduleConfig, now: Date, lastSlotAt: Date | null,
    activatedAt: Date | null, tz: string): Date | null;
  /** The first slot strictly after `after`, or null ('once'). */
  nextScheduledRun(schedule: ScheduleConfig, after: Date, tz: string): Date | null;
}

/** engine/runEngine.ts — imports NO AI provider. */
export interface RunEngineModule {
  /** Throws IntegrationNotFoundError, RunBusyError. Every other failure is a
   *  FAILED/ABORTED run row and an EngineResult, not a throw. */
  runIntegration(cn: string, id: string, opts: RunOptions): Promise<EngineResult>;
  /** Boot: every RUNNING row ⇒ FAILED "interrupted by server restart".
   *  Returns the number swept. The one cross-tenant write (runWithoutTenant). */
  sweepInterruptedRuns(): Promise<number>;
}

/** engine/runJobs.ts — status is read from the run row, so it survives a restart. */
export interface RunJobsModule {
  /** Resolves with the runId as soon as the run row exists (RunOptions.onStarted);
   *  rejects with RunBusyError / IntegrationNotFoundError. */
  startRun(cn: string, integrationId: string, opts: Omit<RunOptions, 'onStarted'>): Promise<{ runId: string }>;
  getRunStatus(cn: string, integrationId: string, runId: string): Promise<RunStatusView | null>;
  /** GET /:id/runs — newest first. */
  listRuns(cn: string, integrationId: string, limit?: number): Promise<RunStatusView[]>;
  /** GET /:id/runs/:runId/changes */
  listRunChanges(cn: string, integrationId: string, runId: string): Promise<RunChangeDTO[]>;
}

/** schedule/dispatcher.ts — protectedJob 'integration_sync_dispatcher', 60 s. */
export interface DispatcherModule {
  dispatchDueIntegrations(now?: Date): Promise<DispatchResult>;
}
