import { describe, expect, it, vi } from 'vitest';
import { executeActionTaskSet, getCentralActionManifest } from '../src/jobs/centralActionGovernor';

describe('central Action Center governor', () => {
  it('centrally owns every action-lifecycle concern', () => {
    expect(getCentralActionManifest().map((task) => task.id)).toEqual([
      // DEF-054: the queue's CONSUMER. Every other task here produces prompts;
      // until 2026-08-05 nothing delivered them, so they were written for the
      // owner and expired unread by 'prompt_expiry' below.
      'brain_prompt_dispatch',
      'prompt_expiry',
      'new_item_gap_prompts',
      'draft_slot_completion',
      'living_action_lifecycle',
      'delegation_thread_recovery',
    ]);
  });

  it('isolates failures and keeps failed work due for retry', async () => {
    const ok = vi.fn(async () => undefined);
    const fail = vi.fn(async () => { throw new Error('temporary failure'); });
    const successfulRuns = new Map<string, number>();
    const tasks = [
      { id: 'ok', cadenceMs: 1000, run: ok },
      { id: 'fail', cadenceMs: 1000, run: fail },
    ];
    const first = await executeActionTaskSet({ tasks, successfulRuns, nowMs: 10_000 });
    expect(first).toMatchObject({ due: 2, completed: 1, failed: 1 });
    expect(successfulRuns.has('ok')).toBe(true);
    expect(successfulRuns.has('fail')).toBe(false);

    const retry = await executeActionTaskSet({ tasks, successfulRuns, nowMs: 10_500 });
    expect(retry).toMatchObject({ due: 1, skippedNotDue: 1, failed: 1 });
    expect(ok).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledTimes(2);
  });
});
