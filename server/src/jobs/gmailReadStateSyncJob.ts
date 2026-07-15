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

  // MD's own email — used below to identify outbound feed_events for
  // the per-thread userRepliedThread timestamp check. Prefer
  // integrationEmail (the email Gmail is connected as) over user.email,
  // since some users have a different login email than mailbox.
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, integrationEmail: true },
  });
  const mdEmail = (userRow?.integrationEmail || userRow?.email || '').toLowerCase();
  if (!mdEmail) {
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

  // Build a map of (threadId → timestamp of MD's LATEST sent message).
  // Per MD 2026-05-13: previously this was just a Set<threadId>, which
  // meant once MD replied to a thread, every later message in that
  // thread got silently filtered as "you-replied" even if N people had
  // replied AFTER MD. Concrete failure:
  //   May 11 19:24  basit.ahmed@      (MD replied)
  //   May 13 11:31  umair@            (new — needs MD's eyes)
  //   May 13 12:02  quddus.mohiuddin@ (new — needs MD's eyes)
  // The Quddus + Umair messages were correctly ingested but
  // suppressed because the set-only check marked the whole thread as
  // "user replied" forever. The fix: track MD's latest sent time per
  // thread and only set userRepliedThread=true when MD's reply is
  // newer than the message we're evaluating.
  //
  // We use feed_events as the source of truth (MD's outbound is
  // ingested with internalDate via the Gmail sync). Cheaper and more
  // accurate than per-message Gmail API fetches.
  const mdSentRows = await prisma.$queryRawUnsafe<Array<{ thread_id: string | null; latest_ms: string }>>(
    `SELECT raw_payload->>'threadId' AS thread_id,
            MAX(COALESCE(
              (raw_payload->>'internalDate')::bigint,
              EXTRACT(EPOCH FROM (raw_payload->>'date')::timestamptz)::bigint * 1000,
              EXTRACT(EPOCH FROM created_at)::bigint * 1000
            )) AS latest_ms
       FROM feed_events
      WHERE source_type = 'gmail'
        AND user_id = $1
        AND client_number = $2
        AND sender_email = $3
        AND created_at >= NOW() - interval '30 days'
        AND raw_payload->>'threadId' IS NOT NULL
      GROUP BY raw_payload->>'threadId'`,
    userId, clientNumber, mdEmail,
  ).catch(() => [] as Array<{ thread_id: string | null; latest_ms: string }>);

  const mdLatestPerThread = new Map<string, number>();
  for (const r of mdSentRows) {
    if (r.thread_id) mdLatestPerThread.set(r.thread_id, Number(r.latest_ms));
  }

  // Fetch this user's gmail feed_events from the last 30 days.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const events = await prisma.feedEvent.findMany({
    where: {
      clientNumber, userId,
      sourceType: 'gmail',
      createdAt: { gte: thirtyDaysAgo },
    } as any,
    select: { id: true, sourceId: true, rawPayload: true, createdAt: true },
  });

  let updated = 0;
  for (const ev of events) {
    const cur: any = ev.rawPayload ?? {};
    const nowUnread = unreadSet.has(ev.sourceId);
    const tid = cur?.threadId as string | undefined;

    // userRepliedThread is true ONLY when MD's latest reply in this
    // thread is newer than (or equal to) this specific event's time.
    // If a colleague has replied AFTER MD's last message, this event
    // is part of unanswered activity and must surface.
    let nowReplied = false;
    if (tid) {
      const mdLatest = mdLatestPerThread.get(tid);
      if (mdLatest !== undefined) {
        // This event's timestamp — prefer internalDate, fall back to date header, then created_at.
        let evMs: number = 0;
        const intDate = cur?.internalDate;
        if (intDate && !Number.isNaN(Number(intDate))) {
          evMs = Number(intDate);
        } else if (cur?.date) {
          const parsed = Date.parse(String(cur.date));
          if (!Number.isNaN(parsed)) evMs = parsed;
        }
        if (evMs === 0) evMs = ev.createdAt.getTime();
        // If MD's latest reply is at or after this event's time, MD has
        // already responded to this (or later) — suppress. Otherwise
        // this is new activity for MD to see.
        nowReplied = mdLatest >= evMs;
      }
    }

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
