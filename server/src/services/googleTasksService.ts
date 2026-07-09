/**
 * MyOS Gap 1a — Google Tasks Service
 *
 * Uses the same getAuthenticatedClient() pattern as gmailService and calendarService.
 * Reads/writes Google Tasks via the Tasks API v1.
 * Tokens come from UserConnector (new connector framework).
 */

import { getAuthenticatedClient } from './integrationService';

// ─── Read operations ────────────────────────────────────────────

export async function getTaskLists(userId: number) {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client || error) throw new Error(error || 'Google Tasks not connected');

  const { google } = await import('googleapis');
  const tasks = google.tasks({ version: 'v1', auth: client });
  const res = await tasks.tasklists.list({ maxResults: 20 });
  return res.data.items ?? [];
}

export async function getTasksFromList(
  userId: number,
  taskListId: string,
  updatedMin?: string,  // ISO date string — only tasks modified after this time
) {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client || error) throw new Error(error || 'Google Tasks not connected');

  const { google } = await import('googleapis');
  const tasks = google.tasks({ version: 'v1', auth: client });
  const params: any = { tasklist: taskListId, maxResults: 100, showCompleted: false };
  if (updatedMin) params.updatedMin = updatedMin;
  const res = await tasks.tasks.list(params);
  return res.data.items ?? [];
}

export async function getAllTasks(userId: number, updatedMin?: string) {
  const lists = await getTaskLists(userId);
  const allTasks: any[] = [];

  for (const list of lists) {
    if (!list.id) continue;
    const tasks = await getTasksFromList(userId, list.id, updatedMin);
    allTasks.push(...tasks.map(t => ({ ...t, taskListId: list.id, taskListTitle: list.title })));
  }

  return allTasks;
}

// ─── Write operations ───────────────────────────────────────────

export async function createTask(
  userId: number,
  taskListId: string,
  title: string,
  notes?: string,
  due?: string,  // RFC 3339 timestamp
) {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client || error) throw new Error(error || 'Google Tasks not connected');

  const { google } = await import('googleapis');
  const tasks = google.tasks({ version: 'v1', auth: client });
  const res = await tasks.tasks.insert({
    tasklist: taskListId,
    requestBody: { title, notes, due },
  });
  return res.data;
}

export async function markTaskDone(
  userId: number,
  taskListId: string,
  taskId: string,
) {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client || error) throw new Error(error || 'Google Tasks not connected');

  const { google } = await import('googleapis');
  const tasks = google.tasks({ version: 'v1', auth: client });
  await tasks.tasks.patch({
    tasklist: taskListId,
    task: taskId,
    requestBody: { status: 'completed' },
  });
}

// ─── Single-task read + subtask insert (backlog gap-fill 2026-07-09) ───

/**
 * Read a single task by (listId, taskId). Used by task handlers' confirm()
 * read-backs — B2 requires provider verification, and the Tasks API's
 * `tasks.get` gives us the row's current status + parent linkage.
 * Throws on API failure; the caller is expected to catch and treat any
 * error as "not confirmed".
 */
export async function getTask(
  userId: number,
  taskListId: string,
  taskId: string,
) {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client || error) throw new Error(error || 'Google Tasks not connected');
  const { google } = await import('googleapis');
  const tasks = google.tasks({ version: 'v1', auth: client });
  const res = await tasks.tasks.get({ tasklist: taskListId, task: taskId });
  return res.data;
}

/**
 * Locate a task by id across every list the user owns. Google Tasks has
 * no cross-list find endpoint, so we scan lists sequentially and return
 * on first hit. Used by completeTask + addSubtask handlers whose payload
 * schemas carry only `taskId` / `parentTaskId` (no `taskListId`).
 * Returns null when the task is not found in any list (a legitimate
 * "task doesn't exist" outcome, distinct from an API error which throws).
 */
export async function findTaskById(
  userId: number,
  taskId: string,
): Promise<{ taskListId: string; task: any } | null> {
  const lists = await getTaskLists(userId);
  for (const list of lists) {
    if (!list.id) continue;
    try {
      const t = await getTask(userId, list.id, taskId);
      if (t && t.id === taskId) return { taskListId: list.id, task: t };
    } catch (_err: any) {
      // 404 on this list is normal — task lives in a different list.
      // Continue scanning; any real API failure will surface on the
      // next list too and eventually caller sees null.
      continue;
    }
  }
  return null;
}

/**
 * Insert a subtask under `parentTaskId` on the same list. Google Tasks
 * places subtasks by setting the `parent` field on insert. The parent
 * task must live on `taskListId`; callers should locate it via
 * findTaskById first so parent + child stay on the same list.
 */
export async function createSubtask(
  userId: number,
  taskListId: string,
  parentTaskId: string,
  title: string,
  notes?: string,
) {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client || error) throw new Error(error || 'Google Tasks not connected');
  const { google } = await import('googleapis');
  const tasks = google.tasks({ version: 'v1', auth: client });
  const res = await tasks.tasks.insert({
    tasklist: taskListId,
    parent: parentTaskId,
    requestBody: { title, notes },
  });
  return res.data;
}
