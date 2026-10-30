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
 *
 * DEF-362 (Stage 1b, spec §2b) widens these contracts additively: an `api`
 * source read through the guarded fetcher, the API document the AI reads,
 * the admin's remarks / filter words / connect instructions, and two new
 * mapping targets — Context (Brain knowledge pages) and the structured record
 * filter. Every Stage 1 shape keeps its meaning; a Google Sheet integration
 * sees the new DTO fields only as null / false.
 */

// ── Enumerations (mirror the CHECK constraints in 20261026_integrations_core,
//    widened by 20261026b_integrations_api) ────────────────────────────────

/** DEF-362: 'api' = a REST endpoint drafted from an uploaded API document. */
export const SOURCE_KINDS = ['gsheet', 'api'] as const;
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

/** Stage 1 mapped to KPI numbers only. DEF-362 adds 'context' (Brain knowledge
 *  pages) and 'filter' (the ONE structured record-filter row per version, made
 *  from the admin's filter words — nothing filters until it is approved). */
export const TARGET_KINDS = ['kpi', 'context', 'filter'] as const;
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

/** DEF-362 targetKey forms for the new kinds (mirror the suggestions CHECK). */
export const CONTEXT_TARGET_KEYS = ['context:per_record', 'context:table'] as const;
export type ContextTargetKey = typeof CONTEXT_TARGET_KEYS[number];
export const FILTER_TARGET_KEY = 'filter' as const;
export type FilterTargetKey = typeof FILTER_TARGET_KEY;

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
   *  an empty cell is '' (never undefined) so blank detection is uniform.
   *  API sources: each JSON record FLATTENED (dotted keys) to the same shape,
   *  so the inventory, planner and filter never learn a second record form. */
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
  /** DEF-362, API only: the total the system itself declared (declaredTotalPath
   *  on the first page), or null when it declares none. "Read 900 of a
   *  declared 1,156" is a partial read, not a success (vm fetchRecordsWithMeta). */
  declaredTotal?: number | null;
  /** DEF-362, API only: pages actually fetched. */
  pagesRead?: number;
}

/** Connect-step test (spec §2.2: a 200 with 0 rows is NOT ok). */
export interface TestResult {
  ok: boolean;
  rows: number;
  columns: string[];
  sampleRow: Record<string, string> | null;
  /** Why it failed, in words the admin can act on (e.g. "not shared"). */
  reason?: string;
  /** DEF-362, API only (spec §2b Connect: "exactly one record … plus N records
   *  on this page (declared total M)"). `sampleRow` is that ONE record,
   *  flattened; `rows` equals `pageRecords` for an API test (one page read). */
  pageRecords?: number;
  declaredTotal?: number | null;
}

export interface SourceReader {
  test(cn: string, integ: IntegrationSourceRef): Promise<TestResult>;
  read(cn: string, integ: IntegrationSourceRef): Promise<ReadResult>;
}

// ── API source (DEF-362, spec §2b) ─────────────────────────────────────────

/** How the secret rides on the request. The model may DRAFT the scheme from the
 *  document; it never sees, chooses or stores the secret itself.
 *  BASIC: the stored secret is "user:password" and is base64'd at send time. */
export const AUTH_SCHEMES = ['NONE', 'BEARER', 'API_KEY', 'BASIC'] as const;
export type AuthScheme = typeof AUTH_SCHEMES[number];

export const API_METHODS = ['GET', 'POST'] as const;
export type ApiMethod = typeof API_METHODS[number];

export const PAGINATION_KINDS = ['none', 'page', 'offset', 'next_url'] as const;
export type PaginationKind = typeof PAGINATION_KINDS[number];

/**
 * How to walk the result set. `maxPages` is a per-integration ceiling that can
 * only LOWER behavior `integrations.api_max_pages`, never raise it.
 *  - page:     ?<pageParam>=startPage,startPage+1… (+ <pageSizeParam>=pageSize)
 *  - offset:   ?<offsetParam>=0,pageSize,2·pageSize… (+ <limitParam>=pageSize)
 *  - next_url: the URL at `nextUrlPath` in each body; it must be SAME-ORIGIN
 *              (vm assertSameOrigin — a cross-origin next page ends the read
 *              as a failure, it is never followed with the secret attached).
 * Every kind stops on an empty page.
 */
