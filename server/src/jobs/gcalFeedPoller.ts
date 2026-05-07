/**
 * MyOS — Google Calendar polling bridge.
 *
 * For every user with an active Google integration, pull events in the
 * window [now, now + 24h) and push each into `feed_events` (sourceType=
 * 'gcal'). Each event is stamped userId so per-user scoping (Day Brief
 * meetings tile) works. Dedup by event.id via content hash.
 */
import prisma from '../db/prisma';
import { getEvents } from '../services/calendarService';
import { stampConnectorSync } from '../services/connectorSyncTracker';
import { ingest } from '../services/feed/feedIngestionService';
import { isFeatureEnabled } from '../services/featureFlagService';

export interface GcalPollResult {
  userId: number;
  clientNumber: string;
  fetched: number;
  ingested: number;
  duplicates: number;
  errors: number;
}

const WINDOW_HOURS_AHEAD = 48;  // covers today + tomorrow
const WINDOW_HOURS_BEHIND = 6;  // catches meetings still happening

export async function pollAllActiveCalendarUsers(): Promise<GcalPollResult[]> {
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      integrationProvider: 'google',
      integrationStatus: 'active',
    },
    select: { id: true, clientNumber: true },
  });

  const results: GcalPollResult[] = [];
  for (const u of users) {
    const enabled = await isFeatureEnabled(u.clientNumber, 'feature_feed_ingestion_pubsub', false);
    if (!enabled) continue;
    try {
      const r = await pollUser(u.id, u.clientNumber);
      results.push(r);
    } catch (err: any) {
      console.warn(`[gcalPoll] user=${u.id} failed: ${err.message}`);
      results.push({ userId: u.id, clientNumber: u.clientNumber, fetched: 0, ingested: 0, duplicates: 0, errors: 1 });
    }
  }
  return results;
}

async function pollUser(userId: number, clientNumber: string): Promise<GcalPollResult> {
  const now = new Date();
  const timeMin = new Date(now.getTime() - WINDOW_HOURS_BEHIND * 60 * 60 * 1000);
  const timeMax = new Date(now.getTime() + WINDOW_HOURS_AHEAD * 60 * 60 * 1000);
  const { events, error } = await getEvents(userId, timeMin, timeMax, 50);
  if (error) throw new Error(error);

  let ingested = 0, duplicates = 0, errors = 0;

  for (const e of events) {
    try {
      const r = await ingest({
        clientNumber,
        userId,
        sourceType: 'gcal',
        sourceId: e.id,
        sender: { email: e.organizer },
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
          link: e.link,
        },
      });
      if (r.status === 'new') ingested += 1;
      else if (r.status === 'duplicate') duplicates += 1;
      else errors += 1;
    } catch (err: any) {
      errors += 1;
      console.warn(`[gcalPoll] ingest failed user=${userId} event=${e.id}: ${err.message}`);
    }
  }

  await stampConnectorSync(userId, ['google_calendar']);
  return { userId, clientNumber, fetched: events.length, ingested, duplicates, errors };
}
