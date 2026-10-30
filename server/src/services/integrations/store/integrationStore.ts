/**
 * DEF-354 — Integrations Stage 1: the integration row itself (CRUD, connection
 * test record, derived wizard stage).
 *
 * Spec INTEGRATIONS_DESIGN.md §2.1, §2.2, §2.6. Ported from vm
 * integrationSyncService (create/update/list) and integrationSyncPlanner
 * deriveWizardStage, with the vm defects the port notes list closed here:
 *
 *  - The client can only send the CLOSED whitelist IntegrationInput (vm §9
 *    "permissions are never accepted from the client"). Unknown keys are
 *    REJECTED, not ignored, so `{status:'ACTIVE'}` or `{approvedVersionId}` in a
 *    PUT is a 400 instead of a silent no-op that looks like it worked. vm's PUT
 *    re-stamped activated_at on every save of an ACTIVE row and could swallow a
 *    due slot — status/activation only change through mappingStore.activate/pause.
 *  - The sheet arrives as a link and is parsed here (parseSheetLink); sheetId and
 *    gid are never taken raw. Changing the route (sheet, tab, kind) clears the
 *    connection test, and is refused on an ACTIVE integration: "the tested
 *    connection is the one runs use" (spec §3) — a scheduled run must never read
 *    a sheet nobody tested.
 *  - The wizard stage is DERIVED from facts on every read, never a stored pointer
 *    (vm P:313). Approvals count only on the version that would run (the
 *    approved one, else the latest): approvals on an older version say nothing
 *    about what the next run writes.
 *
 * DEF-362 (Stage 1b, spec §2b):
 *  - The whitelist grows by apiConfig, filterInstructions, connectInstructions.
 *    apiConfig is itself a CLOSED shape (unknown keys refused): no field of it
 *    can carry a credential — a `secret`/`token` key, a user:password in the
 *    base URL or a credential-named query parameter is refused with "use the
 *    credential field". The secret has its own write-only endpoint
 *    (secretStore.setSecret); approved_filter is written only by approval.
 *  - For an api integration "which connection" is api_config (normalised) +
 *    secret_set_at: editing either clears the connection test, exactly like a
 *    new sheet link (vm §9 "the tested connection is the one runs use").
 *  - The DTO carries hasSecret, NEVER the secret or its ciphertext, and never
 *    the document text (only its name and the AI's reading).
 *
 * Tenant rule: `cn` is the first parameter and is in every `where`, even though
 * the Prisma tenant extension would add it — the dispatcher and boot paths run
 * outside a tenant scope, where the extension does nothing.
 */
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { isValidTimezone, resolveUserTimezone } from '../../userTimezoneService';
import { parseSheetLink } from '../sources/sheetLink';
import { readApiConfig, readPagination } from '../sources/apiReader';
import { nextScheduledRun } from '../engine/planner';
import {
  API_METHODS,
  AUTH_SCHEMES,
  BLANK_POLICIES,
  FREQUENCIES,
  INTEGRATION_INPUT_KEYS,
  IntegrationInputError,
  IntegrationNotFoundError,
  SOURCE_KINDS,
  type ApiConfig,
  type ApiDocReading,
  type BlankPolicy,
  type Frequency,
  type GsheetSourceConfig,
  type IntegrationDTO,
  type IntegrationInput,
  type IntegrationStatus,
  type IntegrationStoreModule,
  type RecordFilter,
  type RunStatus,
  type ScheduleConfig,
  type SourceKind,
  type StageFacts,
  type WizardStage,
} from '../types';

const log = createLogger('integrations-store');

const RUN_TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

// ── Input validation (closed whitelist) ───────────────────────────────────

/** `.strict()` is the second line of defence; the explicit key check below runs
 *  first so the message names the offending key in plain words. */
const inputSchema = z.object({
  name: z.string().trim().min(1, 'Give the integration a name.').max(200, 'The name is too long (200 characters at most).'),
  purpose: z.string().max(5000, 'The purpose is too long.').nullable(),
  adminBrief: z.string().max(10000, 'The brief is too long.').nullable(),
  sourceKind: z.enum(SOURCE_KINDS),
  link: z.string().max(2048, 'That link is too long to be a Google Sheet link.'),
  tabLabel: z.string().trim().max(200, 'The tab name is too long.').nullable(),
  frequency: z.enum(FREQUENCIES),
  runTime: z.string().regex(RUN_TIME_RE, 'Run time must be HH:MM (24-hour).'),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  dayOfMonth: z.number().int().refine((d) => d === -1 || (d >= 1 && d <= 31), 'Day of month must be 1–31, or "last day".').nullable(),
  timezone: z.string().max(64),
  changeCapPct: z.number().int().min(1, 'The change limit must be 1–100%.').max(100, 'The change limit must be 1–100%.'),
  blankPolicy: z.enum(BLANK_POLICIES),
  // DEF-362. apiConfig is checked by validateApiConfigInput (closed shape).
  apiConfig: z.unknown(),
  filterInstructions: z.string().max(5000, 'The filter words are too long (5000 characters at most).').nullable(),
  connectInstructions: z.string().max(5000, 'The mapping instructions are too long (5000 characters at most).').nullable(),
}).partial().strict();