export type Pagination =
  | { kind: 'none' }
  | { kind: 'page'; pageParam: string; pageSizeParam?: string; pageSize?: number; startPage?: number; maxPages?: number }
  | { kind: 'offset'; offsetParam: string; limitParam?: string; pageSize: number; maxPages?: number }
  | { kind: 'next_url'; nextUrlPath: string; maxPages?: number };

/**
 * Stored in integration_syncs.api_config. NEVER contains the secret (that is
 * secret_enc, encrypted, store/secretStore.ts). Every value is editable by the
 * admin; the AI's reading of the document only pre-fills it.
 */
export interface ApiConfig {
  /** https://host[:port][/base/path]. Its ORIGIN is the only origin any request,
   *  redirect or next page may reach, and the only one the secret is sent to. */
  baseUrl: string;
  method: ApiMethod;
  /** Joined to baseUrl. A full URL is accepted only when it is same-origin. */
  path: string;
  /** Fixed query parameters sent on every page. */
  query: Record<string, string>;
  /** JSON body for POST endpoints (search APIs); ignored for GET. */
  body?: Record<string, unknown> | null;
  authScheme: AuthScheme;
  /** API_KEY in a header (default 'X-API-Key' when neither name is set). */
  authHeaderName?: string | null;
  /** API_KEY in the query string instead of a header. Wins over authHeaderName. */
  authQueryParam?: string | null;
  /** Dotted path to the records array in the JSON body ('' = the body IS the array). */
  recordsPath: string;
  /** The (flattened) field that identifies a record — the Context page key. */
  idField: string | null;
  pagination: Pagination;
  /** Dotted path to the system's own total count, if it states one. */
  declaredTotalPath?: string | null;
}

/** What the AI made of the API document (integration_syncs.api_doc_reading).
 *  `gaps` = what the document did NOT say, shown to the admin verbatim — a
 *  guessed value is worse than an asked question (vm integrationDocReader). */
export interface ApiDocReading {
  draft: Partial<ApiConfig>;
  gaps: string[];
  summary: string;
  /** Which provider answered — a plain string, so this file imports no LLM. */
  provider?: string;
  readAt?: string;
  /** How many credential-looking strings were redacted before the model saw it. */
  redactions?: number;
}

/** What an API reader needs: the integration id (to load its secret, tenant-
 *  scoped) and its connection. Separate from IntegrationSourceRef so the Stage 1
 *  sheet reader's signature is unchanged. */
export interface ApiSourceRef {
  id: string;
  sourceKind: 'api';
  apiConfig: ApiConfig;
}

/** Where the secret goes on a request, built from ApiConfig + the decrypted
 *  secret (vm buildAuth). guardedFetch attaches it ONLY to the configured
 *  origin. Never logged, never put in an error message. */
export interface AuthAttachment {
  headers: Record<string, string>;
  query: Array<{ name: string; value: string }>;
}

export interface GuardedFetchOptions {
  /** The configured origin (new URL(apiConfig.baseUrl).origin). The request URL,
   *  every redirect hop and every next page must be on it. */
  origin: string;
  method?: ApiMethod;
  headers?: Record<string, string>;
  body?: string;
  /** Attached only when the hop's origin === `origin`. */
  auth?: AuthAttachment | null;
  /** behavior integrations.api_max_bytes — over it the fetch FAILS (truncated
   *  JSON is not a smaller answer, it is no answer). */
  maxBytes: number;
  /** behavior integrations.api_timeout_ms — one deadline across all hops. */
  timeoutMs: number;
  /** ≤ 3 (spec §2b); larger values are clamped to 3. */
  maxRedirects?: number;
}

export interface GuardedResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: Buffer;
  /** The URL that answered (after same-origin redirects), auth query params removed. */
  finalUrl: string;
  redirects: number;
}

export interface FetchLimits {
  maxBytes: number;
  timeoutMs: number;
  maxPages: number;
}

