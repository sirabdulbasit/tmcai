/**
 * The only scheduler-facing governor for Action Center autonomy.
 *
 * Domain steps stay independently testable, but they do not own timers. This
 * governor controls cadence, ordering, failure isolation, and observability;
 * server.ts runs only this governor through the durable protected job lease.
 */
import createLogger from '../utils/logger';

const log = createLogger('central-action-governor');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

interface ActionTask {
  id: string;
  cadenceMs: number;
  run: () => Promise<unknown>;
}

export interface CentralActionReport {
  due: number;
  completed: number;
  failed: number;
  skippedNotDue: number;
  outcomes: Array<{ id: string; status: 'completed' | 'failed'; durationMs: number; error?: string }>;
}

const lastSuccessfulRun = new Map<string, number>();
let running = false;

const TASKS: ActionTask[] = [
  {
    id: 'prompt_expiry', cadenceMs: 30 * MINUTE,
    run: async () => {
      const { expireStalePrompts } = await import('../services/brainPrompts/brainPromptQueueService');
      return expireStalePrompts();
    },
  },
  {
    id: 'new_item_gap_prompts', cadenceMs: 30 * MINUTE,
    run: async () => {
      const { runProducerSweep } = await import('../services/brainPrompts/producerSweep');
      return runProducerSweep();
    },
  },
  {
    id: 'draft_slot_completion', cadenceMs: HOUR,
    run: async () => {
      const { runOpenItemDraftAsk } = await import('./openItemDraftAskJob');
      return runOpenItemDraftAsk();
    },
  },
  {
    id: 'living_action_lifecycle', cadenceMs: HOUR,
    run: async () => {
      const { runActionLifecycleSweep } = await import('./actionLifecycleWorker');
      return runActionLifecycleSweep();
    },
  },
];

export function getCentralActionManifest(): Array<{ id: string; cadenceMs: number }> {
  return TASKS.map(({ id, cadenceMs }) => ({ id, cadenceMs }));
}

export async function executeActionTaskSet(args: {
  tasks: ActionTask[];
  successfulRuns: Map<string, number>;
  nowMs: number;
  force?: boolean;
}): Promise<CentralActionReport> {
  const report: CentralActionReport = { due: 0, completed: 0, failed: 0, skippedNotDue: 0, outcomes: [] };
  for (const task of args.tasks) {
    const last = args.successfulRuns.get(task.id);
    if (!args.force && last !== undefined && args.nowMs - last < task.cadenceMs) {
      report.skippedNotDue += 1;
      continue;
    }
    report.due += 1;
    const started = Date.now();
    try {
      await task.run();
      args.successfulRuns.set(task.id, args.nowMs);
      report.completed += 1;
      report.outcomes.push({ id: task.id, status: 'completed', durationMs: Date.now() - started });
    } catch (error: any) {
      const message = String(error?.message ?? error).slice(0, 240);
      report.failed += 1;
      report.outcomes.push({ id: task.id, status: 'failed', durationMs: Date.now() - started, error: message });
      log.warn('action task failed', { taskId: task.id, error: message });
    }
  }
  return report;
}

export async function runCentralActionGovernor(options: { now?: Date; force?: boolean } = {}): Promise<CentralActionReport> {
  if (running) return { due: 0, completed: 0, failed: 0, skippedNotDue: TASKS.length, outcomes: [] };
  running = true;
  try {
    const report = await executeActionTaskSet({
      tasks: TASKS,
      successfulRuns: lastSuccessfulRun,
      nowMs: (options.now ?? new Date()).getTime(),
      force: options.force,
    });
    if (report.due) {
      log.info('action governor tick', {
        due: report.due, completed: report.completed, failed: report.failed,
        tasks: report.outcomes.map((o) => `${o.id}:${o.status}`),
      });
    }
    return report;
  } finally {
    running = false;
  }
}

export function resetCentralActionStateForTests(): void {
  lastSuccessfulRun.clear();
  running = false;
}