// ── API connection input (DEF-362) ────────────────────────────────────────

const API_CONFIG_KEYS = new Set<string>([
  'baseUrl', 'method', 'path', 'query', 'body', 'authScheme', 'authHeaderName', 'authQueryParam',
  'recordsPath', 'idField', 'pagination', 'declaredTotalPath',
]);
/** A query parameter whose NAME says it carries a credential (vm
 *  integrationDocReader's credential-named params). Its value would be stored
 *  in api_config and echoed in every DTO — the key belongs in the secret field,
 *  with authQueryParam naming where it rides. */
const CREDENTIAL_PARAM_RE = /^(api[_-]?key|apikey|key|access[_-]?key|access[_-]?token|token|auth|auth[_-]?token|secret|client[_-]?secret|password|passwd|pwd|sig|signature)$/i;
/** DEF-362 review: the anchored list above misses names that CONTAIN a
 *  credential word ("hapikey", "app_key", "subscription-key",
 *  "consumer_secret") — and body keys were never checked at all (JSON-RPC
 *  APIs such as Odoo carry {"params": {"password": …}}). A name matching
 *  either is refused in query AND body, at any depth. */
const CREDENTIAL_NAME_PART_RE = /(api[_-]?key|apikey|app[_-]?key|subscription[_-]?key|consumer[_-]?(?:key|secret)|access[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|secret|passw(?:or)?d|credential)/i;
const isCredentialName = (k: string): boolean => CREDENTIAL_PARAM_RE.test(k) || CREDENTIAL_NAME_PART_RE.test(k);

/** First credential-named key anywhere in a JSON body, or null. Depth-bounded
 *  (the body is already capped at MAX_API_BODY_CHARS). */
function credentialKeyIn(v: unknown, depth = 0): string | null {
  if (depth > 20 || v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) {
    for (const x of v) { const hit = credentialKeyIn(x, depth + 1); if (hit) return hit; }
    return null;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (isCredentialName(k)) return k;
    const hit = credentialKeyIn(x, depth + 1);
    if (hit) return hit;
  }
  return null;
}
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const PARAM_NAME_RE = /^[A-Za-z0-9_.\-[\]]{1,64}$/;
const MAX_API_BODY_CHARS = 10_000;
const MAX_QUERY_PARAMS = 30;

/** The origin a stored secret is bound to (DEF-362 review), or null. */
function apiOrigin(cfg: ApiConfig): string | null {
  try { return new URL(cfg.baseUrl).origin; } catch { return null; }
}

/**
 * The admin's api_config, as the ONE normalised ApiConfig the readers use, or
 * null (clear it). Throws IntegrationInputError naming the field. Exported for
 * the route and tests.
 */
export function validateApiConfigInput(raw: unknown): ApiConfig | null {
  if (raw === null) return null;
  const bad = (msg: string): never => { throw new IntegrationInputError(msg, 'apiConfig'); };
  if (typeof raw !== 'object' || Array.isArray(raw)) bad('Send the API connection as an object.');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!API_CONFIG_KEYS.has(k)) {
      bad(/secret|token|password|credential|apikey|api_key/i.test(k)
        ? 'The credential is never part of the connection settings — enter it in the credential field.'
        : `"${k}" is not an API connection setting.`);
    }
  }
  if (typeof o.baseUrl !== 'string' || !o.baseUrl.trim()) bad('Give the API base address (https://…).');
  let base: URL;
  try { base = new URL((o.baseUrl as string).trim()); } catch { return bad('The API base address is not a valid web address.'); }
  if (base.protocol !== 'https:') bad('Only https:// API addresses can be used.');
  if (base.username || base.password) bad('Remove the user name / password from the address — enter the credential in the credential field.');
  if (base.search || base.hash) bad('Put query parameters in "query", not in the base address.');
  if (o.method !== undefined && !(API_METHODS as readonly unknown[]).includes(o.method)) bad('Method must be GET or POST.');
  if (o.authScheme !== undefined && !(AUTH_SCHEMES as readonly unknown[]).includes(o.authScheme)) {
    bad('Sign-in must be None, Bearer token, API key or Basic.');
  }
  if (o.path !== undefined && o.path !== null) {
    if (typeof o.path !== 'string' || o.path.length > 500) bad('The endpoint path is invalid.');
    const p = (o.path as string).trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(p)) {
      // A full URL is accepted only on the base address's own origin (spec §2b
      // same-origin rule) — the secret is never sent anywhere else.
      let u: URL;
      try { u = new URL(p); } catch { return bad('The endpoint path is not a valid address.'); }
      if (u.origin !== base.origin) bad('The endpoint must be on the same address as the base address.');
    }
    if (p.includes('?')) bad('Put query parameters in "query", not in the path.');
  }
  if (o.query !== undefined && o.query !== null) {
    if (typeof o.query !== 'object' || Array.isArray(o.query)) bad('"query" must be a list of name → value.');
    const entries = Object.entries(o.query as Record<string, unknown>);
    if (entries.length > MAX_QUERY_PARAMS) bad(`At most ${MAX_QUERY_PARAMS} query parameters.`);
    for (const [k, v] of entries) {
      if (!PARAM_NAME_RE.test(k)) bad(`"${k}" is not a valid parameter name.`);
      if (isCredentialName(k)) {
        bad(`"${k}" looks like a credential parameter — enter the key in the credential field and choose "API key in the URL" with that name.`);
      }
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') bad(`The value of "${k}" must be text.`);
      if (String(v).length > 500) bad(`The value of "${k}" is too long.`);
    }
  }
  if (o.body !== undefined && o.body !== null) {
    if (typeof o.body !== 'object' || Array.isArray(o.body)) bad('The request body must be a JSON object.');
    if (JSON.stringify(o.body).length > MAX_API_BODY_CHARS) bad('The request body is too large.');
    const credKey = credentialKeyIn(o.body);
    if (credKey) bad(`"${credKey}" in the request body looks like a credential — it would be stored and shown in plain text. Enter it in the credential field instead.`);
  }
  for (const k of ['authHeaderName', 'authQueryParam', 'recordsPath', 'idField', 'declaredTotalPath'] as const) {
    const v = o[k];
    if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 200)) bad(`"${k}" is invalid.`);
  }
  if (typeof o.authHeaderName === 'string' && o.authHeaderName.trim() && !HEADER_NAME_RE.test(o.authHeaderName.trim())) {
    bad('The credential header name is invalid.');
  }
  if (/^host$/i.test(String(o.authHeaderName ?? '').trim())) bad('The credential header cannot be "Host".');
  if (typeof o.authQueryParam === 'string' && o.authQueryParam.trim() && !PARAM_NAME_RE.test(o.authQueryParam.trim())) {
    bad('The credential parameter name is invalid.');
  }
  if (o.pagination !== undefined && readPagination(o.pagination) === null) bad('The paging settings are incomplete.');
  if (typeof o.authQueryParam === 'string' && o.query && typeof o.query === 'object'
      && Object.prototype.hasOwnProperty.call(o.query, o.authQueryParam.trim())) {
    bad(`"${o.authQueryParam.trim()}" is where the credential goes — remove it from the fixed query parameters.`);
  }
  // One normal form (apiReader.readApiConfig) — the same function the readers
  // apply on every read, so what is stored, fingerprinted and run is one shape.
  const cfg = readApiConfig({ ...o, baseUrl: `${base.origin}${base.pathname.replace(/\/+$/, '')}` });
  if (!cfg) return bad('The API connection settings are incomplete.');
  return cfg;
}

