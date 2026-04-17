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
