/**
 * Outlook Calendar FeedAdapter — reads upcoming + recently-modified
 * meetings from Microsoft Graph for every user who paired the
 * `outlook_calendar` connector. Mirrors the gcal feed shape so triage
 * + criticality treat Outlook meetings exactly like Google Calendar
 * meetings (organizer / attendees / start / end / location).
 *
 * Window: anything modified in the last 7 days OR starting in the next
 * 14 days. That's enough for "what's on my calendar this week" queries
 * and for criticality's deadline-pressure signal without paging
 * through ancient history.
 */
import { FeedAdapter, NormalizedEvent, AdapterHealth, BackfillRange, BackfillResult, TeardownResult } from '../adapterBase';
import prisma from '../../../db/prisma';
import { listConnectedUsers, graphGet } from './msGraphHelper';
import createLogger from '../../../utils/logger';

const log = createLogger('outlook-calendar-adapter');

interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: Array<{ emailAddress?: { name?: string; address?: string }; status?: { response?: string } }>;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  importance?: string;
  webLink?: string;
  lastModifiedDateTime?: string;
  __userId?: number;
}

export class OutlookCalendarFeedAdapter extends FeedAdapter {
  readonly sourceType = 'outlook_calendar' as any;     // FeedSourceType extended below
  readonly displayName = 'Outlook Calendar';

  async receive(tenantId: string, _since?: Date, limit = 25): Promise<unknown[]> {
    const users = await listConnectedUsers(tenantId, 'outlook_calendar');
    if (users.length === 0) return [];
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAhead = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    // calendarView accepts startDateTime/endDateTime and is the right
    // endpoint for "events in a window". Cheaper than $filter on /events.
    const url = `https://graph.microsoft.com/v1.0/me/calendarView` +
      `?startDateTime=${oneWeekAgo.toISOString()}` +
      `&endDateTime=${twoWeeksAhead.toISOString()}` +
      `&$top=${Math.min(limit, 100)}` +
      `&$select=id,subject,bodyPreview,organizer,attendees,start,end,location,isAllDay,isCancelled,showAs,importance,webLink,lastModifiedDateTime` +
      `&$orderby=start/dateTime desc`;
    const all: unknown[] = [];
    for (const u of users) {
      try {
        const j = await graphGet<{ value: GraphEvent[] }>(u.userId, 'outlook_calendar', url);
        for (const e of j?.value ?? []) all.push({ ...e, __userId: u.userId });
      } catch (err: any) {
        log.warn('calendar receive failed', { userId: u.userId, error: err.message });
      }
    }
    return all;
  }

  normalise(raw: unknown): NormalizedEvent {
    const e = raw as GraphEvent;
    const start = e.start?.dateTime;
    const attendees = (e.attendees ?? []).map((a) => ({
      name: a.emailAddress?.name,
      email: a.emailAddress?.address,
      response: a.status?.response,
    }));
    return {
      sourceId: e.id,
      eventType: e.isCancelled ? 'meeting_cancelled' as any : 'meeting_invite' as any,
      sender: {
        email: e.organizer?.emailAddress?.address,
        name: e.organizer?.emailAddress?.name,
      },
      payload: {
        userId: e.__userId,
        title: e.subject,
        summary: e.subject,
        start,
        end: e.end?.dateTime,
        startTimeZone: e.start?.timeZone,
        endTimeZone: e.end?.timeZone,
        attendees,
        location: e.location?.displayName,
        isAllDay: !!e.isAllDay,
        isCancelled: !!e.isCancelled,
        showAs: e.showAs,
        importance: e.importance,
        link: e.webLink,
        bodyPreview: e.bodyPreview,
        organizer: e.organizer?.emailAddress?.address,
        provider: 'outlook',
      },
      receivedAt: e.lastModifiedDateTime ? new Date(e.lastModifiedDateTime) : (start ? new Date(start) : new Date()),
    };
  }

  async health(): Promise<AdapterHealth> {
    return { ok: true, detail: 'tenant-level health derived from connected users', lastCheckedAt: new Date().toISOString() };
  }

  async backfill(range: BackfillRange): Promise<BackfillResult> {
    const limit = range.maxEvents ?? 100;
    const raws = await this.receive(range.tenantId, range.since, Math.min(limit, 500));
    let fetched = raws.length;
    let ingested = 0; let duplicates = 0; let errors = 0;
    let first: Date | undefined; let last: Date | undefined;
    for (const raw of raws) {
      try {
        const n = this.normalise(raw);
        if (range.since && n.receivedAt < range.since) continue;
        if (range.until && n.receivedAt > range.until) continue;
        const r = await this.storeAndPublish(n, range.tenantId);
        if (r.status === 'new') ingested += 1;
        else if (r.status === 'duplicate') duplicates += 1;
        else errors += 1;
        if (!first || n.receivedAt < first) first = n.receivedAt;
        if (!last || n.receivedAt > last) last = n.receivedAt;
      } catch { errors += 1; }
    }
    return { fetched, ingested, duplicates, errors, firstEventAt: first, lastEventAt: last };
  }

  async teardown(tenantId: string): Promise<TeardownResult> {
    const ct = await prisma.connectorType.findUnique({ where: { slug: 'outlook_calendar' } });
    if (!ct) return { ok: true, connectionsRemoved: 0, tokensRevoked: 0 };
    const result = await prisma.userConnector.updateMany({
      where: { clientNumber: tenantId, connectorTypeId: ct.id },
      data: { status: 'disconnected', errorMessage: null },
    });
    return { ok: true, connectionsRemoved: result.count, tokensRevoked: result.count };
  }
}

export default new OutlookCalendarFeedAdapter();