export interface SetSecretOptions {
  /** Called with the CANDIDATE secret before anything is stored. A failing test
   *  stores nothing, so a working secret is never overwritten by a broken one
   *  (spec §2b "a secret that fails is not stored over one that works"). */
  testFirst?: (plain: string) => Promise<TestResult>;
}

export interface SetSecretResult {
  stored: boolean;
  /** The testFirst result, or null when no test was asked for. */
  test: TestResult | null;
  /** Why it was not stored, in admin words. */
  reason?: string;
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
  | { mode: 'wide'; columns: string[]; periodFrom: 'header'; dimensionField?: string }
  | { mode: 'recipe'; recipe: KpiRecipe; dimensionField?: string };

/**
 * DEF-365 — a KPI figure COMPUTED from the records (count / sum / ratio per
 * month), evaluated by the vendored @tmc/ai-integration recipe functions
 * (engine/kpiRecipe.ts compiles it to a framework GoalRecipe). Pure data: the
 * model proposes it, an admin approves it, code computes it — the model never
 * produces a figure. Per MONTH only, and only for months that have ended (the
 * framework's rule: a running month is never counted).
 *  - count: records per month (a record counts when its period reads);
 *  - sum:   Σ valueField per month;
 *  - ratio: Σ numeratorField ÷ Σ denominatorField per month (pooled), × scale
 *           (100 for a percentage).
 * dimensionField (on the transform, as for long/wide) splits it per value.
 */
export interface KpiRecipe {
  measure: 'count' | 'sum' | 'ratio';
  /** The field dating each record. */
  periodField: string;
  /** sum only. */
  valueField?: string;
  /** ratio only. */
  numeratorField?: string;
  denominatorField?: string;
  /** ratio only; default 1. */
  scale?: number;
  /** Plain words for the admin ("Orders per month"). */
  label: string;
}

/**
 * DEF-362 — Context: records become tenant-wide Brain knowledge (org_doc pages).
 *  - per_record: one page per record, titled "<integration> · <titleField>",
 *    body = the bodyFields as "Field: value" lines (a blank field is left out,
 *    never written over a filled section). Capped at integrations.max_context_pages.
 *  - table: ONE page for the whole set, the chosen columns as a table.
 */
export type ContextTransform =
  | { mode: 'per_record'; titleField: string; bodyFields: string[] }
  | { mode: 'table'; columns: string[] };

/** DEF-362 — the structured filter the proposer makes from the admin's filter
 *  words. `after`/`before` compare DATES (parsed, never string order); the
 *  greater/less ops compare NUMBERS (planner.parseNumber); a row whose cell does
 *  not parse for a numeric/date op does NOT match (filtered out and counted). */
export const FILTER_OPS = [
  'equals', 'not_equals', 'contains', 'not_contains',
  'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal',
  'is_blank', 'is_not_blank', 'after', 'before',
] as const;
export type FilterOp = typeof FILTER_OPS[number];
/** Ops that take no value. */
export const VALUELESS_FILTER_OPS: ReadonlyArray<FilterOp> = ['is_blank', 'is_not_blank'];

export interface FilterCondition {
  field: string;
  op: FilterOp;
  /** Required for every op except is_blank / is_not_blank. */
  value?: string;
}

export interface RecordFilter {
  match: 'all' | 'any';
  conditions: FilterCondition[];
}

/** Fields every proposed row shares. `followed` (DEF-362): WHICH remark, filter
 *  words or connect instruction the row followed, quoted or named — the owner's
 *  "every row says which remark or instruction it followed". Absent when none. */
interface SuggestionDraftBase {
  sourceField: string;
  samples: string[];
  /** Blast radius / set-aside arithmetic, in plain words. */
  reason: string;
  followed?: string;
}

/** What the proposer hands mappingStore to persist as one suggestion row.
 *  For mode 'wide', sourceField = transform.columns[0] (display), and the
 *  header check uses every transform column. */
export interface KpiSuggestionDraft extends SuggestionDraftBase {
  targetKind: 'kpi';
  targetKey: KpiTargetKey;
  transform: KpiTransform;
  coverage: FieldCoverage;
  /** Present iff targetKey is `kpi:new:<key>`; key must match KPI_KEY_RE. */
  newKpi?: { kpiKey: string; label: string; unit?: string };
}

/** sourceField = titleField (per_record) or columns[0] (table), for display;
 *  the header check uses every field the transform names. */
export interface ContextSuggestionDraft extends SuggestionDraftBase {
  targetKind: 'context';
  targetKey: ContextTargetKey;
  transform: ContextTransform;
  coverage: FieldCoverage | null;
}

/** At most ONE per version. sourceField = the first condition's field (display). */
export interface FilterSuggestionDraft extends SuggestionDraftBase {
  targetKind: 'filter';
  targetKey: FilterTargetKey;
  transform: RecordFilter;
  coverage: FieldCoverage | null;
}

export type SuggestionDraft = KpiSuggestionDraft | ContextSuggestionDraft | FilterSuggestionDraft;

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

/** DEF-362: an APPROVED context row of one version, as the context writer
 *  consumes it (computed when the run starts, never stored). */
export interface ApprovedContextRow {
  suggestionId: string;
  targetKey: ContextTargetKey;
  transform: ContextTransform;
}

/** One planned knowledge page (pure planning output of the context writer). */
export interface ContextPagePlan {
  /** Stable identity: `<integrationId>:<idField value>` (per_record) or
   *  `<integrationId>:table`. Stored in page metadata; the page TITLE is display. */
  recordKey: string;
  title: string;
  body: string;
  /** sha256 hex of `body` — unchanged content is skipped, never rewritten. */
  contentHash: string;
  /** e.g. "record 14 › id=A-77", for the change row. */
  sourceKey: string;
}

export interface ContextWriteResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Pages whose record disappeared from the source — marked stale, never deleted. */
  stale: number;
  /** Records that produced no page (no title / no id / all body fields blank). */
  skipped: number;
  /** True when integrations.max_context_pages stopped planning early. */
  truncated: boolean;
  anomalies: string[];
}

