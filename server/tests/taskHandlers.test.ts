import { describe, it, expect, vi, beforeEach } from 'vitest';

// Backlog top-item — Google Tasks handlers were STUBs after 2026-07-08:
//   task/createTask, completeTask, reassignTask, addSubtask
// execute() fabricated receipts (e.g. taskId = `stub_task_${Date.now()}`),
// and confirm() returned `false` to fail closed under the B2 invariant.
// This suite pins the real-provider behaviour:
//   - createTask, completeTask, addSubtask → real googleTasksService write
//     + provider read-back in confirm() (Google Tasks .get returns the row).
//   - reassignTask → fail-closed with an honest limitation message
//     (Google Tasks API has no cross-user owner field; delegate_open_item
//     is the supported alternative). confirm() stays false — nothing to
//     verify because nothing was written.

// ─── googleTasksService mocks ──────────────────────────────────────
const createTaskMock = vi.fn(async (..._a: any[]) => ({ id: 't_new', title: 'x', status: 'needsAction' } as any));
const markTaskDoneMock = vi.fn(async (..._a: any[]) => undefined);
const getTaskMock = vi.fn(async (..._a: any[]) => ({ id: 't_new', title: 'x', status: 'needsAction' } as any));
const findTaskByIdMock = vi.fn(async (..._a: any[]) => ({ taskListId: 'list_1', task: { id: 't_1', title: 'x', status: 'needsAction' } } as any));
const getTaskListsMock = vi.fn(async (..._a: any[]) => [{ id: 'list_1', title: 'My Tasks' }] as any[]);
const createSubtaskMock = vi.fn(async (..._a: any[]) => ({ id: 'sub_new', title: 'sx', parent: 't_parent' } as any));

vi.mock('../src/services/googleTasksService', () => ({
  createTask: (...a: any[]) => createTaskMock(...a),
  markTaskDone: (...a: any[]) => markTaskDoneMock(...a),
  getTask: (...a: any[]) => getTaskMock(...a),
  findTaskById: (...a: any[]) => findTaskByIdMock(...a),
  getTaskLists: (...a: any[]) => getTaskListsMock(...a),
  createSubtask: (...a: any[]) => createSubtaskMock(...a),
}));

import { CreateTaskHandler } from '../src/services/actions/handlers/task/createTask';
import { CompleteTaskHandler } from '../src/services/actions/handlers/task/completeTask';
import { ReassignTaskHandler } from '../src/services/actions/handlers/task/reassignTask';
import { AddSubtaskHandler } from '../src/services/actions/handlers/task/addSubtask';

beforeEach(() => {
  vi.clearAllMocks();
  createTaskMock.mockResolvedValue({ id: 't_new', title: 'Follow up with Ali', status: 'needsAction' });
  markTaskDoneMock.mockResolvedValue(undefined);
  getTaskMock.mockResolvedValue({ id: 't_new', title: 'Follow up with Ali', status: 'needsAction' });
  findTaskByIdMock.mockResolvedValue({
    taskListId: 'list_1',
    task: { id: 't_1', title: 'Follow up with Ali', status: 'needsAction' },
  });
  getTaskListsMock.mockResolvedValue([{ id: 'list_1', title: 'My Tasks' }]);
  createSubtaskMock.mockResolvedValue({ id: 'sub_new', title: 'Draft', parent: 't_parent' });
});

// ─── createTask ────────────────────────────────────────────────────

describe('CreateTaskHandler.execute', () => {
  const baseCtx = {
    clientNumber: 'tmc', userId: 2,
    payload: { title: 'Follow up with Ali', notes: 'call about invoice' },
  };

  it('creates a real Google Task on the default list when no taskListId given', async () => {
    const h = new CreateTaskHandler();
    const out = await h.execute(baseCtx as any);
    expect(getTaskListsMock).toHaveBeenCalledWith(2);
    expect(createTaskMock).toHaveBeenCalledWith(2, 'list_1', 'Follow up with Ali', 'call about invoice', undefined);
    expect(out.ok).toBe(true);
    expect((out.output as any).taskId).toBe('t_new');
    expect((out.output as any).taskListId).toBe('list_1');
  });

  it('uses the given taskListId when supplied (no default lookup)', async () => {
    const h = new CreateTaskHandler();
    const ctx = { ...baseCtx, payload: { ...baseCtx.payload, taskListId: 'list_work' } };
    const out = await h.execute(ctx as any);
    expect(getTaskListsMock).not.toHaveBeenCalled();
    expect(createTaskMock).toHaveBeenCalledWith(2, 'list_work', 'Follow up with Ali', 'call about invoice', undefined);
    expect(out.ok).toBe(true);
  });

  it('passes dueDate through to the provider', async () => {
    const due = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
    const h = new CreateTaskHandler();
    const out = await h.execute({ ...baseCtx, payload: { ...baseCtx.payload, dueDate: due } } as any);
    expect(createTaskMock).toHaveBeenCalledWith(2, 'list_1', 'Follow up with Ali', 'call about invoice', due);
    expect(out.ok).toBe(true);
  });

  it('fails closed when the user has no Google Tasks lists connected', async () => {
    getTaskListsMock.mockResolvedValue([]);
    const h = new CreateTaskHandler();
    const out = await h.execute(baseCtx as any);
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no google tasks list/i);
  });

  it('surfaces provider failure as ok:false', async () => {
    createTaskMock.mockRejectedValue(new Error('Google Tasks not connected'));
    const h = new CreateTaskHandler();
    const out = await h.execute(baseCtx as any);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not connected/i);
  });
});

