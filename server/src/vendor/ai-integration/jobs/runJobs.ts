/**
 * "Run now" and "Test" as a background job.
 * =========================================
 *
 * A run reads every record of the source and can take longer than five
 * minutes. Held open as one HTTP request it was cut by the proxy at five
 * minutes — the screen showed a proxy error for a run that went on to finish
 * and write. The run now happens in the server; the screen starts it and polls
 * until it finishes, so no proxy timeout can fail it.
 *
 * One run per integration at a time. Starting the same kind (test or live,
 * and for a test the same mapping version) while one runs returns the running
 * one — a second click never starts a second run. Starting another kind is refused with what is running and
 * since when. Jobs live in this process's memory; each is kept by its id for an
 * hour after it finishes, so the screen that started it can collect its
 * result. A restart loses them, and the status route then says so — the run's
 * own row in the update history still says how it ended.
 */
import { randomUUID } from 'crypto';
import { clockTime } from '../time';

export interface RunJob<R = unknown> {
  id: string;
  integrationId: number;
  clientNumber: number;
  startedBy: string | null;
  dryRun: boolean;
  /** The mapping version a test runs; null = the approved one. */
  mappingVersion: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  status: 'running' | 'done' | 'failed';
  result: R | null;
  error: string | null;
}

const KEEP_FINISHED_MS = 60 * 60 * 1000;
/** The latest job per integration of a tenant. */
const latest = new Map<string, RunJob>();
/** Every job still kept, by id. */
const byId = new Map<string, RunJob>();
const keyOf = (integrationId: number, clientNumber: number): string => `${clientNumber}:${integrationId}`;

const sweep = (now: number): void => {
  for (const m of [latest, byId]) {
    for (const [k, j] of m) if (j.finishedAt && now - j.finishedAt.getTime() > KEEP_FINISHED_MS) m.delete(k);
  }
};

/**
 * Start a run of this integration of this tenant. While one runs: the same
 * kind → that job (started: false); the other kind → nothing starts and
 * `busy` carries the running job.
 */
export const startRunJob = <R>(
  who: { integrationId: number; clientNumber: number; startedBy: string | null; dryRun: boolean; mappingVersion?: number | null },
  run: () => Promise<R>,
  describeError: (err: unknown) => string,
): { job: RunJob<R>; started: boolean; busy?: false } | { job: RunJob<R>; started: false; busy: true } => {
  const now = Date.now();
  sweep(now);
  const k = keyOf(who.integrationId, who.clientNumber);
  const existing = latest.get(k);
  if (existing && existing.status === 'running') {
    return existing.dryRun === who.dryRun && existing.mappingVersion === (who.mappingVersion ?? null)
      ? { job: existing as RunJob<R>, started: false }
      : { job: existing as RunJob<R>, started: false, busy: true };
  }
  const job: RunJob<R> = {
    id: randomUUID(),
    integrationId: who.integrationId,
    clientNumber: who.clientNumber,
    startedBy: who.startedBy,
    dryRun: who.dryRun,
    mappingVersion: who.mappingVersion ?? null,
    startedAt: new Date(now),
    finishedAt: null,
    status: 'running',
    result: null,
    error: null,
  };
  latest.set(k, job as RunJob);
  byId.set(job.id, job as RunJob);
  void (async () => {
    try {
      job.result = await run();
      job.status = 'done';
    } catch (err) {
      job.error = describeError(err);
      job.status = 'failed';
    } finally {
      job.finishedAt = new Date();
    }
  })();
  return { job, started: true };
};

/**
 * A run job of this integration of this tenant: the one with `jobId` when
 * given, else the latest. Null when this process holds no such job.
 */
export const getRunJob = (integrationId: number, clientNumber: number, jobId?: string | null): RunJob | null => {
  sweep(Date.now());
  if (jobId) {
    const j = byId.get(jobId);
    return j && j.integrationId === integrationId && j.clientNumber === clientNumber ? j : null;
  }
  return latest.get(keyOf(integrationId, clientNumber)) ?? null;
};

/** What the screen sees. Times are in the configured zone (setTimeZone). */
export const publicRunJob = (job: RunJob, now = new Date()) => ({
  jobId: job.id,
  status: job.status,
  dryRun: job.dryRun,
  startedAtLocal: clockTime(job.startedAt),
  elapsedSeconds: Math.round(((job.finishedAt ?? now).getTime() - job.startedAt.getTime()) / 1000),
  ...(job.status === 'done' ? { result: job.result } : {}),
  ...(job.status === 'failed' ? { error: job.error } : {}),
});

/** Test seam: forget every job. */
export const __resetRunJobs = (): void => { latest.clear(); byId.clear(); };