export interface ContextWriteOptions {
  dryRun: boolean;
  runId: string;
  /** apiConfig.idField; a sheet uses the row number when absent. */
  idField: string | null;
  /** The tenant user the org_doc pages are attributed to (the designated
   *  account, as the folder scribe uses). */
  userId: number;
}

/** DEF-362: what applying the APPROVED filter did. */
export interface FilterOutcome {
  kept: Record<string, string>[];
  filteredOut: number;
  /** e.g. 'Field "Status" is not in the data' — a condition naming a missing
   *  field FAILS the run (an unconfigured target), it never silently passes. */
  problems: string[];
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
  /** 'stale' (DEF-362): a context page whose record disappeared from the source. */
  op: 'create' | 'update' | 'stale';
  /** 'kpi' | 'context' (DEF-362). Optional so Stage 1 producers stay valid. */
  targetKind?: 'kpi' | 'context';
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
/** DEF-362: the REST fetch guard refused or aborted a request. `kind` says
 *  which rule fired; `message` is admin-readable and NEVER contains the secret
 *  or a URL carrying it. */
export type FetchGuardKind =
  | 'scheme' | 'address' | 'dns' | 'origin' | 'redirect' | 'size' | 'timeout' | 'network';
export class FetchGuardError extends Error {
  readonly code = 'FETCH_GUARD';
  constructor(readonly kind: FetchGuardKind, message: string) {
    super(message);
    this.name = 'FetchGuardError';
  }
}

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
  // DEF-362 (Stage 1b). Null / false on a Google Sheet integration.
  /** A secret is stored. The secret itself is NEVER returned. */
  hasSecret: boolean;
  apiDocName: string | null;
  apiDocReading: ApiDocReading | null;
  filterInstructions: string | null;
  connectInstructions: string | null;
  apiConfig: ApiConfig | null;
  /** The filter the admin APPROVED (read-only here; set only by approval). */
  approvedFilter: RecordFilter | null;
}