/**
 * Validate a client payload against the closed whitelist. Throws
 * IntegrationInputError naming the field. Exported for the route and tests.
 */
export function validateIntegrationInput(raw: unknown): IntegrationInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IntegrationInputError('Send the integration settings as an object.');
  }
  const allowed = new Set<string>(INTEGRATION_INPUT_KEYS as readonly string[]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      // vm §9: status, approval, activation, timestamps and the fingerprint are
      // set by the server's own transitions only — never by a client payload.
      throw new IntegrationInputError(`"${key}" cannot be set here.`, key);
    }
  }
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path?.[0] != null ? String(issue.path[0]) : undefined;
    throw new IntegrationInputError(issue?.message || 'Invalid integration settings.', field);
  }
  if (parsed.data.timezone !== undefined && !isValidTimezone(parsed.data.timezone)) {
    throw new IntegrationInputError(`"${parsed.data.timezone}" is not a known time zone.`, 'timezone');
  }
  const out = parsed.data as IntegrationInput;
  if (parsed.data.apiConfig !== undefined) out.apiConfig = validateApiConfigInput(parsed.data.apiConfig);
  for (const k of ['filterInstructions', 'connectInstructions'] as const) {
    // Blank words are no words: stored as null, so "a filter was asked for" is
    // never true for whitespace.
    if (typeof out[k] === 'string' && !out[k]!.trim()) out[k] = null;
  }
  return out;
}