describe('CreateTaskHandler.confirm', () => {
  it('reads the task back from Google Tasks and confirms when title matches', async () => {
    const h = new CreateTaskHandler();
    const output = { taskId: 't_new', taskListId: 'list_1', title: 'Follow up with Ali' };
    const ok = await h.confirm({ clientNumber: 'tmc', userId: 2, payload: { title: 'Follow up with Ali' } } as any, output);
    expect(getTaskMock).toHaveBeenCalledWith(2, 'list_1', 't_new');
    expect(ok).toBe(true);
  });

  it('returns false when the provider read-back throws (task not found)', async () => {
    getTaskMock.mockRejectedValue(new Error('404 not found'));
    const h = new CreateTaskHandler();
    const output = { taskId: 't_new', taskListId: 'list_1', title: 'Follow up with Ali' };
    const ok = await h.confirm({ clientNumber: 'tmc', userId: 2, payload: {} } as any, output);
    expect(ok).toBe(false);
  });

  it('returns false when output lacks taskId or taskListId', async () => {
    const h = new CreateTaskHandler();
    const ok = await h.confirm({ clientNumber: 'tmc', userId: 2, payload: {} } as any, {} as any);
    expect(ok).toBe(false);
  });
});

// ─── completeTask ──────────────────────────────────────────────────

describe('CompleteTaskHandler.execute', () => {
  const ctx = { clientNumber: 'tmc', userId: 2, payload: { taskId: 't_1' } };

  it('finds the task list via findTaskById and marks the task done', async () => {
    const h = new CompleteTaskHandler();
    const out = await h.execute(ctx as any);
    expect(findTaskByIdMock).toHaveBeenCalledWith(2, 't_1');
    expect(markTaskDoneMock).toHaveBeenCalledWith(2, 'list_1', 't_1');
    expect(out.ok).toBe(true);
    expect((out.output as any).taskId).toBe('t_1');
    expect((out.output as any).taskListId).toBe('list_1');
    expect((out.output as any).previousStatus).toBe('needsAction');
  });

  it('fails closed when the task is not found in any list (no blind write)', async () => {
    findTaskByIdMock.mockResolvedValue(null);
    const h = new CompleteTaskHandler();
    const out = await h.execute(ctx as any);
    expect(markTaskDoneMock).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not found/i);
  });

  it('surfaces provider failure as ok:false', async () => {
    markTaskDoneMock.mockRejectedValue(new Error('403 forbidden'));
    const h = new CompleteTaskHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/forbidden/i);
  });

  it('is idempotent: task already completed → ok without a second write', async () => {
    findTaskByIdMock.mockResolvedValue({
      taskListId: 'list_1',
      task: { id: 't_1', title: 'x', status: 'completed' },
    });
    const h = new CompleteTaskHandler();
    const out = await h.execute(ctx as any);
    expect(markTaskDoneMock).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
    expect((out.output as any).previousStatus).toBe('completed');
  });
});

describe('CompleteTaskHandler.confirm', () => {
  it('reads the task back and confirms status is completed', async () => {
    getTaskMock.mockResolvedValue({ id: 't_1', title: 'x', status: 'completed' });
    const h = new CompleteTaskHandler();
    const output = { taskId: 't_1', taskListId: 'list_1' };
    const ok = await h.confirm({ clientNumber: 'tmc', userId: 2, payload: { taskId: 't_1' } } as any, output);
    expect(getTaskMock).toHaveBeenCalledWith(2, 'list_1', 't_1');
    expect(ok).toBe(true);
  });

  it('returns false when the task read-back shows status still needsAction', async () => {
    getTaskMock.mockResolvedValue({ id: 't_1', title: 'x', status: 'needsAction' });
    const h = new CompleteTaskHandler();
    const output = { taskId: 't_1', taskListId: 'list_1' };
    const ok = await h.confirm({ clientNumber: 'tmc', userId: 2, payload: { taskId: 't_1' } } as any, output);
    expect(ok).toBe(false);
  });

  it('returns false when provider read-back throws', async () => {
    getTaskMock.mockRejectedValue(new Error('unreachable'));
    const h = new CompleteTaskHandler();
    const output = { taskId: 't_1', taskListId: 'list_1' };
    const ok = await h.confirm({ clientNumber: 'tmc', userId: 2, payload: {} } as any, output);
    expect(ok).toBe(false);
  });
});

