/**
 * DEF-354 — Integrations Stage 1: one run of one integration (spec
 * INTEGRATIONS_DESIGN.md §2.4, steps 1–8, in that order).
 *
 * Ported from vm integrationSyncEngine.runIntegration, with the vm defects the
 * port notes list closed here:
 *
 *  - No model on the execution path (vm D1 called a provider mid-run). This
 *    file, and everything under engine/, imports no AI provider — test-pinned.
 *  - The run row IS the mutex: the partial unique index
 *    `integration_runs_one_running` refuses a second RUNNING row (P2002 ⇒
 *    RunBusyError). vm read "is the latest row RUNNING?", which races.
 *  - Every failure after the row exists is a FAILED/ABORTED row, never a throw
 *    with no record (vm's pre-run throws made the scheduler retry every 60 s).
 *  - Nothing is written before the change-cap decision (vm D2 wrote quarantine
 *    and recipe rows, then aborted). A dry run writes only bookkeeping: its run
 *    row and preview change rows.
 *  - A live run writes ALL its readings and their change rows in ONE
 *    transaction (vm §9 "a failed run records no measurement"; AGENTS §2.6 "no
 *    mutation without its ledger"; critique #19 rejected per-batch commits).
 *    The change rows are the OUTCOME — built from what the upsert RETURNED, so
 *    a value the database found unchanged is not recorded as a change.
 *  - Approval is version-scoped and computed when the run starts (vm §8 "a
 *    computed value must not also be settable"): only APPROVED rows of the
 *    run's version are read. A live run uses approved_version_id, nothing else.
 *
 * DEF-362 (Stage 1b, spec §2b) adds, in this order after the read:
 *  - the APPROVED record filter is applied BEFORE planning (nothing filters
 *    until approved; a filter naming a field the data lacks FAILS the run);
 *  - approved Context rows of the run's version are planned alongside the KPI
 *    rows (engine/contextWriter.ts); a dry run previews them as change rows and
 *    touches no wiki page; the change cap counts page rewrites (updates and
 *    stale marks) like reading rewrites;
 *  - a live run writes the pages AFTER the KPI transaction commits — pages go
 *    through the shared knowledge helper and cannot join that SQL transaction,
 *    so each page records its change row right after its own write.
 *
 * Tenant rule: `cn` is in every where and every raw statement — the dispatcher
 * and boot sweep run outside a tenant scope, where the Prisma extension adds
 * nothing.
 */
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { runWithoutTenant } from '../../../db/tenantContext';
import { readSource, sourceProblem } from '../sources';
import { currentFingerprint, isConnectionOk, scheduleOf } from '../store/integrationStore';
import {
  applyContextDiff,
  contextFieldsRead,
  contextRewrites,
  diffContextPages,
  loadStoredContextPages,
  bareKeyOwner,
  maxContextPages,
  planContextPages,
  previewNote,
  readContextTransform,
  type ContextDiff,
  type ContextPlanResult,
} from './contextWriter';
import { applyRecordFilter, validateRecordFilter } from './recordFilter';
import {
  IntegrationInputError,
  IntegrationNotFoundError,
  RunBusyError,
  type ApprovedContextRow,
  type ApprovedKpiRow,
  type BlankPolicy,
  type CapVerdict,
  type EngineResult,
  type ExistingReadings,
  type KpiTransform,
  type PlannedReading,
  type RecordFilter,
  type RunCounts,
  type RunEngineModule,
  type RunOptions,
} from '../types';
import { MAX_CHANGE_PCT, changeCapVerdict, monthIn, nextScheduledRun, parseNumber, parsePeriod, planKpiReadings, readingKey, type PlannerKpiDef } from './planner';
import { readKpiRecipe, recipeTransformFields } from './kpiRecipe';

const log = createLogger('integrations-run');

/** Rows per upsert statement inside the one transaction (bind-parameter size). */
const WRITE_CHUNK = 1000;
/** The live transaction may hold up to max_rows readings; Prisma's 5 s default
 *  interactive-transaction timeout would fail a large first load. */
const TX_TIMEOUT_MS = 120_000;
const TX_MAX_WAIT_MS = 10_000;

export const INTERRUPTED_BY_RESTART = 'interrupted by server restart';

type FinalStatus = EngineResult['status'];

const ZERO_COUNTS: RunCounts = {
  recordsRead: 0, filteredOut: 0, skipped: 0, setAside: 0, blanks: 0, subjectsAffected: 0, writes: 0,
};
const NO_CAP: CapVerdict = { wouldTrip: false, pct: 0, cap: 0 };