/**
 * Plain-language reasons a schedule cannot run (empty = valid). Used by
 * activation (spec §2.5 "schedule valid") and by edits of an ACTIVE row.
 */
export function scheduleProblems(s: ScheduleConfig, tz: string): string[] {
  const out: string[] = [];
  if (!(FREQUENCIES as readonly string[]).includes(s.frequency)) out.push(`Unknown frequency "${s.frequency}".`);
  if (!RUN_TIME_RE.test(s.runTime)) out.push('Run time must be HH:MM (24-hour).');
  if (s.frequency === 'weekly' && (s.dayOfWeek == null || s.dayOfWeek < 0 || s.dayOfWeek > 6)) {
    out.push('A weekly schedule needs a day of the week.');
  }
  if (s.frequency === 'monthly'
      && (s.dayOfMonth == null || !(s.dayOfMonth === -1 || (s.dayOfMonth >= 1 && s.dayOfMonth <= 31)))) {
    out.push('A monthly schedule needs a day of the month.');
  }
  if (!isValidTimezone(tz)) out.push(`"${tz}" is not a known time zone.`);
  return out;
}

// ── Fingerprint and source config ─────────────────────────────────────────

/** The ONE definition of "which connection" (types.ts). tabLabel and link text
 *  are display only and deliberately excluded: the route is kind + sheet + tab id. */
export const connectionFingerprint: IntegrationStoreModule['connectionFingerprint'] = (sourceKind, cfg) =>
  createHash('sha256').update(`${sourceKind}\n${cfg.sheetId}\n${cfg.gid}`).digest('hex');

/** The stored source_config, or null when no sheet has been set yet. */
export function readSourceConfig(raw: unknown): GsheetSourceConfig | null {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (typeof c.sheetId !== 'string' || !c.sheetId || typeof c.gid !== 'string') return null;
  return {
    sheetId: c.sheetId,
    gid: c.gid,
    link: typeof c.link === 'string' ? c.link : '',
    ...(typeof c.tabLabel === 'string' && c.tabLabel ? { tabLabel: c.tabLabel } : {}),
  };
}

/** Stable JSON: object keys sorted, so the same config always hashes the same. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * DEF-362: "which connection" for an api integration — the normalised
 * api_config AND the instant the credential was set. A new credential is a
 * new connection: the run must never use a secret no test has proven. Only
 * secret_set_at enters the hash, never the secret or its ciphertext.
 */
export function apiConnectionFingerprint(cfg: ApiConfig, secretSetAt: Date | null): string {
  return createHash('sha256')
    .update(`api\n${canonicalJson(cfg)}\n${secretSetAt ? secretSetAt.toISOString() : ''}`)
    .digest('hex');
}

/** The row's connection columns. apiConfig / secretSetAt are REQUIRED in the
 *  type on purpose: a caller that selects only the sheet columns would get
 *  "not connected" for every api integration, so the compiler names it. */
export interface ConnectionColumns {
  sourceKind: string;
  sourceConfig: unknown;
  apiConfig: unknown;
  secretSetAt: Date | null;
}

/** Fingerprint of a row's CURRENT config, or null when it has no usable source. */
export function currentFingerprint(row: ConnectionColumns): string | null {
  if (row.sourceKind === 'api') {
    const cfg = readApiConfig(row.apiConfig);
    return cfg ? apiConnectionFingerprint(cfg, row.secretSetAt ?? null) : null;
  }
  const cfg = readSourceConfig(row.sourceConfig);
  return cfg ? connectionFingerprint(row.sourceKind as SourceKind, cfg) : null;
}

/** The row has a source a reader can use (sheet parsed / api_config valid). */
export function hasUsableSource(row: Pick<ConnectionColumns, 'sourceKind' | 'sourceConfig' | 'apiConfig'>): boolean {
  return row.sourceKind === 'api' ? readApiConfig(row.apiConfig) !== null : readSourceConfig(row.sourceConfig) !== null;
}

/** Tested AND the tested fingerprint is the current config's. */
export function isConnectionOk(row: ConnectionColumns & {
  connectionTestedAt: Date | null; connectionFingerprint: string | null;
}): boolean {
  const fp = currentFingerprint(row);
  return !!(row.connectionTestedAt && fp && row.connectionFingerprint === fp);
}

export function scheduleOf(row: {
  frequency: string; runTime: string; dayOfWeek: number | null; dayOfMonth: number | null;
}): ScheduleConfig {
  return {
    frequency: row.frequency as Frequency,
    runTime: row.runTime,
    dayOfWeek: row.dayOfWeek ?? null,
    dayOfMonth: row.dayOfMonth ?? null,
  };
}

// ── Wizard stage (derived, vm P:313) ──────────────────────────────────────

