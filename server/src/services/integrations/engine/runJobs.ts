/**
 * DEF-354 — Integrations Stage 1: run jobs for the admin wizard (spec
 * INTEGRATIONS_DESIGN.md §2.6 `POST /:id/run/start` + `GET /:id/run/status`).
 *
 * vm kept run jobs in a process Map, so a restart lost every status and the
 * wizard polled a job that no longer existed. Here the job IS the run row:
 * startRun returns its id as soon as the row (the mutex) exists, and every
 * status read goes to the database — a run swept by the boot sweep reads as
 * FAILED "interrupted by server restart", not as "unknown job".
 */
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import type {
  EngineResult,
  RunChangeDTO,
  RunJobsModule,
  RunStatus,
  RunStatusView,
  RunTrigger,
} from '../types';
import { runIntegration } from './runEngine';

const log = createLogger('integrations-run-jobs');

const DEFAULT_RUN_LIST = 50;
const MAX_RUN_LIST = 200;
/** A change list is for reading on screen; a 50k-row first load is summarised
 *  by the run's counts, and the list shows the first rows in write order. */
const MAX_CHANGE_ROWS = 5000;

export const startRun: RunJobsModule['startRun'] = (cn, integrationId, opts) =>
  new Promise<{ runId: string }>((resolve, reject) => {
    let started = false;
    runIntegration(cn, integrationId, {
      ...opts,
      onStarted: (runId) => { started = true; resolve({ runId }); },
    })
      .then((r) => { if (!started) resolve({ runId: r.runId }); })
      .catch((err) => {
        // Before the row exists the caller gets the error (RunBusyError ⇒ 409,
        // IntegrationNotFoundError ⇒ 404). After, the engine closes the row
        // itself; anything still thrown is logged — the row tells the admin.
        if (!started) { reject(err); return; }
        log.error('integration run job threw after start', {
          clientNumber: cn, integrationId, error: err instanceof Error ? err.message : String(err),
        });
      });
  });

type RunRow = {
  id: string; integrationId: string; status: string; dryRun: boolean; trigger: string;
  mappingVersionId: string | null; startedAt: Date; finishedAt: Date | null;
  result: unknown; errorMessage: string | null; triggeredBy: string | null;
};

function toView(r: RunRow): RunStatusView {
  const status = r.status as RunStatus;
  return {
    runId: r.id,
    integrationId: r.integrationId,
    status,
    dryRun: r.dryRun,
    trigger: r.trigger as RunTrigger,
    mappingVersionId: r.mappingVersionId,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    // A swept run has no result: it never finished, and the view says so.
    result: status === 'RUNNING' || !r.result ? null : (r.result as EngineResult),
    error: r.errorMessage,
    triggeredBy: r.triggeredBy ?? null,
  };
}

const RUN_SELECT = {
  id: true, integrationId: true, status: true, dryRun: true, trigger: true, mappingVersionId: true,
  startedAt: true, finishedAt: true, result: true, errorMessage: true, triggeredBy: true,
} as const;

export const getRunStatus: RunJobsModule['getRunStatus'] = async (cn, integrationId, runId) => {
  const row = await prisma.integrationRun.findFirst({
    where: { id: runId, clientNumber: cn, integrationId }, select: RUN_SELECT,
  });
  return row ? toView(row) : null;
};

export const listRuns: RunJobsModule['listRuns'] = async (cn, integrationId, limit = DEFAULT_RUN_LIST) => {
  const take = Math.max(1, Math.min(MAX_RUN_LIST, Math.floor(limit) || DEFAULT_RUN_LIST));
  const rows = await prisma.integrationRun.findMany({
    where: { clientNumber: cn, integrationId },
    orderBy: { startedAt: 'desc' },
    take,
    select: RUN_SELECT,
  });
  return rows.map(toView);
};

export const listRunChanges: RunJobsModule['listRunChanges'] = async (cn, integrationId, runId) => {
  const rows = await prisma.integrationRunChange.findMany({
    where: { clientNumber: cn, integrationId, runId },
    orderBy: [{ createdAt: 'asc' }, { subjectKey: 'asc' }],
    take: MAX_CHANGE_ROWS,
    select: {
      id: true, op: true, subjectKey: true, subjectLabel: true, targetKey: true, sourceKey: true,
      beforeValue: true, afterValue: true, createdAt: true,
    },
  });
  return rows.map((c): RunChangeDTO => ({
    id: c.id,
    op: c.op === 'create' ? 'create' : 'update',
    subjectKey: c.subjectKey,
    subjectLabel: c.subjectLabel,
    targetKey: c.targetKey,
    sourceKey: c.sourceKey,
    beforeValue: c.beforeValue,
    afterValue: c.afterValue,
    createdAt: c.createdAt.toISOString(),
  }));
};

export const runJobs: RunJobsModule = { startRun, getRunStatus, listRuns, listRunChanges };