/** A stored transform, or null when it is not one this engine can execute. */
export function readTransform(raw: unknown): KpiTransform | null {
  const t = (raw ?? {}) as Record<string, unknown>;
  const dim = typeof t.dimensionField === 'string' && t.dimensionField ? t.dimensionField : undefined;
  if (t.mode === 'long' && typeof t.valueField === 'string' && t.valueField
      && typeof t.periodField === 'string' && t.periodField) {
    return { mode: 'long', valueField: t.valueField, periodField: t.periodField, ...(dim ? { dimensionField: dim } : {}) };
  }
  if (t.mode === 'wide' && Array.isArray(t.columns) && t.columns.length > 0
      && t.columns.every((c) => typeof c === 'string' && c) && t.periodFrom === 'header') {
    return { mode: 'wide', columns: t.columns as string[], periodFrom: 'header', ...(dim ? { dimensionField: dim } : {}) };
  }
  if (t.mode === 'recipe') {
    // DEF-365: re-checked on the way out of the database (the header check
    // against the live source runs below, through fieldsRead).
    const recipe = readKpiRecipe(t.recipe);
    if (typeof recipe === 'string') return null;
    return { mode: 'recipe', recipe, ...(dim ? { dimensionField: dim } : {}) };
  }
  return null;
}

/** Every sheet column an approved row reads — the header check's list. */
export function fieldsRead(t: KpiTransform): string[] {
  if (t.mode === 'recipe') return recipeTransformFields(t);
  const own = t.mode === 'long' ? [t.valueField, t.periodField] : [...t.columns];
  return t.dimensionField ? [...own, t.dimensionField] : own;
}

/** apiConfig.idField (DEF-362) — the field that identifies a record for
 *  Context pages; null for a Google Sheet (the writer then keys by title). */
export function apiIdField(raw: unknown): string | null {
  const v = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>).idField : null);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Errors whose message is written for the admin. Anything else (Prisma, the
 *  driver, a bug) may carry file paths, the DB host or SQL: it is logged in
 *  full and the run records a plain sentence instead. */
const ADMIN_FACING_CODES = new Set(['GSHEET_READ', 'CREDENTIAL_UNREADABLE', 'INTEGRATION_INPUT', 'INTEGRATION_NOT_FOUND']);
export function adminText(err: unknown, fallback: string, ctx: Record<string, unknown> = {}): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e && typeof e.code === 'string' && ADMIN_FACING_CODES.has(e.code) && typeof e.message === 'string') return e.message;
  log.error('integration run internal error', { ...ctx, error: errText(err) });
  return fallback;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** DEF-362: what the run did (or, dry, would do) to knowledge pages. Rides
 *  in the stored run result next to the Stage 1 counts. */
export interface ContextRunSummary {
  created: number;
  updated: number;
  unchanged: number;
  stale: number;
  skipped: number;
  failed: number;
  truncated: boolean;
}

/** `readComplete` (DEF-362 review): false when the read itself fell short
 *  (row/page/byte limit, fewer than the declared total). Turn-on accepts a
 *  PARTIAL dry run only when the read was complete and the one shortfall was
 *  the Context page cap — a limit every live run applies the same way. */
export type EngineResultWithContext = EngineResult & { context?: ContextRunSummary; readComplete?: boolean };

interface Outcome {
  status: FinalStatus;
  counts: RunCounts;
  capVerdict: CapVerdict;
  anomalies: string[];
  error?: string;
  context?: ContextRunSummary;
  readComplete?: boolean;
}

/**
 * Closes the run row (and, for live runs, stamps the integration's last run).
 * `db` is the transaction client when the close must commit with the writes.
 * Its own failure is logged, not thrown: the run's outcome already happened,
 * and the boot sweep closes a row left RUNNING.
 */
/** The two delegates finishRun writes through: the client, or a transaction. */
type CloseDb = {
  integrationRun: { updateMany: (args: any) => Promise<unknown> };
  integrationSync: { updateMany: (args: any) => Promise<unknown> };
};