export const deriveWizardStage: IntegrationStoreModule['deriveWizardStage'] = (f: StageFacts): WizardStage => {
  if (f.status === 'ACTIVE') return { step: 5, label: 'Working', done: true };
  if (f.status === 'PAUSED') return { step: 5, label: 'Paused', done: false };
  if (f.hasSuccessfulDryRun) return { step: 5, label: 'Tested — not turned on', done: false };
  if (f.hasApproval) return { step: 4, label: 'Mapping approved — set a schedule', done: false };
  if (f.hasMapping) return { step: 3, label: 'Review the mapping', done: false };
  if (f.connectionTested) return { step: 3, label: 'Connected — needs a mapping', done: false };
  if (f.hasSource) return { step: 2, label: 'Test the connection', done: false };
  return { step: 1, label: 'Not connected yet', done: false };
};

type SyncRow = Awaited<ReturnType<typeof prisma.integrationSync.findFirst>> & {};

/**
 * Load the stage facts for a batch of integrations of ONE tenant in three
 * queries (not three per row — the list screen polls).
 */
async function loadStageFacts(cn: string, rows: SyncRow[]): Promise<Map<string, StageFacts>> {
  const out = new Map<string, StageFacts>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);

  const versions = await prisma.integrationMappingVersion.findMany({
    where: { clientNumber: cn, integrationId: { in: ids } },
    select: { id: true, integrationId: true, version: true },
    orderBy: { version: 'desc' },
  });
  const latest = new Map<string, string>();
  for (const v of versions) if (!latest.has(v.integrationId)) latest.set(v.integrationId, v.id);

  // The version that would run: the approved one, else the latest proposal.
  const stageVersion = new Map<string, string>();
  for (const r of rows) {
    const v = r.approvedVersionId ?? latest.get(r.id);
    if (v) stageVersion.set(r.id, v);
  }
  const versionIds = [...new Set(stageVersion.values())];

  const approved = versionIds.length === 0 ? [] : await prisma.integrationSuggestion.findMany({
    where: { clientNumber: cn, integrationId: { in: ids }, mappingVersionId: { in: versionIds }, status: 'APPROVED' },
    select: { mappingVersionId: true },
    distinct: ['mappingVersionId'],
  });
  const approvedVersions = new Set(approved.map((a) => a.mappingVersionId));

  const dryRuns = versionIds.length === 0 ? [] : await prisma.integrationRun.findMany({
    where: {
      clientNumber: cn, integrationId: { in: ids }, mappingVersionId: { in: versionIds },
      dryRun: true, status: 'SUCCESS',
    },
    select: { integrationId: true, mappingVersionId: true, connectionFingerprint: true },
    distinct: ['integrationId', 'mappingVersionId', 'connectionFingerprint'],
  });

  for (const r of rows) {
    const v = stageVersion.get(r.id) ?? null;
    const fp = currentFingerprint(r);
    out.set(r.id, {
      status: r.status as IntegrationStatus,
      hasSource: hasUsableSource(r),
      connectionTested: isConnectionOk(r),
      hasMapping: latest.has(r.id),
      hasApproval: v !== null && approvedVersions.has(v),
      // Bound to the same version AND the current connection — the same pair
      // activation checks, so the badge cannot say "tested" when turn-on refuses.
      hasSuccessfulDryRun: v !== null && fp !== null && dryRuns.some(
        (d) => d.integrationId === r.id && d.mappingVersionId === v && d.connectionFingerprint === fp),
    });
  }
  return out;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function toDTO(r: SyncRow, facts: StageFacts): IntegrationDTO {
  return {
    id: r.id,
    name: r.name,
    purpose: r.purpose ?? null,
    adminBrief: r.adminBrief ?? null,
    sourceKind: r.sourceKind as SourceKind,
    sourceConfig: readSourceConfig(r.sourceConfig),
    status: r.status as IntegrationStatus,
    frequency: r.frequency as Frequency,
    runTime: r.runTime,
    dayOfWeek: r.dayOfWeek ?? null,
    dayOfMonth: r.dayOfMonth ?? null,
    timezone: r.timezone,
    changeCapPct: r.changeCapPct,
    blankPolicy: r.blankPolicy as BlankPolicy,
    connectionTestedAt: iso(r.connectionTestedAt),
    connectionOk: facts.connectionTested,
    activatedAt: iso(r.activatedAt),
    approvedVersionId: r.approvedVersionId ?? null,
    nextRunAt: iso(r.nextRunAt),
    lastRunAt: iso(r.lastRunAt),
    lastRunStatus: (r.lastRunStatus as RunStatus | null) ?? null,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    stage: deriveWizardStage(facts),
    // DEF-362. secret_enc and api_doc_text are deliberately NOT mapped: the
    // credential never leaves the server, and the document is only named.
    hasSecret: !!r.secretEnc,
    // DEF-367: only WHETHER the document printed keys — never them, never how many.
    docHasKeys: !!r.apiDocKeysEnc,
    apiDocName: r.apiDocName ?? null,
    apiDocReading: (r.apiDocReading as ApiDocReading | null) ?? null,
    filterInstructions: r.filterInstructions ?? null,
    connectInstructions: r.connectInstructions ?? null,
    apiConfig: r.apiConfig == null ? null : readApiConfig(r.apiConfig),
    approvedFilter: (r.approvedFilter as RecordFilter | null) ?? null,
  };
}

