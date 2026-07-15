import { describe, expect, it, vi } from 'vitest';
import {
  executeCleanupTaskSet,
  getCentralCleanupManifest,
  type CleanupTaskDefinition,
} from '../src/jobs/centralCleanupGovernor';

describe('central cleanup governor', () => {
  it('centrally declares every cleanup task with unique IDs and bounded cadence', () => {
    const manifest = getCentralCleanupManifest();
    expect(manifest.map((task) => task.id)).toEqual([
      'context_memory_expiry',
      'open_items_backlog',
      'system_log_retention',
      'action_idempotency_expiry',
      'approval_token_expiry',
      'contact_prune',
      'smart_contact_cleanup',
      'user_memory_decay',
      'reset_archive_ttl',
      'wiki_memory_consolidation',
      'feed_event_prune',
    ]);
    expect(new Set(manifest.map((task) => task.id)).size).toBe(manifest.length);
    for (const task of manifest) {
      expect(task.cadenceMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
      expect(task.initialDelayMs).toBeGreaterThanOrEqual(0);
      expect(task.initialDelayMs).toBeLessThanOrEqual(task.cadenceMs);
    }
  });

  it('isolates failures and only advances successful task cadences', async () => {
    const successfulRuns = new Map<string, number>();
    const calls: string[] = [];
    const tasks: CleanupTaskDefinition[] = [
      {
        id: 'good', cadenceMs: 1000, initialDelayMs: 0, description: 'good',
        run: vi.fn(async () => { calls.push('good'); }),
      },
      {
        id: 'bad', cadenceMs: 1000, initialDelayMs: 0, description: 'bad',
        run: vi.fn(async () => { calls.push('bad'); throw new Error('bounded failure'); }),
      },
      {
        id: 'after', cadenceMs: 1000, initialDelayMs: 0, description: 'after',
        run: vi.fn(async () => { calls.push('after'); }),
      },
    ];

    const report = await executeCleanupTaskSet({
      tasks, successfulRuns, nowMs: 10_000, governorStartedAt: 0,
    });

    expect(calls).toEqual(['good', 'bad', 'after']);
    expect(report).toMatchObject({ due: 3, completed: 2, failed: 1, skippedNotDue: 0 });
    expect(successfulRuns.get('good')).toBe(10_000);
    expect(successfulRuns.has('bad')).toBe(false);
    expect(successfulRuns.get('after')).toBe(10_000);
  });

  it('skips successful work until cadence but keeps failed work due', async () => {
    const successfulRuns = new Map<string, number>([['done', 10_000]]);
    const done = vi.fn(async () => undefined);
    const retry = vi.fn(async () => undefined);
    const report = await executeCleanupTaskSet({
      tasks: [
        { id: 'done', cadenceMs: 1000, initialDelayMs: 0, description: 'done', run: done },
        { id: 'retry', cadenceMs: 1000, initialDelayMs: 0, description: 'retry', run: retry },
      ],
      successfulRuns,
      nowMs: 10_500,
      governorStartedAt: 0,
    });
    expect(report).toMatchObject({ due: 1, completed: 1, failed: 0, skippedNotDue: 1 });
    expect(done).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });
});