/**
 * The CLOSED whitelist a client may send on POST / PUT (vm §9 "permissions are
 * never accepted from the client"). Status, approval, activation, timestamps,
 * fingerprint and createdBy are absent ON PURPOSE. Unknown keys are REJECTED
 * (IntegrationInputError), not ignored. The sheet arrives as a link and is
 * parsed server-side (parseSheetLink); sheetId/gid are never taken raw.
 *
 * DEF-362: the API fields join the whitelist. The SECRET is NOT here — it has
 * its own write-only endpoint (secretStore.setSecret) so it can never ride on a
 * PUT that echoes the integration back. `approvedFilter`, `apiDocText` and
 * `apiDocReading` are NOT here either: approval writes the first, the document
 * upload and the AI reading write the others.
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
  /** sourceKind 'api'. Editing it clears the connection test (fingerprint). */
  apiConfig?: ApiConfig | null;
  /** Plain-word filters ("only active customers, 2025 onwards"). */
  filterInstructions?: string | null;
  /** "How should this data be mapped?" from the Connect step. */
  connectInstructions?: string | null;
}

/** Runtime copy of the whitelist, for the unknown-key check. */
export const INTEGRATION_INPUT_KEYS: ReadonlyArray<keyof IntegrationInput> = [
  'name', 'purpose', 'adminBrief', 'sourceKind', 'link', 'tabLabel',
  'frequency', 'runTime', 'dayOfWeek', 'dayOfMonth', 'timezone',
  'changeCapPct', 'blankPolicy',
  'apiConfig', 'filterInstructions', 'connectInstructions',
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
  /** KpiTransform for 'kpi', ContextTransform for 'context', RecordFilter for 'filter'. */
  transform: KpiTransform | ContextTransform | RecordFilter | null;
  coverage: FieldCoverage | null;
  samples: string[];
  newKpi: { kpiKey: string; label: string; unit?: string } | null;
  status: SuggestionStatus;
  reason: string | null;
  /** DEF-362: which remark / instruction this row followed. */
  followed: string | null;
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
    /** DEF-365: the month it is NOW in the integration's zone — required only
     *  by recipe rows (a running month is never computed). The planner reads no clock. */
    now?: { year: number; month: number },
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

// ── DEF-362 MODULE SIGNATURES (Stage 1b, spec §2b) ─────────────────────────

/** sources/docReader.ts — the API document. readApiDocument is the ONLY Stage 1b
 *  module besides the proposer that calls a model (llmRouter, purpose
 *  'integration_doc_read'). */
export interface DocReaderModule {
  /** PDF (pdf-parse) / DOCX (mammoth) / TXT / MD / JSON (OpenAPI) → plain text.
   *  Over integrations.doc_max_bytes or an unsupported type ⇒ IntegrationInputError. */
  extractDocText(buf: Buffer, filename: string, mime: string): Promise<string>;
  /** Credential-looking strings (bearer tokens, JWTs, sk_/ghp_ keys, AIza…,
   *  "api_key: …" values) replaced BEFORE the text is stored or sent to a model. */
  redactSecrets(text: string): { text: string; redactions: number };
  /** Reads the stored (already redacted) api_doc_text with the admin's remarks
   *  and filter words; stores and returns the reading. It never proposes a
   *  secret value. Throws IntegrationNotFoundError / IntegrationInputError
   *  (no document attached). */
  readApiDocument(cn: string, integrationId: string, actorId: number): Promise<ApiDocReading>;
}

/** sources/apiReader.ts — deterministic, model-free (it runs on the execution path). */
export interface ApiReaderModule {
  /** ONE real request (first page only) through guardedFetch. ok only with ≥1
   *  record; sampleRow = exactly one record, flattened; pageRecords and
   *  declaredTotal reported. Never throws for a bad connection — ok:false + reason. */
  testApi(cn: string, integ: ApiSourceRef): Promise<TestResult>;
  /** Every page up to min(pagination.maxPages, integrations.api_max_pages);
   *  records flattened; truncated when a cap stopped it or fewer than the
   *  declared total arrived. Throws on a refused/failed fetch (the run FAILS). */
  readApi(cn: string, integ: ApiSourceRef): Promise<ReadResult>;
  /** Nested JSON → dotted keys with string cells ('' for null/undefined);
   *  arrays of scalars joined with ', ', deeper arrays as JSON. Pure. */
  flattenRecord(rec: unknown): Record<string, string>;
}

/** sources/integrationFetch.ts — THE only way an integration reaches a REST API. */
export interface IntegrationFetchModule {
  /** https only; every resolved address vetted (private / loopback / link-local
   *  / CGNAT / multicast / metadata refused); the socket pinned to the vetted
   *  address; ≤ 3 same-origin redirects, each re-vetted; byte cap and one
   *  deadline. Throws FetchGuardError. Non-2xx statuses are RETURNED, not thrown. */
  guardedFetch(url: string | URL, opts: GuardedFetchOptions): Promise<GuardedResponse>;
  /** Resolve `candidate` (absolute, or relative to `base`) and refuse it unless
   *  its origin is `origin` (vm assertSameOrigin). Throws FetchGuardError('origin'). */
  assertSameOrigin(candidate: string | URL, origin: string, base?: string): URL;
  /** ApiConfig + decrypted secret → where it rides (vm buildAuth). NONE or a
   *  null secret ⇒ nothing attached. */
  buildAuth(cfg: Pick<ApiConfig, 'authScheme' | 'authHeaderName' | 'authQueryParam'>, secret: string | null): AuthAttachment;
  /** behavior integrations.api_max_bytes / api_timeout_ms / api_max_pages. */
  fetchLimits(cn: string): Promise<FetchLimits>;
}

/** store/secretStore.ts — AES-256-GCM, key HKDF-derived from ENCRYPTION_KEY via
 *  the strict decodeMEK; 'v1:<iv>:<tag>:<ct>'. Fails closed. Plaintext is never
 *  logged and never returned by any route. */
export interface SecretStoreModule {
  /** Stores (and clears the connection test — a new credential is a new
   *  connection) unless testFirst fails. Throws IntegrationNotFoundError. */
  setSecret(cn: string, integrationId: string, plain: string, opts?: SetSecretOptions): Promise<SetSecretResult>;
  hasSecret(cn: string, integrationId: string): Promise<boolean>;
  /** null when none is stored. Throws CredentialUnreadableError when the stored
   *  value cannot be decrypted (wrong key, tampered, unknown format) — the
   *  test/run fails with that reason; nothing is retried without a credential. */
  getSecret(cn: string, integrationId: string): Promise<string | null>;
}

/** engine/contextWriter.ts — imports NO AI provider (engine rule). Embedding of
 *  changed pages is queued by the knowledge helper, not called from here. */
export interface ContextWriterModule {
  /** PURE: approved context rows × records ⇒ pages (per_record capped at
   *  integrations.max_context_pages; table ⇒ one page). */
  planContextPages(
    integ: { id: string; name: string },
    records: Record<string, string>[],
    rows: ApprovedContextRow[],
    idField: string | null,
    maxPages: number,
  ): { pages: ContextPagePlan[]; skipped: number; truncated: boolean; anomalies: string[] };
  /** Dry run: change rows only. Live: upsertTenantOrgDoc per changed page +
   *  stale-marking of vanished records + their run-change rows. */
  writeContextPages(
    cn: string,
    integ: { id: string; name: string },
    records: Record<string, string>[],
    rows: ApprovedContextRow[],
    opts: ContextWriteOptions,
  ): Promise<ContextWriteResult>;
}

/** engine/recordFilter.ts — PURE, no I/O, no model. */
export interface RecordFilterModule {
  /** null filter ⇒ every record kept (nothing filters until approved). */
  applyRecordFilter(records: Record<string, string>[], filter: RecordFilter | null): FilterOutcome;
  /** Closed validation of a proposed/approved filter: known ops, value present
   *  where required, ≤ 20 conditions, fields (when given) must exist.
   *  Throws IntegrationInputError. */
  validateRecordFilter(raw: unknown, fields?: string[]): RecordFilter;
}

/** services/knowledge/tenantOrgDoc.ts — the ONE tenant org_doc writer, extracted
 *  from folderScribeService and used by both it and the context writer. */
export interface TenantOrgDocModule {
  /** Upsert by (clientNumber, userId, pageType 'org_doc', title), scope 'tenant'.
   *  metadata.contentHash === contentHash ⇒ untouched, changed:false. */
  upsertTenantOrgDoc(cn: string, doc: {
    userId: number;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
    contentHash: string;
  }): Promise<{ id: string; changed: boolean }>;
}