async function findRow(cn: string, id: string): Promise<SyncRow | null> {
  return prisma.integrationSync.findFirst({ where: { id, clientNumber: cn } });
}

async function rowToDTO(cn: string, row: SyncRow): Promise<IntegrationDTO> {
  const facts = await loadStageFacts(cn, [row]);
  return toDTO(row, facts.get(row.id)!);
}

/** P2002 on integration_syncs_tenant_name_key ⇒ a 400 naming the field. */
function rethrowNameClash(err: unknown): never {
  if ((err as { code?: string })?.code === 'P2002') {
    throw new IntegrationInputError('An integration with that name already exists.', 'name');
  }
  throw err;
}

// ── Module functions ──────────────────────────────────────────────────────

export const listIntegrations: IntegrationStoreModule['listIntegrations'] = async (cn) => {
  const rows = await prisma.integrationSync.findMany({
    where: { clientNumber: cn },
    orderBy: { createdAt: 'desc' },
  });
  const facts = await loadStageFacts(cn, rows);
  return rows.map((r) => toDTO(r, facts.get(r.id)!));
};

export const getIntegration: IntegrationStoreModule['getIntegration'] = async (cn, id) => {
  const row = await findRow(cn, id);
  return row ? rowToDTO(cn, row) : null;
};

/** DEF-362: a sheet link on an API integration (or an API connection on a
 *  sheet one) is a client mix-up; refusing it beats storing a route no reader
 *  of that kind will ever use. */
function assertSourceFieldsMatch(kind: string, input: IntegrationInput): void {
  if (kind === 'api' && input.link !== undefined && input.link.trim() !== '') {
    throw new IntegrationInputError('This integration reads an API; a Google Sheet link does not apply.', 'link');
  }
  if (kind !== 'api' && input.apiConfig) {
    throw new IntegrationInputError('This integration reads a Google Sheet; choose "API" as the source first.', 'apiConfig');
  }
}

export const createIntegration: IntegrationStoreModule['createIntegration'] = async (cn, rawInput, actorId) => {
  const input = validateIntegrationInput(rawInput);
  if (!input.name) throw new IntegrationInputError('Give the integration a name.', 'name');
  assertSourceFieldsMatch(input.sourceKind ?? 'gsheet', input);

  let sourceConfig: GsheetSourceConfig | Record<string, never> = {};
  if (input.link) {
    sourceConfig = { ...parseSheetLink(input.link), ...(input.tabLabel ? { tabLabel: input.tabLabel } : {}) };
  }
  // Spec §2.1: the schedule's zone is the creator's, validated — never the
  // server's. resolveUserTimezone already skips invalid values; the check here
  // guards the column against a future change to that fallback chain.
  let timezone = input.timezone;
  if (!timezone) {
    const tz = await resolveUserTimezone(actorId);
    timezone = isValidTimezone(tz) ? tz : 'UTC';
  }

  const row = await prisma.integrationSync.create({
    data: {
      clientNumber: cn,
      name: input.name,
      purpose: input.purpose ?? null,
      adminBrief: input.adminBrief ?? null,
      sourceKind: input.sourceKind ?? 'gsheet',
      sourceConfig: sourceConfig as object,
      status: 'DRAFT', // forced: turning on is mappingStore.activate's job alone
      ...(input.frequency !== undefined ? { frequency: input.frequency } : {}),
      ...(input.runTime !== undefined ? { runTime: input.runTime } : {}),
      dayOfWeek: input.dayOfWeek ?? null,
      dayOfMonth: input.dayOfMonth ?? null,
      timezone,
      ...(input.changeCapPct !== undefined ? { changeCapPct: input.changeCapPct } : {}),
      ...(input.blankPolicy !== undefined ? { blankPolicy: input.blankPolicy } : {}),
      ...(input.apiConfig ? { apiConfig: JSON.parse(JSON.stringify(input.apiConfig)) } : {}),
      filterInstructions: input.filterInstructions ?? null,
      connectInstructions: input.connectInstructions ?? null,
      createdBy: actorId,
    },
  }).catch(rethrowNameClash);
  log.info('integration created', { cn, id: row.id, actorId });
  return rowToDTO(cn, row);
};

