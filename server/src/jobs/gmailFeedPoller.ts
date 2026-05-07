import prisma from '../db/prisma';
import { getInbox, readEmail } from '../services/adapters/gmailAdapter';
import { ingest } from '../services/feed/feedIngestionService';
import { isFeatureEnabled } from '../services/featureFlagService';
import { stampConnectorSync } from '../services/connectorSyncTracker';

/**
 * HaseebOS v15 — Gmail polling bridge.
 *
 * For every user with an active Google integration (`integrationProvider='google'`,
 * `integration_status='active'`), fetch the last N inbox messages and push each
 * novel thread into `feed_events` via feedIngestionService. Dedup by the Gmail
 * message ID — content hash is canonicalized on source-id alone.
 *
 * This is a stop-gap until Gmail Push API (pub/sub watch) is wired.
 *
 * Feature flag: `feature_feed_ingestion_pubsub` — when off, the poller is a
 * no-op so the default deploy doesn't spam feed.raw during development.
 */

// Per-tick cap. 100 covers a very active MD's daily inflow. Initial historical
// backfill is done separately via scripts/backfillTodayGmail.ts or a future
// backfill endpoint — the steady-state poller just catches "what's new since
// last tick" and dedup by sourceId drops anything already seen.
const MAX_PER_USER = 100;

interface PollResult {
  userId: number;
  clientNumber: string;
  fetched: number;
  ingested: number;
  duplicates: number;
  errors: number;
}

export async function pollAllActiveUsers(): Promise<PollResult[]> {
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      integrationProvider: 'google',
      integrationStatus: 'active',
    },
    select: { id: true, clientNumber: true },
  });

  const results: PollResult[] = [];
  for (const u of users) {
    const enabled = await isFeatureEnabled(u.clientNumber, 'feature_feed_ingestion_pubsub', false);
    if (!enabled) continue;
    try {
      const r = await pollUser(u.id, u.clientNumber);
      results.push(r);
    } catch (err: any) {
      console.warn(`[gmailPoll] user=${u.id} failed: ${err.message}`);
      results.push({ userId: u.id, clientNumber: u.clientNumber, fetched: 0, ingested: 0, duplicates: 0, errors: 1 });
    }
  }
  return results;
}

async function pollUser(userId: number, clientNumber: string): Promise<PollResult> {
  const r = await getInbox(userId, MAX_PER_USER);
  const emails = (r.emails ?? []) as Array<{ id: string; threadId: string; subject: string; from: string; snippet: string; date: string }>;

  let ingested = 0;
  let duplicates = 0;
  let errors = 0;

  for (const e of emails) {
    try {
      const result = await ingest({
        clientNumber,
        userId,
        sourceType: 'gmail',
        sourceId: e.id,
        sender: { email: e.from },
        payload: {
          userId,
          threadId: e.threadId,
          subject: e.subject,
          from: e.from,
          snippet: e.snippet,
          date: e.date,
        },
      });
      if (result.status === 'new') ingested += 1;
      else if (result.status === 'duplicate') duplicates += 1;
      else errors += 1;
    } catch (err: any) {
      errors += 1;
      console.warn(`[gmailPoll] ingest failed user=${userId} msg=${e.id}: ${err.message}`);
    }
  }

  // Surface freshness to the UI — Day Brief reads userConnector.lastSyncAt
  // for "Last synced X ago". Stamp regardless of whether new mail arrived
  // so an idle poll still proves the channel is alive.
  await stampConnectorSync(userId, ['gmail']);

  return { userId, clientNumber, fetched: emails.length, ingested, duplicates, errors };
}

/**
 * Enrich a specific Gmail feed event by fetching the full message body.
 * Called lazily by the Feed Curator agent when it needs the body for triage.
 */
export async function enrichBody(feedEventId: string, clientNumber: string): Promise<void> {
  const event = await prisma.feedEvent.findFirst({
    where: { id: feedEventId, clientNumber, sourceType: 'gmail' },
    select: { sourceId: true, rawPayload: true },
  });
  if (!event) return;
  const userId = (event.rawPayload as any)?.userId as number | undefined;
  if (!userId) return;
  const r = await readEmail(userId, event.sourceId);
  if (!r.email) return;
  const payload = (event.rawPayload as Record<string, unknown>) ?? {};
  await prisma.feedEvent.updateMany({
    where: { id: feedEventId, clientNumber },
    data: { rawPayload: { ...payload, body: r.email.body, attachments: r.email.attachments } as any },
  });
}