async function finishRun(
  db: CloseDb,
  cn: string,
  integrationId: string,
  runId: string,
  dryRun: boolean,
  o: Outcome,
  integ: { status: string; frequency: string; runTime: string; dayOfWeek: number | null; dayOfMonth: number | null; timezone: string } | null,
): Promise<EngineResult> {
  const result: EngineResultWithContext = {
    runId, dryRun, status: o.status, changePercent: o.capVerdict.pct, capVerdict: o.capVerdict,
    anomalies: o.anomalies, ...o.counts, ...(o.error ? { error: o.error } : {}),
    ...(o.context ? { context: o.context } : {}),
    ...(o.readComplete !== undefined ? { readComplete: o.readComplete } : {}),
  };
  const now = new Date();
  await db.integrationRun.updateMany({
    where: { id: runId, clientNumber: cn, integrationId },
    data: {
      status: o.status,
      recordsRead: o.counts.recordsRead,
      recordsFiltered: o.counts.filteredOut,
      subjectsAffected: o.counts.subjectsAffected,
      writes: o.counts.writes,
      skipped: o.counts.skipped,
      setAside: o.counts.setAside,
      blanks: o.counts.blanks,
      changePercent: Math.min(o.capVerdict.pct, MAX_CHANGE_PCT),
      result: result as unknown as object,
      errorMessage: o.error ?? null,
      finishedAt: now,
    },
  });
  // A dry run never stamps last_run_*: it is not the integration running.
  if (!dryRun) {
    let nextRunAt: Date | null | undefined;
    if (integ?.status === 'ACTIVE') {
      try { nextRunAt = nextScheduledRun(scheduleOf(integ), now, integ.timezone); } catch { nextRunAt = undefined; }
    }
    await db.integrationSync.updateMany({
      where: { id: integrationId, clientNumber: cn },
      data: { lastRunAt: now, lastRunStatus: o.status, ...(nextRunAt !== undefined ? { nextRunAt } : {}) },
    });
  }
  return result;
}

async function safeFinish(...args: Parameters<typeof finishRun>): Promise<EngineResult> {
  try {
    return await finishRun(...args);
  } catch (err) {
    const [, cn, integrationId, runId, dryRun, o] = args;
    log.error('integration run could not be closed', { clientNumber: cn, integrationId, runId, error: errText(err) });
    // Minimal close: the RUNNING row is the integration's mutex, so it must
    // not be left held until a restart because the full close failed.
    try {
      await prisma.integrationRun.updateMany({
        where: { id: runId, clientNumber: cn, integrationId, status: 'RUNNING' },
        data: { status: o.status, errorMessage: o.error ?? null, finishedAt: new Date() },
      });
    } catch (err2) {
      log.error('integration run minimal close failed', { clientNumber: cn, integrationId, runId, error: errText(err2) });
    }
    return {
      runId, dryRun, status: o.status, changePercent: o.capVerdict.pct, capVerdict: o.capVerdict,
      anomalies: o.anomalies, ...o.counts, ...(o.error ? { error: o.error } : {}),
    };
  }
}

/** Existing values for the KPIs this run plans, keyed by ReadingKey, canonical. */
async function loadExisting(cn: string, kpiKeys: string[]): Promise<ExistingReadings> {
  const rows = await prisma.kpiReading.findMany({
    where: { clientNumber: cn, kpiKey: { in: kpiKeys } },
    select: { kpiKey: true, periodStart: true, dimensionKey: true, value: true },
  });
  const out: ExistingReadings = new Map();
  for (const r of rows) {
    const period = r.periodStart.toISOString().slice(0, 10); // DATE ⇒ UTC midnight
    const v = String(r.value);
    out.set(readingKey(r.kpiKey, period, r.dimensionKey), parseNumber(v) ?? v);
  }
  return out;
}

interface WrittenRow { kpi_key: string; period_start: string; dimension_key: string; inserted: boolean }

/**
 * The live write: every reading and its change row, ONE transaction. The
 * upsert's WHERE keeps an identical value from being rewritten, and RETURNING
 * reports exactly the rows that changed — those, and only those, get a change
 * row. Any error rolls everything back.
 */
