/**
 * MyOS — Google Tasks polling bridge.
 *
 * Mirror of gcalFeedPoller for the Tasks API. For every user with an
 * active Google integration, pull every task across every list and
 * push each into `feed_events` (sourceType='gtasks'). Each task is
 * stamped userId so per-user scoping works. Dedup by task.id via
 * content hash.
 *
 * Why: today Day Brief's "Tasks" tile reads from Brain's internal
 * `open_items` queue, not from Google Tasks. The user has 122 Google
 * Tasks across 6 lists; Brain saw 2. This poller closes that gap by
 * ingesting tasks into feed_events; the existing triage path then
 * either surfaces them in My Attention's Tasks tab or routes them to
 * Brief's auto-handled buckets.
 */
import prisma from '../db/prisma';
import * as gtasks from '../services/adapters/googleTasksAdapter';
import { ingest } from '../services/feed/feedIngestionService';

export interface GtasksPollResult {
  userId: number;
  clientNumber: string;
  fetched: number;
  ingested: number;
  duplicates: number;
  errors: number;
}

export async function pollAllActiveTasksUsers(): Promise<GtasksPollResult[]> {
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      integrationProvider: 'google',
      integrationStatus: 'active',
    },
    select: { id: true, clientNumber: true },
  });

  const results: GtasksPollResult[] = [];
  for (const u of users) {
    try {
      const r = await pollUser(u.id, u.clientNumber);
      results.push(r);
    } catch (err: any) {
      console.warn(`[gtasksPoll] user=${u.id} failed: ${err.message}`);
      results.push({ userId: u.id, clientNumber: u.clientNumber, fetched: 0, ingested: 0, duplicates: 0, errors: 1 });
    }
  }
  return results;
}

async function pollUser(userId: number, clientNumber: string): Promise<GtasksPollResult> {
  const tasks = await gtasks.getAllTasks(userId).catch(() => [] as any[]);

  let ingested = 0, duplicates = 0, errors = 0;

  for (const t of tasks) {
    if (!t.id) continue;
    try {
      const r = await ingest({
        clientNumber,
        userId,
        sourceType: 'gtasks',
        sourceId: t.id,
        sender: { email: undefined, name: t.taskListTitle ?? undefined },
        eventType: 'task_assigned',
        payload: {
          userId,
          taskId: t.id,
          taskListId: t.taskListId,
          taskListTitle: t.taskListTitle,
          title: t.title ?? '(untitled task)',
          notes: t.notes ?? '',
          due: t.due ?? null,
          updated: t.updated ?? null,
          status: t.status ?? 'needsAction',
          link: t.webViewLink ?? null,
        },
      });
      if (r.status === 'new') ingested += 1;
      else if (r.status === 'duplicate') duplicates += 1;
      else errors += 1;
    } catch (err: any) {
      errors += 1;
      console.warn(`[gtasksPoll] ingest failed user=${userId} task=${t.id}: ${err.message}`);
    }
  }

  return { userId, clientNumber, fetched: tasks.length, ingested, duplicates, errors };
}
