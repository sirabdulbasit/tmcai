/**
 * One governor for every autonomous data-cleanup concern.
 *
 * Cleanup implementations remain small domain workers, but none of them owns
 * scheduling. This governor centrally controls cadence, ordering, isolation,
 * observability, and retry eligibility. It is itself run through protectedTick
 * so the existing durable database lease guarantees one active governor
 * across replicas.
 */
import createLogger from '../utils/logger';

const log = createLogger('central-cleanup-governor');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface CleanupTaskDefinition {
  id: string;
  cadenceMs: number;
  initialDelayMs: number;
  description: string;
  run: () => Promise<unknown>;
}

export interface CleanupTaskOutcome {
  id: string;
  status: 'completed' | 'failed';
  durationMs: number;
  error?: string;
}

export interface CentralCleanupReport {
  due: number;
  completed: number;
  failed: number;
  skippedNotDue: number;
  outcomes: CleanupTaskOutcome[];
}

const startedAt = Date.now();
const lastSuccessfulRun = new Map<string, number>();
let running = false;

const TASKS: CleanupTaskDefinition[] = [
  {
    id: 'context_memory_expiry', cadenceMs: HOUR, initialDelayMs: 0,
    description: 'Delete expired short-lived conversation context',
    run: async () => {
      const { cleanupExpiredContextMemories } = await import('../services/memoryService');
      return cleanupExpiredContextMemories();
    },
  },
  {
    id: 'open_items_backlog', cadenceMs: HOUR, initialDelayMs: 0,
    description: 'Quarantine zombies and archive stale, duplicate, smoke, or rejected items',
    run: async () => {
      const { runOpenItemsBacklogCleanup } = await import('./openItemsBacklogCleanupJob');
      return runOpenItemsBacklogCleanup();
    },
  },
  {
    id: 'system_log_retention', cadenceMs: HOUR, initialDelayMs: HOUR,
    description: 'Remove system logs outside the 90-day retention window',
    run: async () => {
      const { cleanupOldLogs } = await import('../services/systemLogService');
      return cleanupOldLogs(90);
    },
  },
  {
    id: 'action_idempotency_expiry', cadenceMs: DAY, initialDelayMs: 15 * 60 * 1000,
    description: 'Delete expired action idempotency keys',
    run: async () => {
      const { cleanupExpiredKeys } = await import('../services/actionIdempotencyService');
      return cleanupExpiredKeys();
    },
  },
  {
    id: 'approval_token_expiry', cadenceMs: DAY, initialDelayMs: 20 * 60 * 1000,
    description: 'Delete approval tokens past their audit grace window',
    run: async () => {
      const { cleanupExpired } = await import('../services/notifications/approvalTokenService');
      return cleanupExpired();
    },
  },
  {
    id: 'contact_prune', cadenceMs: DAY, initialDelayMs: 5 * 60 * 1000,
    description: 'Merge safe duplicates and flag ambiguous contact conflicts',
    run: async () => {
      const { runContactPruneForAllTenants } = await import('../services/knowledge/contactPruneService');
      return runContactPruneForAllTenants();
    },
  },
  {
    id: 'smart_contact_cleanup', cadenceMs: DAY, initialDelayMs: 10 * 60 * 1000,
    description: 'Repair leaked contacts and archive evidence-free or junk contacts',
    run: async () => {
      const { runSmartCleanupAllUsers } = await import('../services/knowledge/smartCleanupService');
      return runSmartCleanupAllUsers();
    },
  },
  {
    id: 'user_memory_decay', cadenceMs: DAY, initialDelayMs: 15 * 60 * 1000,
    description: 'Expire dated memory and decay stale unconfirmed inference',
    run: async () => {
      const { decayUserMemories } = await import('./memoryDecayJob');
      return decayUserMemories();
    },
  },
  {
    id: 'reset_archive_ttl', cadenceMs: DAY, initialDelayMs: HOUR,
    description: 'Drop expired reversible-reset archive tables',
    run: async () => {
      const { runBrainResetArchiveCleanup } = await import('./brainResetArchiveCleanup');
      return runBrainResetArchiveCleanup();
    },
  },
  {
    id: 'wiki_memory_consolidation', cadenceMs: DAY, initialDelayMs: 6 * HOUR,
    description: 'Archive old low-value episodic wiki memory',
    run: async () => {
      const { runConsolidationAllTenants } = await import('../services/knowledge/memoryConsolidationService');
      return runConsolidationAllTenants();
    },
  },
  {
    id: 'feed_event_prune', cadenceMs: DAY, initialDelayMs: DAY,
    description: 'Prune feed events only after a durable scribe copy exists',
    run: async () => {
      const { pruneUserFeedEvents, forEachActiveUser } =
        await import('../services/maintenance/queueArchiveMaintenanceService');
      return forEachActiveUser((clientNumber, userId) =>
        pruneUserFeedEvents(clientNumber, userId, { apply: true }));
    },
  },
];