async function writeReadings<R>(
  cn: string, integrationId: string, runId: string,
  readings: PlannedReading[], labels: Map<string, string>,
  closeInTx: (tx: CloseDb, writes: number) => Promise<R>,
): Promise<R> {
  const byKey = new Map(readings.map((r) => [readingKey(r.kpiKey, r.periodStart, r.dimensionKey), r]));
  return prisma.$transaction(async (tx) => {
    let writes = 0;
    for (let i = 0; i < readings.length; i += WRITE_CHUNK) {
      const chunk = readings.slice(i, i + WRITE_CHUNK);
      const rows = await tx.$queryRaw<WrittenRow[]>`
        INSERT INTO kpi_readings (client_number, kpi_key, period_start, dimension_key, value, integration_id, run_id, written_at)
        SELECT ${cn}, t.k, t.p::date, t.d, t.v::numeric, ${integrationId}, ${runId}, NOW()
        FROM unnest(${chunk.map((r) => r.kpiKey)}::text[], ${chunk.map((r) => r.periodStart)}::text[],
                    ${chunk.map((r) => r.dimensionKey)}::text[], ${chunk.map((r) => r.value)}::text[]) AS t(k, p, d, v)
        ON CONFLICT (client_number, kpi_key, period_start, dimension_key) DO UPDATE
          SET value = EXCLUDED.value, integration_id = EXCLUDED.integration_id,
              run_id = EXCLUDED.run_id, written_at = EXCLUDED.written_at
          WHERE kpi_readings.value IS DISTINCT FROM EXCLUDED.value
        RETURNING kpi_key, to_char(period_start, 'YYYY-MM-DD') AS period_start, dimension_key, (xmax = 0) AS inserted`;
      const changes = rows.map((w) => {
        const k = readingKey(w.kpi_key, w.period_start, w.dimension_key);
        const planned = byKey.get(k);
        return {
          clientNumber: cn, integrationId, runId, targetKind: 'kpi',
          op: w.inserted ? 'create' : 'update',
          subjectKey: k,
          subjectLabel: labels.get(k) ?? null,
          targetKey: `kpi:${w.kpi_key}`,
          sourceKey: planned ? clip(planned.sourceKey, 255) : null,
          beforeValue: w.inserted ? null : (planned?.before ?? null),
          afterValue: planned?.value ?? null,
        };
      });
      if (changes.length) await tx.integrationRunChange.createMany({ data: changes });
      writes += rows.length;
    }
    // The run's close commits WITH the readings: a close that fails rolls the
    // readings back, so a run row never says FAILED/RUNNING over committed data.
    // (DEF-362: a run that also writes knowledge pages closes after them, so
    // its callback only returns the write count — see runIntegration.)
    return closeInTx(tx as unknown as CloseDb, writes);
  }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS });
}

function labelFor(r: PlannedReading, defLabel: string | undefined): string {
  const dim = r.dimensionKey ? ` · ${r.dimensionKey}` : '';
  return clip(`${defLabel ?? r.kpiKey} · ${r.periodStart}${dim}`, 255);
}

function changeRowsFor(cn: string, integrationId: string, runId: string,
  readings: PlannedReading[], labels: Map<string, string>) {
  return readings.map((r) => {
    const k = readingKey(r.kpiKey, r.periodStart, r.dimensionKey);
    return {
      clientNumber: cn, integrationId, runId, targetKind: 'kpi',
      op: r.before === null ? 'create' : 'update',
      subjectKey: k,
      subjectLabel: labels.get(k) ?? null,
      targetKey: `kpi:${r.kpiKey}`,
      sourceKey: clip(r.sourceKey, 255),
      beforeValue: r.before,
      afterValue: r.value,
    };
  });
}

