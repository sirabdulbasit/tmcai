/**
 * MyOS — Google Chat (Personal) Service
 *
 * Sister to googleTasksService.ts but for Chat. Uses the user's OAuth
 * token (same one that powers Gmail/Calendar/Tasks) to read spaces and
 * recent messages.
 *
 * IMPORTANT distinction from src/services/connectors/GoogleChatConnector.ts:
 *   - That file = service-account / bot model. Used for OUTBOUND replies
 *     posted under a tenant-managed bot identity into spaces where the
 *     bot is invited.
 *   - This file = user-OAuth model. Used for INBOUND polling — what
 *     spaces is THIS user in, what did they recently say / receive.
 *
 * Coverage caveat: Google Chat API restricts message reads to spaces
 * where the calling identity is a member. For personal Gmail accounts
 * that's typically just DMs + group chats the user joined. Workspace
 * accounts can have admin-level visibility configured. The poller fails
 * open if a space rejects the read — we log and skip.
 */
import { getAuthenticatedClient } from './integrationService';

export async function getSpaces(userId: number) {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client || error) throw new Error(error || 'Google Chat not connected');

  const { google } = await import('googleapis');
  const chat = google.chat({ version: 'v1', auth: client });
  const spaces: any[] = [];
  let pageToken: string | undefined;
  // Cap at ~5 pages (≈500 spaces) to bound work; busy users on Workspace
  // can have hundreds of group chats.
  for (let i = 0; i < 5; i++) {
    const res: any = await chat.spaces.list({
      pageSize: 100,
      pageToken,
    } as any).catch((err: any) => {
      // Permission denied → return empty rather than throw, so the
      // poller can move on instead of failing the whole tick.
      if (String(err?.message ?? '').toLowerCase().includes('permission')) return null;
      throw err;
    });
    if (!res || !res.data) break;
    if (Array.isArray(res.data.spaces)) spaces.push(...res.data.spaces);
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }
  return spaces;
}

export async function getRecentMessages(userId: number, spaceName: string, sinceIso?: string) {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client || error) throw new Error(error || 'Google Chat not connected');

  const { google } = await import('googleapis');
  const chat = google.chat({ version: 'v1', auth: client });
  // Filter syntax docs: https://developers.google.com/chat/api/reference/rest/v1/spaces.messages/list
  const filter = sinceIso ? `createTime > "${sinceIso}"` : undefined;
  const res = await chat.spaces.messages.list({
    parent: spaceName,
    pageSize: 50,
    filter,
  } as any).catch((err: any) => {
    if (String(err?.message ?? '').toLowerCase().includes('permission')) return null;
    throw err;
  });
  return res?.data?.messages ?? [];
}

/**
 * High-level: pull recent messages across every space the user can read.
 * Returns a flat array tagged with the source space so the caller can
 * write each into feed_events. Default lookback: 24h.
 */
export async function getAllRecentMessages(userId: number, lookbackHours = 24) {
  const spaces = await getSpaces(userId).catch(() => [] as any[]);
  if (spaces.length === 0) return [];

  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const all: any[] = [];
  for (const space of spaces) {
    if (!space.name) continue;
    const msgs = await getRecentMessages(userId, space.name, since).catch(() => [] as any[]);
    for (const m of msgs) {
      all.push({
        ...m,
        spaceName: space.name,
        spaceDisplayName: space.displayName ?? space.name,
        spaceType: space.spaceType ?? null,
      });
    }
  }
  return all;
}