export function getCentralCleanupManifest(): Array<Omit<CleanupTaskDefinition, 'run'>> {
  return TASKS.map(({ run: _run, ...task }) => ({ ...task }));
}

function isDue(
  task: CleanupTaskDefinition,
  nowMs: number,
  force: boolean,
  successfulRuns: Map<string, number>,
  governorStartedAt: number,
): boolean {
  if (force) return true;
  const last = successfulRuns.get(task.id);
  if (last !== undefined) return nowMs - last >= task.cadenceMs;
  return nowMs - governorStartedAt >= task.initialDelayMs;
}

export async function executeCleanupTaskSet(args: {
  tasks: CleanupTaskDefinition[];
  successfulRuns: Map<string, number>;
  nowMs: number;
  governorStartedAt: number;
  force?: boolean;
}): Promise<CentralCleanupReport> {
  const report: CentralCleanupReport = {
    due: 0, completed: 0, failed: 0, skippedNotDue: 0, outcomes: [],
  };
  for (const task of args.tasks) {
    if (!isDue(task, args.nowMs, args.force === true, args.successfulRuns, args.governorStartedAt)) {
      report.skippedNotDue += 1;
      continue;
    }
    report.due += 1;
    const taskStartedAt = Date.now();
    try {
      await task.run();
      args.successfulRuns.set(task.id, args.nowMs);
      report.completed += 1;
      report.outcomes.push({
        id: task.id,
        status: 'completed',
        durationMs: Date.now() - taskStartedAt,
      });
    } catch (error: any) {
      const message = String(error?.message ?? error).slice(0, 240);
      report.failed += 1;
      report.outcomes.push({
        id: task.id,
        status: 'failed',
        durationMs: Date.now() - taskStartedAt,
        error: message,
      });
      log.warn('cleanup task failed', { taskId: task.id, error: message });
    }
  }
  return report;
}

/**
 * Run every due cleanup sequentially to keep database pressure bounded.
 * Successful tasks advance independently; failed tasks stay due for the next
 * protected governor tick/retry.
 */
export async function runCentralCleanupGovernor(options: {
  now?: Date;
  force?: boolean;
} = {}): Promise<CentralCleanupReport> {
  if (running) {
    return { due: 0, completed: 0, failed: 0, skippedNotDue: TASKS.length, outcomes: [] };
  }
  running = true;
  const nowMs = (options.now ?? new Date()).getTime();
  let report: CentralCleanupReport;

  try {
    report = await executeCleanupTaskSet({
      tasks: TASKS,
      successfulRuns: lastSuccessfulRun,
      nowMs,
      governorStartedAt: startedAt,
      force: options.force,
    });
  } finally {
    running = false;
  }

  if (report.due > 0) {
    log.info('cleanup governor tick', {
      due: report.due,
      completed: report.completed,
      failed: report.failed,
      taskIds: report.outcomes.map((outcome) => `${outcome.id}:${outcome.status}`),
    });
  }
  return report;
}

/** Test-only reset for deterministic cadence assertions. */
export function resetCentralCleanupStateForTests(): void {
  lastSuccessfulRun.clear();
  running = false;
}
