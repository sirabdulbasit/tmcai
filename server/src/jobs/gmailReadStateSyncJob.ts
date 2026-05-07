/**
 * Gmail read-state sync.
 *
 * User feedback (2026-05-07): "I'm also reading email and responding
 * — emails get marked read in Gmail, Brain doesn't know." Without
 * this job, feed_events show every ingested email as if it still
 * needs attention even after the user has handled it directly in
 * Gmail.
 *
 * This job queries Gmail for the user's CURRENT unread message IDs
 * (a single cheap list-messages call with q='is:unread') and updates
 * feed_events.rawPayload.isUnread accordingly. After each tick:
 *   - feed_events whose Gmail message is still UNREAD: isUnread=true
 *   - feed_events whose Gmail message is now read:     isUnread=false
 *
 * buildAttentionList then filters out feed_events where isUnread
 * is explicitly false, so emails the user already read in Gmail stop
 * surfacing as "needs you" on Day Brief.
 *
 * Cadence: every 5 min (alongside the 2-min ingestion poll). Cheap
 * call — Gmail returns just IDs, no body, capped at 500.
 *
 * Scope: only feed_events from the last 30 days (the attention
 * window). Older rows get pruned anyway and don't need state sync.
 *
 * Per-user, fails open: if a user's OAuth is dead, log + skip; the
 * job moves on to the next user.
 */
import prisma from '../db/prisma';
import { getAuthenticatedClient } from '../services/integrationService';

export interface ReadStateSyncResult {
  userId: number;
  clientNumber: string;
  scanned: number;
  updated: number;
  errors: number;
}

export async function syncAllActiveGmailUsers(): Promise<ReadStateSyncResult[]> {
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      integrationProvider: 'google',
      integrationStatus: 'active',
    },
    select: { id: true, clientNumber: true },
  });

  const results: ReadStateSyncResult[] = [];
  for (const u of users) {
    try {
      const r = await syncForUser(u.id, u.clientNumber);
      results.push(r);
    } catch (err: any) {
      console.warn(`[gmailReadSync] user=${u.id} failed: ${err.message}`);
      results.push({ userId: u.id, clientNumber: u.clientNumber, scanned: 0, updated: 0, errors: 1 });
    }
  }
  return results;
}

async function syncForUser(userId: number, clientNumber: string): Promise<ReadStateSyncResult> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client || error) {
    return { userId, clientNumber, scanned: 0, updated: 0, errors: 1 };
  }

  const { google } = await import('googleapis');
  const gmail = google.gmail({ version: 'v1', auth: client });

  // Pull every currently unread message ID (capped at 500).
  // q='is:unread' is the Gmail filter syntax; cheap because we
  // request format=metadata-equivalent (just IDs, no bodies).
  const unreadSet = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {  // up to 5 pages = 2500 IDs max
    const res: any = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 500,
      pageToken,
    } as any).catch(() => null);
    if (!res || !res.data) break;
    for (const m of res.data.messages ?? []) {
      if (m.id) unreadSet.add(m.id);
    }
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }

  // Pull threadIds where the user has SENT at least one message in the
  // last 30 days. This is the "have I replied on this conversation?"
  // signal regardless of how the reply was sent (Brain draft, Gmail
  // compose, mobile app, anywhere). The list response already includes
  // threadId per row — no per-message fetch needed.
  // Without this, threads the user replied to directly in Gmail kept
  // surfacing on My Attention because Brain's internal decision_log
  // had no record of those replies.
  const repliedThreadSet = new Set<string>();
  pageToken = undefined;
  for (let page = 0; page < 4; page++) {  // up to 4 pages = 2000 sent
    const res: any = await gmail.users.messages.list({
      userId: 'me',
      q: 'in:sent newer_than:30d',
      maxResults: 500,
      pageToken,
    } as any).catch(() => null);
    if (!res || !res.data) break;
    for (const m of res.data.messages ?? []) {
      if (m.threadId) repliedThreadSet.add(m.threadId);
    }
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }

  // Fetch this user's gmail feed_events from the last 30 days.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const events = await prisma.feedEvent.findMany({
    where: {
      clientNumber, userId,
      sourceType: 'gmail',
      createdAt: { gte: thirtyDaysAgo },
    } as any,
    select: { id: true, sourceId: true, rawPayload: true },
  });

  let updated = 0;
  for (const ev of events) {
    const cur: any = ev.rawPayload ?? {};
    const nowUnread = unreadSet.has(ev.sourceId);
    const tid = cur?.threadId as string | undefined;
    const nowReplied = !!(tid && repliedThreadSet.has(tid));
    // Skip if both states already match (avoid pointless writes).
    if (cur.isUnread === nowUnread && cur.userRepliedThread === nowReplied) continue;
    try {
      await prisma.feedEvent.update({
        where: { id: ev.id },
        data: { rawPayload: { ...cur, isUnread: nowUnread, userRepliedThread: nowReplied } },
      });
      updated += 1;
    } catch {
      /* best effort */
    }
  }

  // State changed → invalidate triage cache so /brief/attention
  // reflects the new userRepliedThread / isUnread values.
  if (updated > 0) {
    const { clearTriageCache } = await import('../services/triage/triageSuggester');
    clearTriageCache();
  }

  return { userId, clientNumber, scanned: events.length, updated, errors: 0 };
}