export const runIntegration: RunEngineModule['runIntegration'] = async (cn, id, opts: RunOptions) => {
  // Step 1 — the integration, in this tenant only.
  const integ = await prisma.integrationSync.findFirst({ where: { id, clientNumber: cn } });
  if (!integ) throw new IntegrationNotFoundError(id);

  // Which version runs. A live run executes the APPROVED version and nothing
  // else; a different versionId is a client error, refused before any row.
  let versionId: string | null;
  if (!opts.dryRun) {
    if (opts.versionId && opts.versionId !== integ.approvedVersionId) {
      throw new IntegrationInputError('A live run always uses the approved mapping version; it cannot run a different one.', 'versionId');
    }
    versionId = integ.approvedVersionId;
  } else if (opts.versionId) {
    const v = await prisma.integrationMappingVersion.findFirst({
      where: { id: opts.versionId, clientNumber: cn, integrationId: id }, select: { id: true },
    });
    if (!v) throw new IntegrationInputError(`Mapping version ${opts.versionId} does not belong to this integration.`, 'versionId');
    versionId = v.id;
  } else {
    const latest = await prisma.integrationMappingVersion.findFirst({
      where: { clientNumber: cn, integrationId: id }, orderBy: { version: 'desc' }, select: { id: true },
    });
    versionId = latest?.id ?? null;
  }

  // Step 2 — the run row is the mutex.
  let runId: string;
  try {
    const row = await prisma.integrationRun.create({
      data: {
        clientNumber: cn,
        integrationId: id,
        mappingVersionId: versionId,
        connectionFingerprint: currentFingerprint(integ),
        dryRun: opts.dryRun,
        trigger: opts.trigger,
        triggeredBy: opts.triggeredBy,
        status: 'RUNNING',
      },
      select: { id: true },
    });
    runId = row.id;
  } catch (err) {
    if (isUniqueViolation(err)) throw new RunBusyError(id);
    throw err;
  }
  opts.onStarted?.(runId);
  const t0 = Date.now();

  const counts: RunCounts = { ...ZERO_COUNTS };
  const anomalies: string[] = [];
  let contextSummary: ContextRunSummary | undefined;
  let readComplete: boolean | undefined;
  const close = (status: FinalStatus, extra: { error?: string; capVerdict?: CapVerdict } = {}) =>
    safeFinish(prisma, cn, id, runId, opts.dryRun, {
      status, counts, capVerdict: extra.capVerdict ?? { ...NO_CAP, cap: integ.changeCapPct },
      anomalies, ...(extra.error ? { error: extra.error } : {}),
      ...(contextSummary ? { context: contextSummary } : {}),
      ...(readComplete !== undefined ? { readComplete } : {}),
    }, integ);
  const fail = (error: string) => {
    log.warn('integration run failed', { clientNumber: cn, integrationId: id, runId, dryRun: opts.dryRun, error });
    return close('FAILED', { error });
  };

  try {
    if (!versionId) {
      return await fail(opts.dryRun
        ? 'There is no mapping to try yet — suggest a mapping first.'
        : 'This integration has no approved mapping — turn it on first.');
    }
    // DEF-362: the source router dispatches gsheet | api; a half-set-up source
    // fails here with what is missing, before any read.
    const problem = sourceProblem(integ);
    if (problem) {
      return await fail(integ.sourceKind !== 'api' && integ.sourceKind !== 'file' ? 'No Google Sheet is connected to this integration.' : problem.message);
    }
    // "The tested connection is the one runs use" (spec §3): a live write never
    // reads a sheet that has not passed its test since it was last changed.
    if (!opts.dryRun && !isConnectionOk(integ)) {
      return await fail(integ.sourceKind === 'file'
        ? 'The file connection has not passed its test since the file or its tab last changed — test the connection first.'
        : 'The sheet connection has not passed its test since it was last changed — test the connection first.');
    }

    // Approved rows of THIS version only, computed now (never stored).
    // DEF-362: KPI and Context rows both run; the filter row is applied below.
    const suggestionRows = await prisma.integrationSuggestion.findMany({
      where: { clientNumber: cn, integrationId: id, mappingVersionId: versionId, status: 'APPROVED', targetKind: { in: ['kpi', 'context', 'filter'] } },
      select: { id: true, sourceField: true, targetKey: true, transform: true, targetKind: true },
      // DEF-362 review: rows of one version are inserted by one createMany and
      // share created_at, so createdAt alone is no order at all. Context page
      // identity must not depend on it (contextWriter assigns keys by content,
      // not position); the tie-breakers keep everything else deterministic too.
      orderBy: [{ createdAt: 'asc' }, { sourceField: 'asc' }, { targetKey: 'asc' }, { id: 'asc' }],
    });
    counts.setAside = await prisma.integrationSuggestion.count({
      where: { clientNumber: cn, integrationId: id, mappingVersionId: versionId, status: 'SET_ASIDE' },
    });
    const kpiSuggestions = suggestionRows.filter((s) => (s.targetKind ?? 'kpi') === 'kpi');
    const contextSuggestions = suggestionRows.filter((s) => s.targetKind === 'context');
    const filterSuggestion = suggestionRows.find((s) => s.targetKind === 'filter') ?? null;
    if (kpiSuggestions.length === 0 && contextSuggestions.length === 0) {
      return await fail('No field of this mapping version is approved, so there is nothing to run.');
    }
    const approvedContext: ApprovedContextRow[] = [];
    for (const s of contextSuggestions) {
      const transform = readContextTransform(s.transform);
      if (!transform || (s.targetKey !== 'context:per_record' && s.targetKey !== 'context:table')
          || (s.targetKey === 'context:per_record') !== (transform.mode === 'per_record')) {
        return await fail(`The approved Context row "${s.sourceField}" has no usable layout (${s.targetKey}); propose the mapping again.`);
      }
      approvedContext.push({ suggestionId: s.id, targetKey: s.targetKey, transform });
    }
    // The filter: integration.approved_filter, written only by approving a
    // filter row (vm §9 "approval is the only write permission"). A dry run
    // previews its own version: ONLY that version's APPROVED filter row, and no
    // filter when it has none — never integration.approved_filter, which is the
    // RUNNING version's. Falling back to it (DEF-362 review) let a version that
    // withdrew the filter be previewed filtered, then run live unfiltered after
    // turn-on (activate writes approved_filter from the version's own row).
    let filter: RecordFilter | null = null;
    const rawFilter = opts.dryRun ? (filterSuggestion?.transform ?? null) : integ.approvedFilter;
    if (rawFilter != null) {
      try {
        filter = validateRecordFilter(rawFilter);
      } catch (err) {
        return await fail(`The approved filter cannot be used: ${errText(err)} Propose the mapping again.`);
      }
    }
    const approved: ApprovedKpiRow[] = [];
    for (const s of kpiSuggestions) {
      const transform = readTransform(s.transform);
      if (!transform || !s.targetKey.startsWith('kpi:')) {
        return await fail(`The approved field "${s.sourceField}" has no usable layout (${s.targetKey}); propose the mapping again.`);
      }
      approved.push({ suggestionId: s.id, sourceField: s.sourceField, targetKey: s.targetKey as `kpi:${string}`, transform });
    }

    // Step 3 — read, then the header check.
    let read;
    try {
      read = await readSource(cn, integ);
    } catch (err) {
      return await fail(`The ${integ.sourceKind === 'api' ? 'API' : integ.sourceKind === 'file' ? 'file' : 'sheet'} could not be read: ${adminText(err, 'the read failed unexpectedly. Try again in a few minutes.', { clientNumber: cn, integrationId: id, runId })}`);
    }
    counts.recordsRead = read.rowCount;
    readComplete = !read.truncated;
    anomalies.push(...read.anomalies);
    if (read.truncated) anomalies.push(read.truncatedReason ?? 'Only part of the sheet was read.');
    const headers = new Set(read.headers);
    const missing = [...new Set(approved.flatMap((r) => fieldsRead(r.transform)))].filter((f) => !headers.has(f));
    if (missing.length) {
      return await fail(`The sheet no longer has the column(s) ${missing.map((m) => `"${m}"`).join(', ')} that the approved mapping reads.`);
    }
    // DEF-362: Context fields are read like KPI columns — gone ⇒ the run fails
    // (an unconfigured target fails the run), never a page of blanks.
    const missingCtx = [...new Set(approvedContext.flatMap((r) => contextFieldsRead(r.transform)))].filter((f) => !headers.has(f));
    if (missingCtx.length) {
      return await fail(`The data no longer has the field(s) ${missingCtx.map((m) => `"${m}"`).join(', ')} that the approved Context mapping reads.`);
    }

    // DEF-362: the APPROVED filter, BEFORE planning — filtered-out records
    // never reach a KPI or a page, and are counted.
    let records = read.records;
    if (filter) {
      const missingF = [...new Set(filter.conditions.map((c) => c.field))].filter((f) => !headers.has(f));
      if (missingF.length) {
        return await fail(`The data no longer has the field(s) ${missingF.map((m) => `"${m}"`).join(', ')} that the approved filter reads.`);
      }
      const fo = applyRecordFilter(records, filter);
      if (fo.problems.length) return await fail(fo.problems.join(' '));
      records = fo.kept;
      counts.filteredOut = fo.filteredOut;
    }
    // Wide layout: the approved row reads a FIXED list of period columns. A
    // month column added since approval is not read — say so on every run, so
    // a run is never a quiet "No changes" while new months sit unread.
    if (approved.some((r) => r.transform.mode === 'wide')) {
      const covered = new Set(approved.flatMap((r) => fieldsRead(r.transform)));
      const unread = read.headers.filter((h) => !covered.has(h) && parsePeriod(h) !== null);
      if (unread.length) {
        const shown = unread.slice(0, 6).map((h) => `"${h}"`).join(', ');
        anomalies.push(`The sheet has ${unread.length} period column(s) the approved mapping does not read (${shown}${unread.length > 6 ? ', …' : ''}) — `
          + 'their numbers were NOT imported. Ask for a new proposal (it keeps what is already approved) to add them.');
      }
    }

    // Step 4 — plan. Definitions are checked here: missing/inactive ⇒ planner
    // failure; owned by ANOTHER integration ⇒ failure (vm §9 one field, one owner).
    const kpiKeys = [...new Set(approved.map((r) => r.targetKey.slice('kpi:'.length)))];
    const defRows = await prisma.kpiDefinition.findMany({
      where: { clientNumber: cn, kpiKey: { in: kpiKeys } },
      select: { kpiKey: true, label: true, unit: true, isActive: true, sourceIntegrationId: true, grain: true },
    });
    const foreign = defRows.filter((d) => d.sourceIntegrationId && d.sourceIntegrationId !== id);
    if (foreign.length) {
      return await fail(`The KPI(s) ${foreign.map((d) => `"${d.label}"`).join(', ')} are fed by another integration; one KPI has one source.`);
    }
    const defs: PlannerKpiDef[] = defRows;
    const existing = await loadExisting(cn, kpiKeys);
    // DEF-365: `now` is needed only by recipe rows; a timezone Intl rejects
    // must never fail a long/wide run (the planner reports a missing `now` per recipe).
    let recipeNow: ReturnType<typeof monthIn> | undefined;
    if (approved.some((r) => r.transform.mode === 'recipe')) {
      try { recipeNow = monthIn(new Date(), integ.timezone); } catch { recipeNow = undefined; }
    }
    const plan = planKpiReadings(records, approved, defs, existing, integ.blankPolicy as BlankPolicy, recipeNow);
    counts.skipped = plan.skipped;
    counts.blanks = plan.blanks;
    anomalies.push(...plan.anomalies);
    if (plan.failure) return await fail(plan.failure);
    counts.subjectsAffected = plan.subjectsAffected;

    // Step 5 — change cap, judged as a scheduled run would on EVERY run.
    // Spec §2.4: a run "changing more than change_cap_pct of the readings this
    // integration already OWNS". Only rewrites of stored readings count — a new
    // period (an insert) changes none of them. Counting inserts aborted every
    // scheduled run of a young sheet the month a row was appended (vm ported
    // note: "a monthly measurement changes nothing: it adds this month's
    // reading"). Dry runs share this numerator.
    // DEF-362: Context pages are planned now, against what is stored, so the
    // cap and the dry-run preview see them. Nothing is written here.
    let ctxPlan: ContextPlanResult | null = null;
    let ctxDiff: ContextDiff | null = null;
    if (approvedContext.length) {
      const storedPages = await loadStoredContextPages(cn, id);
      ctxPlan = planContextPages({ id, name: integ.name }, records, approvedContext, apiIdField(integ.apiConfig), await maxContextPages(cn), bareKeyOwner(storedPages));
      ctxDiff = diffContextPages(ctxPlan, storedPages, records.length, !read.truncated);
      anomalies.push(...ctxPlan.anomalies, ...ctxDiff.anomalies);
    }

    // The cap's base is what the integration already holds: its readings AND
    // its knowledge pages; rewriting or staling a page counts like rewriting a
    // reading, a new page (like a new period) changes nothing already held.
    const owned = await prisma.kpiReading.count({ where: { clientNumber: cn, integrationId: id } }) + (ctxDiff?.owned ?? 0);
    const rewrites = plan.readings.filter((r) => r.before !== null).length + (ctxDiff ? contextRewrites(ctxDiff) : 0);
    const capVerdict = changeCapVerdict(rewrites, owned, integ.changeCapPct);
    const labelsByDef = new Map(defRows.map((d) => [d.kpiKey, d.label]));
    const labels = new Map(plan.readings.map((r) =>
      [readingKey(r.kpiKey, r.periodStart, r.dimensionKey), labelFor(r, labelsByDef.get(r.kpiKey))]));
    // PARTIAL: part of the source was never seen, or the page cap stopped
    // Context early (spec §2b "cap ⇒ run note + PARTIAL").
    const okStatus: FinalStatus = read.truncated || ctxPlan?.truncated ? 'PARTIAL' : 'SUCCESS';
    const ctxOps = ctxDiff?.ops.length ?? 0;

    // Step 6 — dry run: preview rows only. `writes` = what a live run would write.
    if (opts.dryRun) {
      const preview = changeRowsFor(cn, id, runId, plan.readings, labels);
      for (let i = 0; i < preview.length; i += WRITE_CHUNK) {
        await prisma.integrationRunChange.createMany({ data: preview.slice(i, i + WRITE_CHUNK) });
      }
      counts.writes = plan.readings.length;
      if (ctxDiff && ctxPlan) {
        // Preview change rows only — applyContextDiff with dryRun touches no wiki page.
        const pv = await applyContextDiff(cn, { id, name: integ.name }, ctxDiff,
          { dryRun: true, runId, idField: apiIdField(integ.apiConfig), userId: integ.createdBy });
        contextSummary = { created: pv.created, updated: pv.updated, unchanged: ctxDiff.unchanged, stale: pv.stale,
          skipped: ctxPlan.skipped, failed: 0, truncated: ctxPlan.truncated };
        const note = previewNote(ctxDiff);
        if (note) anomalies.push(note);
        counts.writes += ctxOps;
        counts.subjectsAffected += ctxOps;
      }
      log.info('integration dry run', { clientNumber: cn, integrationId: id, runId, wouldWrite: counts.writes, ms: Date.now() - t0 });
      return await close(okStatus, { capVerdict });
    }

    if (opts.trigger === 'scheduled' && capVerdict.wouldTrip) {
      return await close('ABORTED', {
        capVerdict,
        error: `Stopped before writing: this run would change ${capVerdict.pct}% of the readings this integration keeps, `
          + `above the ${capVerdict.cap}% limit for unattended runs. Check the sheet, then run it by hand.`,
      });
    }

    // Step 7 — live: one transaction, readings + their change rows + the
    // run's close. Step 8 — distinct subjects: concurrent edits can make the DB
    // find fewer rows to change than planned; the counts follow what was written.
    if (ctxDiff && ctxPlan) {
      // DEF-362: readings first, in their ONE transaction (unchanged rule);
      // the run is NOT closed inside it, because the pages come next and the
      // run row must describe both. Pages cannot join that SQL transaction
      // (shared knowledge helper, global client, embedding queue): each page's
      // change row is recorded right after that page's own write. If the
      // readings fail, no page is written.
      let kpiWrites = 0;
      if (plan.readings.length > 0) {
        try {
          kpiWrites = await writeReadings(cn, id, runId, plan.readings, labels, async (_tx, writes) => writes);
        } catch (err) {
          counts.writes = 0;
          return await fail(`Nothing was written — saving the readings failed: ${adminText(err, 'the database did not accept them. Try again in a few minutes.', { clientNumber: cn, integrationId: id, runId })}`);
        }
      }
      const applied = await applyContextDiff(cn, { id, name: integ.name }, ctxDiff,
        { dryRun: false, runId, idField: apiIdField(integ.apiConfig), userId: integ.createdBy });
      anomalies.push(...applied.anomalies);
      const pageWrites = applied.created + applied.updated + applied.stale;
      contextSummary = { created: applied.created, updated: applied.updated, unchanged: ctxDiff.unchanged + applied.unchangedRace,
        stale: applied.stale, skipped: ctxPlan.skipped, failed: applied.failed, truncated: ctxPlan.truncated };
      counts.writes = kpiWrites + pageWrites;
      counts.subjectsAffected = Math.min(plan.subjectsAffected, kpiWrites) + pageWrites;
      log.info('integration run', { clientNumber: cn, integrationId: id, runId, trigger: opts.trigger, writes: counts.writes, pageFailures: applied.failed, ms: Date.now() - t0 });
      // Readings committed and some pages failed: never FAILED over committed
      // data — PARTIAL, with the failures named in the anomalies.
      return await close(applied.failed > 0 ? 'PARTIAL' : okStatus, { capVerdict });
    }

    if (plan.readings.length > 0) {
      try {
        return await writeReadings(cn, id, runId, plan.readings, labels, (tx, writes) => {
          const done: RunCounts = { ...counts, writes, subjectsAffected: Math.min(counts.subjectsAffected, writes) };
          log.info('integration run', { clientNumber: cn, integrationId: id, runId, trigger: opts.trigger, writes, ms: Date.now() - t0 });
          return finishRun(tx, cn, id, runId, false, { status: okStatus, counts: done, capVerdict, anomalies }, integ);
        });
      } catch (err) {
        counts.writes = 0;
        return await fail(`Nothing was written — saving the readings failed: ${adminText(err, 'the database did not accept them. Try again in a few minutes.', { clientNumber: cn, integrationId: id, runId })}`);
      }
    }
    counts.subjectsAffected = 0;
    log.info('integration run', { clientNumber: cn, integrationId: id, runId, trigger: opts.trigger, writes: 0, ms: Date.now() - t0 });
    return await close(okStatus, { capVerdict });
  } catch (err) {
    counts.writes = 0;
    return fail(`The run stopped unexpectedly: ${adminText(err, 'an internal error. Nothing was written; try again in a few minutes.', { clientNumber: cn, integrationId: id, runId })}`);
  }
};

/** Boot: a RUNNING row at startup belongs to a process that no longer exists.
 *  Leaving it would hold the run mutex for ever (vm bug: integration blocked
 *  permanently after a crash). The one cross-tenant write. */
export const sweepInterruptedRuns: RunEngineModule['sweepInterruptedRuns'] = async () => {
  const r = await runWithoutTenant(() => prisma.integrationRun.updateMany({
    where: { status: 'RUNNING' },
    data: { status: 'FAILED', errorMessage: INTERRUPTED_BY_RESTART, finishedAt: new Date() },
  }));
  if (r.count > 0) log.warn('integration runs interrupted by restart marked FAILED', { count: r.count });
  return r.count;
};

export const runEngine: RunEngineModule = { runIntegration, sweepInterruptedRuns };