export const updateIntegration: IntegrationStoreModule['updateIntegration'] = async (cn, id, rawPatch) => {
  const patch = validateIntegrationInput(rawPatch);
  const row = await findRow(cn, id);
  if (!row) throw new IntegrationNotFoundError(id);

  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.purpose !== undefined) data.purpose = patch.purpose;
  if (patch.adminBrief !== undefined) data.adminBrief = patch.adminBrief;
  if (patch.frequency !== undefined) data.frequency = patch.frequency;
  if (patch.runTime !== undefined) data.runTime = patch.runTime;
  if (patch.dayOfWeek !== undefined) data.dayOfWeek = patch.dayOfWeek;
  if (patch.dayOfMonth !== undefined) data.dayOfMonth = patch.dayOfMonth;
  if (patch.timezone !== undefined) data.timezone = patch.timezone;
  if (patch.changeCapPct !== undefined) data.changeCapPct = patch.changeCapPct;
  if (patch.blankPolicy !== undefined) data.blankPolicy = patch.blankPolicy;
  // DEF-362: the admin's words. They steer the next PROPOSAL only — nothing
  // that runs reads them — so they never clear the connection test.
  if (patch.filterInstructions !== undefined) data.filterInstructions = patch.filterInstructions;
  if (patch.connectInstructions !== undefined) data.connectInstructions = patch.connectInstructions;

  // ── Source: the route may only change with the test cleared ──
  const oldCfg = readSourceConfig(row.sourceConfig);
  const kind = (patch.sourceKind ?? row.sourceKind) as SourceKind;
  assertSourceFieldsMatch(kind, patch);
  let newCfg = oldCfg;
  if (patch.link !== undefined) {
    newCfg = patch.link.trim() === '' ? null : parseSheetLink(patch.link);
    const label = patch.tabLabel !== undefined ? patch.tabLabel : oldCfg?.tabLabel;
    if (newCfg && label) newCfg.tabLabel = label;
  } else if (patch.tabLabel !== undefined && oldCfg) {
    newCfg = { ...oldCfg };
    if (patch.tabLabel) newCfg.tabLabel = patch.tabLabel; else delete newCfg.tabLabel;
  }
  // DEF-362: the api connection. Compared in its normalised form, so a save
  // that changes nothing does not clear a passed test.
  const newApi = patch.apiConfig !== undefined ? patch.apiConfig : row.apiConfig;
  const oldFp = currentFingerprint(row);
  const newFp = currentFingerprint({ sourceKind: kind, sourceConfig: newCfg ?? {}, apiConfig: newApi, secretSetAt: row.secretSetAt });
  const routeChanged = oldFp !== newFp;
  if (patch.sourceKind !== undefined) data.sourceKind = patch.sourceKind;
  if (newCfg !== oldCfg) data.sourceConfig = (newCfg ?? {}) as object;
  if (patch.apiConfig !== undefined) {
    data.apiConfig = patch.apiConfig ? JSON.parse(JSON.stringify(patch.apiConfig)) : Prisma.DbNull;
    // DEF-362 review: the secret is bound to the origin (and sign-in scheme) it
    // was entered for. The fetch guard's "secret only to the configured origin"
    // rule cannot protect it once the configured origin itself moves — e.g. an
    // AI draft lifted from a prompt-injected document re-applied in Connect —
    // so a move drops the stored credential and the admin enters it again for
    // the new host.
    if (row.secretEnc) {
      const before = readApiConfig(row.apiConfig);
      const after = patch.apiConfig;
      if (!before || !after || apiOrigin(before) !== apiOrigin(after) || before.authScheme !== after.authScheme) {
        data.secretEnc = null;
        data.secretSetAt = null;
        log.info('integration secret dropped: api origin or sign-in changed', { cn, id });
      }
    }
  }
  if (routeChanged || (patch.link !== undefined && patch.link.trim() !== (oldCfg?.link ?? ''))) {
    if (row.status === 'ACTIVE') {
      // Spec §3 "the tested connection is the one runs use": an ACTIVE row would
      // read the new, untested source at its next slot. Pause, edit, re-test, turn on.
      throw kind === 'api' || row.sourceKind === 'api'
        ? new IntegrationInputError('Pause this integration before changing its API connection.', 'apiConfig')
        : new IntegrationInputError('Pause this integration before changing its sheet.', 'link');
    }
    data.connectionTestedAt = null;
    data.connectionFingerprint = null;
  }

  // ── Schedule of a running integration: keep it valid and next_run_at honest ──
  const scheduleTouched = ['frequency', 'runTime', 'dayOfWeek', 'dayOfMonth', 'timezone'].some((k) => k in data);
  if (scheduleTouched && row.status === 'ACTIVE') {
    const schedule = scheduleOf({ ...row, ...(data as object) } as typeof row);
    const tz = (data.timezone as string | undefined) ?? row.timezone;
    const problems = scheduleProblems(schedule, tz);
    if (problems.length) throw new IntegrationInputError(problems[0], 'frequency');
    // activated_at is deliberately NOT touched (vm re-stamped it on every save).
    // But slots of the NEW schedule that already passed are not owed: without
    // this, moving a daily 23:00 run to 09:00 at 15:00 made today's 09:00 slot
    // due on the next tick — an unattended write at a time nobody chose.
    const now = new Date();
    data.lastSlotAt = now;
    data.nextRunAt = nextScheduledRun(schedule, now, tz);
  }

  if (Object.keys(data).length === 0) return rowToDTO(cn, row);

  const res = await prisma.integrationSync.updateMany({ where: { id, clientNumber: cn }, data }).catch(rethrowNameClash);
  if (res.count === 0) throw new IntegrationNotFoundError(id);
  const fresh = await findRow(cn, id);
  if (!fresh) throw new IntegrationNotFoundError(id);
  if (routeChanged) log.info('integration source changed; connection test cleared', { cn, id });
  return rowToDTO(cn, fresh);
};