// ─── reassignTask ──────────────────────────────────────────────────

describe('ReassignTaskHandler.execute', () => {
  const ctx = { clientNumber: 'tmc', userId: 2, payload: { taskId: 't_1', newAssigneeUserId: 3 } };

  it('fail-closes with an honest limitation message (Google Tasks has no cross-user owner)', async () => {
    const h = new ReassignTaskHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/google\s+tasks/i);
    expect(out.error).toMatch(/reassign|owner|cross-user/i);
    // Must not have called ANY provider write on the fail-closed path.
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(markTaskDoneMock).not.toHaveBeenCalled();
    expect(findTaskByIdMock).not.toHaveBeenCalled();
  });

  it("error message points the user to the supported alternative (delegate_open_item)", async () => {
    const h = new ReassignTaskHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/delegate_open_item/i);
  });
});

describe('ReassignTaskHandler.confirm', () => {
  it('returns false (nothing was written; nothing to verify)', async () => {
    const h = new ReassignTaskHandler();
    const ok = await h.confirm({ clientNumber: 'tmc', userId: 2, payload: {} } as any, {} as any);
    expect(ok).toBe(false);
  });
});

// ─── addSubtask ────────────────────────────────────────────────────

describe('AddSubtaskHandler.execute', () => {
  const ctx = {
    clientNumber: 'tmc', userId: 2,
    payload: { parentTaskId: 't_parent', title: 'Draft the outline', notes: 'section 1' },
  };

  it('locates the parent task list via findTaskById and creates a real subtask', async () => {
    findTaskByIdMock.mockResolvedValue({
      taskListId: 'list_1',
      task: { id: 't_parent', title: 'Prep report', status: 'needsAction' },
    });
    const h = new AddSubtaskHandler();
    const out = await h.execute(ctx as any);
    expect(findTaskByIdMock).toHaveBeenCalledWith(2, 't_parent');
    expect(createSubtaskMock).toHaveBeenCalledWith(2, 'list_1', 't_parent', 'Draft the outline', 'section 1');
    expect(out.ok).toBe(true);
    expect((out.output as any).subtaskId).toBe('sub_new');
    expect((out.output as any).parentTaskId).toBe('t_parent');
    expect((out.output as any).taskListId).toBe('list_1');
  });

  it('fails closed when the parent task cannot be located (no blind write)', async () => {
    findTaskByIdMock.mockResolvedValue(null);
    const h = new AddSubtaskHandler();
    const out = await h.execute(ctx as any);
    expect(createSubtaskMock).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/parent.*not found/i);
  });

  it('surfaces provider write failure as ok:false', async () => {
    createSubtaskMock.mockRejectedValue(new Error('quota exceeded'));
    const h = new AddSubtaskHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/quota/i);
  });
});

describe('AddSubtaskHandler.confirm', () => {
  it('reads the subtask back and confirms parent linkage', async () => {
    getTaskMock.mockResolvedValue({ id: 'sub_new', title: 'Draft', parent: 't_parent', status: 'needsAction' });
    const h = new AddSubtaskHandler();
    const output = { subtaskId: 'sub_new', taskListId: 'list_1', parentTaskId: 't_parent' };
    const ok = await h.confirm({ clientNumber: 'tmc', userId: 2, payload: {} } as any, output);
    expect(getTaskMock).toHaveBeenCalledWith(2, 'list_1', 'sub_new');
    expect(ok).toBe(true);
  });

  it('returns false when the read-back shows a different parent (linkage broken)', async () => {
    getTaskMock.mockResolvedValue({ id: 'sub_new', title: 'Draft', parent: 'wrong_parent', status: 'needsAction' });
    const h = new AddSubtaskHandler();
    const output = { subtaskId: 'sub_new', taskListId: 'list_1', parentTaskId: 't_parent' };
    const ok = await h.confirm({ clientNumber: 'tmc', userId: 2, payload: {} } as any, output);
    expect(ok).toBe(false);
  });

  it('returns false when provider read-back throws', async () => {
    getTaskMock.mockRejectedValue(new Error('404'));
    const h = new AddSubtaskHandler();
    const output = { subtaskId: 'sub_new', taskListId: 'list_1', parentTaskId: 't_parent' };
    const ok = await h.confirm({ clientNumber: 'tmc', userId: 2, payload: {} } as any, output);
    expect(ok).toBe(false);
  });
});
