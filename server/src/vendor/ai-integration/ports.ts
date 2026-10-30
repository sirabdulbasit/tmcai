/**
 * Ports — what the host application provides.
 * ===========================================
 *
 * The framework never touches a database, a user table or a goal table
 * directly. Everything it needs from the host comes through these interfaces,
 * so the same code runs in any product: a Postgres app, a Mongo app, a
 * multi-tenant SaaS or a single-company tool.
 *
 * v0.1 ships the decoupled core (sources, mapping, recipes, periods, jobs,
 * network guards). The run engine and the AI mapping proposal (v0.2–0.3) are
 * written against exactly these contracts — see docs/ADAPTERS.md and
 * docs/ROADMAP.md.
 *
 * Every method takes the tenant explicitly. A single-tenant host passes a
 * constant; a multi-tenant host MUST bind every query to it — the framework
 * never infers a tenant from a record.
 */
import type { LlmProvider, ChatResponse } from './ai/llmProvider';

export type TenantId = string | number;

/* ── the integration itself ──────────────────────────────────────────────── */

export type SourceMode = 'api' | 'file';
export type AuthType = 'NONE' | 'BEARER' | 'BASIC' | 'API_KEY' | 'OAUTH2';
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'once';
export type IntegrationStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED';

/** One connected external system, as the host stores it. */
export interface IntegrationRecord {
  id: string | number;
  tenantId: TenantId;
  name: string;
  /** What the administrator wants, in their own words — the AI's brief. */
  brief: string | null;
  /** What it may update — a host-defined target kind (e.g. 'metrics', 'people'). */
  target: string;
  sourceMode: SourceMode;
  baseUrl: string | null;
  authType: AuthType;
  /** Non-secret connection details: probe route, file source, sheet link, header name… */
  authExtra: Record<string, unknown> | null;
  /** Per-source-field notes the administrator wrote for the AI. */
  fieldRemarks: Record<string, string>;
  status: IntegrationStatus;
  frequency: Frequency;
  /** Scheduled runs abort above this share of changed records (0–100). */
  changeCapPct: number;
}

/** One proposal of how the source maps — immutable once written; approval points at one version. */
export interface MappingVersion {
  version: number;
  status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED';
  /** Connector, field map, recipes, recognised targets — the AI's proposal, verified by code. */
  spec: Record<string, unknown>;
  createdAt: Date;
}

/** Persistence. The host owns the schema; docs/ADAPTERS.md has a reference Postgres layout. */
export interface IntegrationStore {
  get(tenant: TenantId, id: IntegrationRecord['id']): Promise<IntegrationRecord | null>;
  update(tenant: TenantId, id: IntegrationRecord['id'], patch: Partial<IntegrationRecord>): Promise<void>;

  /** The credential, decrypted — server-side only, never returned to a browser. */
  getSecret(tenant: TenantId, id: IntegrationRecord['id']): Promise<string | null>;
  /** Encrypt and store. Must FAIL LOUDLY when the encryption key is missing — never store plaintext. */
  setSecret(tenant: TenantId, id: IntegrationRecord['id'], secret: string): Promise<void>;
  clearSecret(tenant: TenantId, id: IntegrationRecord['id']): Promise<void>;

  saveMapping(tenant: TenantId, id: IntegrationRecord['id'], spec: Record<string, unknown>): Promise<MappingVersion>;
  getMapping(tenant: TenantId, id: IntegrationRecord['id'], version: number): Promise<MappingVersion | null>;
  /** The single APPROVED version — the only one a live run may execute. */
  getApprovedMapping(tenant: TenantId, id: IntegrationRecord['id']): Promise<MappingVersion | null>;
  approveMapping(tenant: TenantId, id: IntegrationRecord['id'], version: number, by: string): Promise<void>;

  /** A run's audit row: started, then finished with counts. Written after the writes, never from the plan. */
  startRun(tenant: TenantId, id: IntegrationRecord['id'], info: { dryRun: boolean; mappingVersion: number; triggeredBy: string }): Promise<string | number>;
  finishRun(tenant: TenantId, runId: string | number, outcome: RunOutcome): Promise<void>;
  /** One row per value actually written (failures excluded). */
  logChange(tenant: TenantId, runId: string | number, change: ChangeRecord): Promise<void>;
}

export interface RunOutcome {
  status: 'SUCCESS' | 'FAILED' | 'ABORTED';
  recordsRead: number;
  matched: number;
  written: number;
  skipped: number;
  blanks: number;
  anomalies: string[];
  error?: string;
}

export interface ChangeRecord {
  targetKind: string;
  targetId: string | number;
  period: string | null;
  field: string;
  before: string | null;
  after: string | null;
  personId?: string | number | null;
}

/* ── people: who a record is about ──────────────────────────────────────── */

export interface Person {
  id: string | number;
  email: string | null;
  code: string | null;
  name: string | null;
  /** Only 'active' people are written for; others are found and skipped, never re-created. */
  standing: 'active' | 'inactive' | 'deleted';
  managerId?: string | number | null;
}

export interface PeopleDirectory {
  /** Match a source identity (email or code, as the host's match rule says). Never by name. */
  findByIdentity(tenant: TenantId, identity: string): Promise<Person | null>;
  /** Everyone's identities, for measuring which source column identifies people best. */
  listIdentities(tenant: TenantId): Promise<Array<{ email: string | null; code: string | null }>>;
  /** manager → direct reports, for team-population recipes. */
  reportingLines(tenant: TenantId): Promise<Map<string | number, Array<string | number>>>;
}

/* ── targets: what the figures land on ──────────────────────────────────── */

/** Anything a figure can be written to: a goal, a KPI, a key result, a budget line. */
export interface Target {
  kind: string;
  id: string | number;
  title: string;
  ownerId: string | number | null;
  unit: string | null;
  /** 'monthly' | 'quarterly' | 'bi-annual' | 'annual' — the target's own periods. */
  frequency: string | null;
  /** Only targets set to take their figure from an integration are written. */
  integrationDriven: boolean;
  approved: boolean;
}

export interface TargetCatalog {
  /** The targets an integration may consider (current period / year). */
  list(tenant: TenantId): Promise<Target[]>;
}

export interface TargetWriter {
  /**
   * Write the changed periods of one target and recompute whatever the host
   * derives from them (totals, status, roll-ups). Called only for approved,
   * integration-driven targets, only with ended periods, never with blanks.
   */
  writePeriods(tenant: TenantId, target: Pick<Target, 'kind' | 'id'>, cells: Array<{ seq: number; label: string; frequency: string; value: number; before: number | null }>, author: string): Promise<void>;
}

/* ── AI ──────────────────────────────────────────────────────────────────── */

export interface AiProviderSource {
  /** The provider for this tenant, or null when AI is not configured (the pipeline then stops with a message). */
  forTenant(tenant: TenantId): Promise<LlmProvider | null>;
}

export interface SpendRecorder {
  /** Every model call is attributed: which tenant, which step (doc reading, mapping, recipes, recognition, run). */
  record(tenant: TenantId, step: string, reply: ChatResponse, actor: string | null): Promise<void>;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Everything the engine (v0.2) needs, wired once by the host. */
export interface IntegrationHost {
  store: IntegrationStore;
  people: PeopleDirectory;
  targets: TargetCatalog;
  writer: TargetWriter;
  ai: AiProviderSource;
  spend: SpendRecorder;
  log: Logger;
}
