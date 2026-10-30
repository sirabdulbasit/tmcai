/**
 * "Suggest the mapping" as a background job.
 * ==========================================
 *
 * A proposal takes minutes of AI work. Held open as one HTTP request it was cut
 * by the proxy at five minutes whatever the server was doing, and the wizard
 * showed a failure for a proposal that went on to be saved. The job runs in the
 * server; the wizard starts it and polls its progress, so no proxy timeout can
 * fail it.
 *
 * One job per integration at a time. Starting while one runs returns the
 * running one only when it was asked for with the very same inputs (the brief
 * typed, the integration's saved setup) — the same proposal is not paid for
 * twice. A start with different inputs is refused, never folded into the
 * running job: a brief must never be dropped without the admin being told.
 * Jobs live in this process's memory (the server runs as one process by
 * default); each is kept by its id for an hour after it finishes, so the
 * wizard that started it can collect its result even after another starts.
 * A restart loses them, and the status route then says so.
 */
import { randomUUID } from 'crypto';
import { clockTime } from '../time';

export type StageKey = 'read' | 'mapping' | 'records' | 'recipes' | 'recognition' | 'save';
export type StageState = 'waiting' | 'running' | 'done' | 'reused' | 'failed' | 'skipped';

export interface ProposalStage {
  key: StageKey;
  label: string;
  state: StageState;
  /** Recognition batches settled / in all. */
  done?: number;
  total?: number;
  /** Batches that failed so far — reported, never dropped. */
  failed?: number;
}

/**
 * Report on a stage. Shared by proposeMapping and the recipe step.
 * `onlyIfWaiting` closes off a stage that never started without touching one that ran.
 */
export type ProgressFn = (
  key: StageKey,
  patch: Partial<Omit<ProposalStage, 'key' | 'label'>>,
  onlyIfWaiting?: boolean,
) => void;

export const PROPOSAL_STAGES: ReadonlyArray<{ key: StageKey; label: string }> = [
  { key: 'read', label: 'Reading the system, your brief and your goals' },
  { key: 'mapping', label: 'Working out what each field means' },
  { key: 'records', label: 'Reading every record' },
  { key: 'recipes', label: 'Writing goal recipes' },
  { key: 'recognition', label: 'Matching goal titles' },
  { key: 'save', label: 'Saving the proposal for your approval' },
];

export interface ProposalJob<R = unknown> {
  id: string;
  integrationId: number;
  clientNumber: number;
  startedBy: string | null;
  /** What the proposal was asked with — never shown; compared on a second start. */
  inputsKey: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: 'running' | 'done' | 'failed';
  stages: ProposalStage[];
  result: R | null;
  error: string | null;
}

const KEEP_FINISHED_MS = 60 * 60 * 1000;
/** The latest job per integration of a tenant. */
const jobs = new Map<string, ProposalJob>();
/** Every job still kept, by id — a finished one stays collectable after a newer one starts. */
const byId = new Map<string, ProposalJob>();
const keyOf = (integrationId: number, clientNumber: number): string => `${clientNumber}:${integrationId}`;

const sweep = (now: number): void => {
  for (const [k, j] of jobs) {
    if (j.finishedAt && now - j.finishedAt.getTime() > KEEP_FINISHED_MS) jobs.delete(k);
  }
  for (const [k, j] of byId) {
    if (j.finishedAt && now - j.finishedAt.getTime() > KEEP_FINISHED_MS) byId.delete(k);
  }
};

/** A fresh stage list, every stage waiting. */
export const freshStages = (): ProposalStage[] => PROPOSAL_STAGES.map((s) => ({ ...s, state: 'waiting' as const }));

/** Apply one progress report to a stage list (pure — the job and the tests share it). */
export const applyProgress = (
  stages: ProposalStage[],
  key: StageKey,
  patch: Partial<Omit<ProposalStage, 'key' | 'label'>>,
  onlyIfWaiting = false,
): void => {
  const s = stages.find((x) => x.key === key);
  if (!s || (onlyIfWaiting && s.state !== 'waiting')) return;
  Object.assign(s, patch);
};

/**
 * Start a proposal for this integration of this tenant. While one runs:
 *  • the same inputs → that job is returned (started: false);
 *  • different inputs → nothing starts and `busy` carries the running job, so
 *    the caller can refuse and say whose proposal is building and since when.
 * `run` receives the progress reporter; its result or error is kept on the job.
 */
export const startProposalJob = <R>(
  who: { integrationId: number; clientNumber: number; startedBy: string | null; inputsKey: string },
  run: (progress: ProgressFn) => Promise<R>,
  describeError: (err: unknown) => string,
): { job: ProposalJob<R>; started: boolean; busy?: false } | { job: ProposalJob<R>; started: false; busy: true } => {
  const now = Date.now();
  sweep(now);
  const k = keyOf(who.integrationId, who.clientNumber);
  const existing = jobs.get(k);
  if (existing && existing.status === 'running') {
    return existing.inputsKey === who.inputsKey
      ? { job: existing as ProposalJob<R>, started: false }
      : { job: existing as ProposalJob<R>, started: false, busy: true };
  }
  const job: ProposalJob<R> = {
    id: randomUUID(),
    integrationId: who.integrationId,
    clientNumber: who.clientNumber,
    startedBy: who.startedBy,
    inputsKey: who.inputsKey,
    startedAt: new Date(now),
    finishedAt: null,
    status: 'running',
    stages: freshStages(),
    result: null,
    error: null,
  };
  jobs.set(k, job as ProposalJob);
  byId.set(job.id, job as ProposalJob);
  const progress: ProgressFn = (key, patch, onlyIfWaiting) => {
    if (job.status === 'running') applyProgress(job.stages, key, patch, onlyIfWaiting);
  };
  void (async () => {
    try {
      job.result = await run(progress);
      job.status = 'done';
    } catch (err) {
      job.error = describeError(err);
      job.status = 'failed';
      // The stage that was running is the one that failed.
      for (const s of job.stages) if (s.state === 'running') s.state = 'failed';
    } finally {
      job.finishedAt = new Date();
    }
  })();
  return { job, started: true };
};

/**
 * A job of this integration of this tenant: the one with `jobId` when given
 * (running or finished within the hour), else the latest. Null when this
 * process holds no such job — e.g. after a restart.
 */
export const getProposalJob = (integrationId: number, clientNumber: number, jobId?: string | null): ProposalJob | null => {
  sweep(Date.now());
  if (jobId) {
    const j = byId.get(jobId);
    return j && j.integrationId === integrationId && j.clientNumber === clientNumber ? j : null;
  }
  return jobs.get(keyOf(integrationId, clientNumber)) ?? null;
};

/** What the wizard sees. Times are in the configured zone (setTimeZone). */
export const publicJob = (job: ProposalJob, now = new Date()) => ({
  jobId: job.id,
  status: job.status,
  stages: job.stages,
  startedAtLocal: clockTime(job.startedAt),
  elapsedSeconds: Math.round(((job.finishedAt ?? now).getTime() - job.startedAt.getTime()) / 1000),
  ...(job.status === 'done' ? { result: job.result } : {}),
  ...(job.status === 'failed' ? { error: job.error } : {}),
});

/** Test seam: forget every job. */
export const __resetProposalJobs = (): void => { jobs.clear(); byId.clear(); };