export const deleteIntegration: IntegrationStoreModule['deleteIntegration'] = async (cn, id) => {
  // FK cascade removes versions, suggestions, runs and run changes; KPI
  // definitions it owned are freed (SET NULL); kpi_readings carry no FK and
  // stay (spec §5 q3).
  const res = await prisma.integrationSync.deleteMany({ where: { id, clientNumber: cn } });
  if (res.count === 0) throw new IntegrationNotFoundError(id);
  log.info('integration deleted', { cn, id });
};

export interface RecordTestOptions {
  /**
   * DEF-362: the connection AS TESTED — the sourceKind / sourceConfig /
   * apiConfig the caller read BEFORE starting the (slow, remote) test (an
   * IntegrationDTO has exactly these). The row read below is read AFTER the
   * test, so without this a config edited while the test ran would inherit the
   * pass that the old config earned.
   */
  tested?: { sourceKind: string; sourceConfig: unknown; apiConfig: unknown };
  /** When the test started. A credential stored after it (secret_set_at) was
   *  not the one tested. */
  testStartedAt?: Date;
}

export const recordConnectionTest = async (
  cn: string, id: string, result: Parameters<IntegrationStoreModule['recordConnectionTest']>[2], opts: RecordTestOptions = {},
): Promise<IntegrationDTO> => {
  const row = await findRow(cn, id);
  if (!row) throw new IntegrationNotFoundError(id);
  const fp = currentFingerprint(row);
  const changedDuringTest =
    (opts.tested !== undefined && currentFingerprint({ ...opts.tested, secretSetAt: row.secretSetAt ?? null }) !== fp)
    || (opts.testStartedAt !== undefined && !!row.secretSetAt && row.secretSetAt.getTime() > opts.testStartedAt.getTime());
  if (changedDuringTest) {
    throw new IntegrationInputError('The connection changed while it was being tested. Test it again.',
      row.sourceKind === 'api' ? 'apiConfig' : 'link');
  }
  const ok = result.ok && fp !== null;
  // The WHERE re-checks the config read above, so a link edited between the
  // read and this write cannot inherit a pass that was earned by the old one.
  // DEF-362: for an api row that is api_config AND secret_set_at — a secret
  // replaced mid-test must not inherit the old secret's pass.
  const isApi = row.sourceKind === 'api';
  const guard = isApi
    ? {
      sourceKind: 'api',
      apiConfig: row.apiConfig == null ? { equals: Prisma.AnyNull } : { equals: row.apiConfig as Prisma.InputJsonValue },
      secretSetAt: row.secretSetAt ?? null,
    }
    : { sourceConfig: { equals: (row.sourceConfig ?? {}) as object } };
  const res = await prisma.integrationSync.updateMany({
    where: { id, clientNumber: cn, ...guard },
    data: ok
      ? { connectionTestedAt: new Date(), connectionFingerprint: fp }
      : { connectionTestedAt: null, connectionFingerprint: null },
  });
  if (res.count === 0) {
    throw isApi
      ? new IntegrationInputError('The API connection or its credential changed while it was being tested. Test it again.', 'apiConfig')
      : new IntegrationInputError('The sheet link changed while it was being tested. Test it again.', 'link');
  }
  const fresh = await findRow(cn, id);
  if (!fresh) throw new IntegrationNotFoundError(id);
  return rowToDTO(cn, fresh);
};

/** Module conformance check — a signature drift from types.ts fails tsc here. */
export const integrationStore = {
  listIntegrations, getIntegration, createIntegration, updateIntegration, deleteIntegration,
  deriveWizardStage, recordConnectionTest, connectionFingerprint,
} satisfies IntegrationStoreModule;
