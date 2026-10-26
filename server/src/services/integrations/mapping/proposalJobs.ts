/**
 * DEF-354 — Integrations Stage 1: proposal jobs (in memory).
 *
 * The AI proposal takes longer than an HTTP request should be held open, so
 * the wizard starts a job and polls it (spec §2.6 propose/start + status).
 * Ported from vm integrationProposalJobs.ts:
 *   - one job per (tenant, integration): asking again with the SAME inputs
 *     returns the running job instead of paying for a second model call; asking
 *     with DIFFERENT inputs while one runs is refused (409), never merged;
 *   - a finished job is kept for `integrations.proposal_job_ttl_ms` (default
 *     1 h) so the overlay can still read the result, then swept;
 *   - a lookup checks tenant AND integration, so a job id from another tenant
 *     reads as unknown (null → 404), never as "exists elsewhere".
 *
 * In memory on purpose, as in vm: `tmcai-server` runs as ONE pm2 process, so a
 * poll always reaches the process that holds the job. A restart loses running
 * jobs; the status poll then 404s with "start a new one" (route), and nothing
 * half-done was saved because the proposer writes its version in a single
 * transaction at the very end. If the server is ever clustered, this map must
 * move to a table first.
 */
import { randomUUID } from 'crypto';
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { getBehaviorValue } from '../../behaviorConfig';
import { isConnectionOk } from '../store/integrationStore';
import { runProposal } from './aiProposer';
import {
  IntegrationInputError,
  IntegrationNotFoundError,
  RunBusyError,
  type ProposalJobStatus,
  type ProposalJobsModule,
  type ProposeOptions,
  type ProposeResult,
} from '../types';

const log = createLogger('integrations-proposal-jobs');

/** Fallback when behaviorConfig cannot be read (it never throws for a known
 *  key, but a job must not die over a settings lookup). */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** What the status endpoint returns: the contract shape plus the overlay's
 *  stage text ("Reading the sheet", "Asking the AI …"). */
export interface ProposalJobView extends ProposalJobStatus {
  stage: string;
}

interface Job {
  view: ProposalJobView;
  cn: string;
  inputsKey: string;
  ttlMs: number;
  startedMs: number;
  finishedMs: number | null;
}

/** 409 for a second, DIFFERENT proposal while one runs. Same `code` as a busy
 *  run, so the route's error table answers 409 without a new case. */
export class ProposalBusyError extends RunBusyError {
  constructor(integrationId: string, readonly jobId: string) {
    super(integrationId);
    this.name = 'ProposalBusyError';
    this.message = 'A mapping proposal with different instructions is already being prepared for this integration. Wait for it to finish, then ask again.';
  }
}

const jobs = new Map<string, Job>();            // jobId → job
const activeByKey = new Map<string, string>();  // `${cn}:${integrationId}` → jobId of the latest job

const slotKey = (cn: string, integrationId: string) => `${cn}:${integrationId}`;

/** Everything that changes what the proposer would answer from the caller's
 *  side. The sheet and the catalogue are read by the job itself. */
export function proposalInputsKey(opts: ProposeOptions): string {
  return JSON.stringify([opts.prompt?.trim() ?? '']);
}

/** Drop finished jobs past their TTL, and running jobs older than their TTL
 *  (a hung model call must not block the integration until the next restart). */
export function sweepProposalJobs(nowMs = Date.now()): number {
  let swept = 0;
  for (const [id, job] of jobs) {
    const since = job.finishedMs ?? job.startedMs;
    if (nowMs - since <= job.ttlMs) continue;
    jobs.delete(id);
    for (const [k, v] of activeByKey) if (v === id) activeByKey.delete(k);
    swept++;
  }
  return swept;
}

/** Admin-facing text for a failed job. Errors the integration modules raise
 *  are written for the admin; anything else is logged and said plainly. */
function describeError(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const known = new Set(['GSHEET_READ', 'CREDENTIAL_UNREADABLE', 'INTEGRATION_INPUT', 'INTEGRATION_NOT_FOUND']);
  if (e && typeof e.code === 'string' && known.has(e.code) && typeof e.message === 'string') return e.message;
  return 'The AI could not finish the proposal (the service did not answer in time or failed). Nothing was saved. Please try again in a few minutes.';
}

function finish(job: Job, patch: { result?: ProposeResult; error?: string }): void {
  job.finishedMs = Date.now();
  job.view = {
    ...job.view,
    state: patch.error ? 'failed' : 'done',
    stage: patch.error ? 'Failed' : 'Done',
    finishedAt: new Date(job.finishedMs).toISOString(),
    result: patch.result ?? null,
    error: patch.error ?? null,
  };
}

export const startProposalJob: ProposalJobsModule['startProposalJob'] = async (cn, integrationId, opts) => {
  sweepProposalJobs();
  const integ = await prisma.integrationSync.findFirst({
    where: { id: integrationId, clientNumber: cn },
    // DEF-362: apiConfig + secretSetAt are part of an api row's fingerprint;
    // without them isConnectionOk could never be true for an API integration.
    select: {
      id: true, sourceKind: true, sourceConfig: true, apiConfig: true, secretSetAt: true,
      connectionTestedAt: true, connectionFingerprint: true,
    },
  });
  if (!integ) throw new IntegrationNotFoundError(integrationId);
  // Spec §2.2: "Suggest the mapping" stays disabled until the CURRENT
  // connection passed its test. Enforced here too, not just greyed out.
  if (!isConnectionOk(integ)) {
    throw new IntegrationInputError('Test the connection first: the mapping can only be proposed for a sheet that was read successfully.', 'connection');
  }

  const ttlMs = await getBehaviorValue('integrations.proposal_job_ttl_ms', { clientNumber: cn }).catch(() => DEFAULT_TTL_MS);

  // No await from here until the job is registered: a second click in the
  // same moment must find this job, not start another model call.
  const key = slotKey(cn, integrationId);
  const inputsKey = proposalInputsKey(opts);
  const currentId = activeByKey.get(key);
  const current = currentId ? jobs.get(currentId) : undefined;
  if (current && current.view.state === 'running') {
    if (current.inputsKey === inputsKey) return { jobId: current.view.jobId };
    throw new ProposalBusyError(integrationId, current.view.jobId);
  }

  const jobId = randomUUID();
  const startedMs = Date.now();
  const job: Job = {
    cn,
    inputsKey,
    ttlMs,
    startedMs,
    finishedMs: null,
    view: {
      jobId,
      integrationId,
      state: 'running',
      stage: 'Starting',
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: null,
      result: null,
      error: null,
    },
  };
  jobs.set(jobId, job);
  activeByKey.set(key, jobId);

  void runProposal(cn, integrationId, opts, (stage) => {
    if (job.view.state === 'running') job.view = { ...job.view, stage };
  })
    .then((result) => finish(job, { result }))
    .catch((err) => {
      log.warn('mapping proposal failed', {
        clientNumber: cn, integrationId, jobId, error: err instanceof Error ? err.message : String(err),
      });
      finish(job, { error: describeError(err) });
    });

  return { jobId };
};

export const getProposalJob: ProposalJobsModule['getProposalJob'] = (cn, integrationId, jobId) => {
  sweepProposalJobs();
  const job = jobs.get(jobId);
  if (!job || job.cn !== cn || job.view.integrationId !== integrationId) return null;
  return { ...job.view };
};

/** Tests only. */
export function __resetProposalJobs(): void {
  jobs.clear();
  activeByKey.clear();
}
