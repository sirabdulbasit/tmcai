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
 * Tenant rule: `cn` is in every where and every raw statement — the dispatcher
 * and boot sweep run outside a tenant scope, where the Prisma extension adds
 * nothing.
 */
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { runWithoutTenant } from '../../../db/tenantContext';
import { readGsheet } from '../sources/gsheetReader';
import { currentFingerprint, isConnectionOk, readSourceConfig, scheduleOf } from '../store/integrationStore';
import {
  IntegrationInputError,
  IntegrationNotFoundError,
  RunBusyError,
  type ApprovedKpiRow,
  type BlankPolicy,
  type CapVerdict,
  type EngineResult,
  type ExistingReadings,
  type KpiTransform,
  type PlannedReading,
  type RunCounts,
  type RunEngineModule,
  type RunOptions,
} from '../types';
import { MAX_CHANGE_PCT, changeCapVerdict, nextScheduledRun, parseNumber, parsePeriod, planKpiReadings, readingKey, type PlannerKpiDef } from './planner';

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
  return null;
}

/** Every sheet column an approved row reads — the header check's list. */
export function fieldsRead(t: KpiTransform): string[] {
  const own = t.mode === 'long' ? [t.valueField, t.periodField] : [...t.columns];
  return t.dimensionField ? [...own, t.dimensionField] : own;
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

interface Outcome {
  status: FinalStatus;
  counts: RunCounts;
  capVerdict: CapVerdict;
  anomalies: string[];
  error?: string;
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
  const result: EngineResult = {
    runId, dryRun, status: o.status, changePercent: o.capVerdict.pct, capVerdict: o.capVerdict,
    anomalies: o.anomalies, ...o.counts, ...(o.error ? { error: o.error } : {}),
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
async function writeReadings(
  cn: string, integrationId: string, runId: string,
  readings: PlannedReading[], labels: Map<string, string>,
  closeInTx: (tx: CloseDb, writes: number) => Promise<EngineResult>,
): Promise<EngineResult> {
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
  const close = (status: FinalStatus, extra: { error?: string; capVerdict?: CapVerdict } = {}) =>
    safeFinish(prisma, cn, id, runId, opts.dryRun, {
      status, counts, capVerdict: extra.capVerdict ?? { ...NO_CAP, cap: integ.changeCapPct },
      anomalies, ...(extra.error ? { error: extra.error } : {}),
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
    const cfg = readSourceConfig(integ.sourceConfig);
    if (!cfg) return await fail('No Google Sheet is connected to this integration.');
    // "The tested connection is the one runs use" (spec §3): a live write never
    // reads a sheet that has not passed its test since it was last changed.
    if (!opts.dryRun && !isConnectionOk(integ)) {
      return await fail('The sheet connection has not passed its test since it was last changed — test the connection first.');
    }

    // Approved rows of THIS version only, computed now (never stored).
    const suggestionRows = await prisma.integrationSuggestion.findMany({
      where: { clientNumber: cn, integrationId: id, mappingVersionId: versionId, status: 'APPROVED', targetKind: 'kpi' },
      select: { id: true, sourceField: true, targetKey: true, transform: true },
      orderBy: { createdAt: 'asc' },
    });
    counts.setAside = await prisma.integrationSuggestion.count({
      where: { clientNumber: cn, integrationId: id, mappingVersionId: versionId, status: 'SET_ASIDE' },
    });
    if (suggestionRows.length === 0) return await fail('No field of this mapping version is approved, so there is nothing to run.');
    const approved: ApprovedKpiRow[] = [];
    for (const s of suggestionRows) {
      const transform = readTransform(s.transform);
      if (!transform || !s.targetKey.startsWith('kpi:')) {
        return await fail(`The approved field "${s.sourceField}" has no usable layout (${s.targetKey}); propose the mapping again.`);
      }
      approved.push({ suggestionId: s.id, sourceField: s.sourceField, targetKey: s.targetKey as `kpi:${string}`, transform });
    }

    // Step 3 — read, then the header check.
    let read;
    try {
      read = await readGsheet(cn, cfg);
    } catch (err) {
      return await fail(`The sheet could not be read: ${adminText(err, 'the read failed unexpectedly. Try again in a few minutes.', { clientNumber: cn, integrationId: id, runId })}`);
    }
    counts.recordsRead = read.rowCount;
    anomalies.push(...read.anomalies);
    if (read.truncated) anomalies.push(read.truncatedReason ?? 'Only part of the sheet was read.');
    const headers = new Set(read.headers);
    const missing = [...new Set(approved.flatMap((r) => fieldsRead(r.transform)))].filter((f) => !headers.has(f));
    if (missing.length) {
      return await fail(`The sheet no longer has the column(s) ${missing.map((m) => `"${m}"`).join(', ')} that the approved mapping reads.`);
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
    const plan = planKpiReadings(read.records, approved, defs, existing, integ.blankPolicy as BlankPolicy);
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
    const owned = await prisma.kpiReading.count({ where: { clientNumber: cn, integrationId: id } });
    const rewrites = plan.readings.filter((r) => r.before !== null).length;
    const capVerdict = changeCapVerdict(rewrites, owned, integ.changeCapPct);
    const labelsByDef = new Map(defRows.map((d) => [d.kpiKey, d.label]));
    const labels = new Map(plan.readings.map((r) =>
      [readingKey(r.kpiKey, r.periodStart, r.dimensionKey), labelFor(r, labelsByDef.get(r.kpiKey))]));
    const okStatus: FinalStatus = read.truncated ? 'PARTIAL' : 'SUCCESS';

    // Step 6 — dry run: preview rows only. `writes` = what a live run would write.
    if (opts.dryRun) {
      const preview = changeRowsFor(cn, id, runId, plan.readings, labels);
      for (let i = 0; i < preview.length; i += WRITE_CHUNK) {
        await prisma.integrationRunChange.createMany({ data: preview.slice(i, i + WRITE_CHUNK) });
      }
      counts.writes = plan.readings.length;
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
