/**
 * MyOS — Historical Feed Pull.
 *
 * When a user newly connects a source (Gmail / Calendar / etc.), there
 * are no feed_events to scribe from yet. This service pulls the past N
 * days of history FROM THE SOURCE API into feed_events, then chains into
 * the senderWiki backfill so Brain has a full running memory from the
 * moment the connector goes live.
 *
 * Triggered automatically by `connectorService.testAndConnect` when a
 * fresh connector flips to status='connected'. Also callable manually
 * via POST /brief/rebuild-memory-from-source.
 *
 * Bounded cost:
 *   - Gmail: last 30 days OR 500 messages, whichever comes first
 *   - Calendar: 30 days back, 60 days forward
 *   - Backfill resummarize: capped at 100 distinct senders
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { ingest as ingestFeedEvent } from '../feed/feedIngestionService';

const log = createLogger('historical-feed-pull');

export interface PullSummary {
  slug: string;
  userId: number;
  clientNumber: string;
  fetched: number;
  ingested: number;
  duplicates: number;
  errors: number;
  durationMs: number;
}

export interface PullOptions {
  /** Gmail: how far back to pull in days (default 30). */
  gmailDays?: number;
  /** Gmail: absolute cap on messages (default 500). */
  gmailCap?: number;
  /** Calendar: days back (default 30). */
  calendarDaysBack?: number;
  /** Calendar: days forward (default 60). */
  calendarDaysAhead?: number;
}

/**
 * Pull historical messages from a connector into feed_events.
 * Safe to call more than once — ingest dedupes by contentHash.
 */
export async function pullHistoricalFeed(
  clientNumber: string,
  userId: number,
  slug: string,
  opts: PullOptions = {},
): Promise<PullSummary> {
  const t0 = Date.now();
  const summary: PullSummary = {
    slug, userId, clientNumber,
    fetched: 0, ingested: 0, duplicates: 0, errors: 0,
    durationMs: 0,
  };

  try {
    if (slug === 'gmail') {
      await pullGmailHistory(clientNumber, userId, summary, opts);
    } else if (slug === 'google_calendar') {
      await pullCalendarHistory(clientNumber, userId, summary, opts);
    } else {
      log.info('no historical puller for slug', { slug });
    }
  } catch (err: any) {
    log.warn('historical pull failed', { slug, userId, error: err.message });
    summary.errors += 1;
  }

  summary.durationMs = Date.now() - t0;
  return summary;
}

async function pullGmailHistory(
  clientNumber: string,
  userId: number,
  summary: PullSummary,
  opts: PullOptions,
): Promise<void> {
  const days = opts.gmailDays ?? 30;
  const cap = opts.gmailCap ?? 500;

  const { google } = await import('googleapis');
  // Reuse the integrationService auth helper that gmailService uses
  const { getAuthenticatedClient } = await import('../integrationService');
  const authResult = await getAuthenticatedClient(userId);
  const client = authResult?.client;
  if (!client) { log.warn('no Gmail auth', { userId }); return; }

  const gmail = google.gmail({ version: 'v1', auth: client });
  const after = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const afterStr = `${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;

  let pageToken: string | undefined;
  let pulled = 0;

  while (pulled < cap) {
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: `after:${afterStr}`,
      maxResults: Math.min(100, cap - pulled),
      ...(pageToken ? { pageToken } : {}),
    }).catch((e: any) => { log.warn('gmail list failed', { error: e.message }); return null; });

    if (!list?.data?.messages?.length) break;

    for (const m of list.data.messages) {
      if (pulled >= cap) break;
      try {
        const msg = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
        const headers = (msg.data.payload?.headers ?? []) as Array<{ name?: string; value?: string }>;
        const h = (n: string) => headers.find((x) => (x.name || '').toLowerCase() === n)?.value ?? '';
        const fromHdr = h('from');
        const emailMatch = fromHdr.match(/<([^>]+)>/) ?? fromHdr.match(/([\w.\-+]+@[\w.\-]+)/);
        const fromEmail = emailMatch?.[1] || fromHdr;
        const fromName = fromHdr.replace(/<[^>]+>/, '').replace(/"/g, '').trim();

        summary.fetched += 1;
        pulled += 1;

        const r = await ingestFeedEvent({
          clientNumber,
          userId,
          sourceType: 'gmail',
          sourceId: msg.data.id!,
          eventType: msg.data.threadId ? 'thread_updated' : 'message_received',
          sender: { email: fromEmail, name: fromName },
          payload: {
            userId,
            threadId: msg.data.threadId,
            subject: h('subject'),
            from: fromEmail,
            fromName,
            snippet: msg.data.snippet ?? '',
            date: h('date'),
          },
        });
        if (r.status === 'new') summary.ingested += 1;
        else if (r.status === 'duplicate') summary.duplicates += 1;
        else summary.errors += 1;
      } catch (err: any) {
        summary.errors += 1;
        log.warn('gmail msg ingest failed', { id: m.id, error: err.message });
      }
    }

    pageToken = list.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
}

async function pullCalendarHistory(
  clientNumber: string,
  userId: number,
  summary: PullSummary,
  opts: PullOptions,
): Promise<void> {
  const daysBack = opts.calendarDaysBack ?? 30;
  const daysAhead = opts.calendarDaysAhead ?? 60;
  const { getEvents } = await import('../calendarService');
  const timeMin = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const timeMax = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  const r = await getEvents(userId, timeMin, timeMax, 250).catch(() => ({ events: [] as any[] }));
  for (const e of r.events || []) {
    try {
      summary.fetched += 1;
      const result = await ingestFeedEvent({
        clientNumber, userId,
        sourceType: 'gcal',
        sourceId: e.id,
        sender: { email: (e as any).organizer ?? null } as any,
        eventType: 'meeting_invite',
        payload: {
          userId,
          eventId: e.id,
          title: e.title,
          description: e.description,
          start: e.start,
          end: e.end,
          location: e.location,
          attendees: e.attendees,
          organizer: e.organizer,
          isAllDay: e.isAllDay,
        },
      });
      if (result.status === 'new') summary.ingested += 1;
      else if (result.status === 'duplicate') summary.duplicates += 1;
      else summary.errors += 1;
    } catch (err: any) {
      summary.errors += 1;
      log.warn('calendar ingest failed', { id: e.id, error: err.message });
    }
  }
}

/**
 * Top-level orchestrator: pull history for every connected connector
 * the user has, then trigger senderWiki backfill. This is what you call
 * when onboarding a new user or after they connect a fresh source.
 */
export async function warmUpBrainFromSources(clientNumber: string, userId: number, opts: PullOptions = {}): Promise<{
  pulls: PullSummary[];
  wikiBackfill: any;
}> {
  const connectors = await prisma.userConnector.findMany({
    where: { userId, clientNumber, status: 'connected' } as any,
    include: { connectorType: { select: { slug: true } } },
  }).catch(() => [] as any[]);

  const pulls: PullSummary[] = [];
  for (const c of connectors) {
    const slug = c.connectorType?.slug;
    if (!slug) continue;
    const s = await pullHistoricalFeed(clientNumber, userId, slug, opts);
    pulls.push(s);
  }

  // Now that historical feed_events are in, build Wiki memory from them
  const { backfillSenderWiki } = await import('./senderWikiBackfill');
  const wikiBackfill = await backfillSenderWiki(clientNumber, userId, { wipeFirst: true });

  return { pulls, wikiBackfill };
}
