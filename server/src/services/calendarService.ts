import { google } from 'googleapis';
import { getAuthenticatedClient } from './integrationService';

/**
 * CalendarService — read and manage Google Calendar events for a user.
 * Uses per-user OAuth tokens from integrationService.
 */

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  start: string;       // ISO datetime
  end: string;         // ISO datetime
  location?: string;
  attendees: string[];  // email addresses
  status: string;       // confirmed, tentative, cancelled
  isAllDay: boolean;
  organizer?: string;
  link?: string;        // Google Meet or event link
}

// ─── Get today's events ───────────────────────────────────────

export async function getTodayEvents(userId: number): Promise<{ events: CalendarEvent[]; error?: string }> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  return getEvents(userId, startOfDay, endOfDay);
}

// ─── Get events for a date range ──────────────────────────────

export async function getEvents(userId: number, timeMin: Date, timeMax: Date, maxResults = 20): Promise<{ events: CalendarEvent[]; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { events: [], error };

  try {
    const calendar = google.calendar({ version: 'v3', auth: client });
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events: CalendarEvent[] = (response.data.items || []).map(event => ({
      id: event.id!,
      title: event.summary || '(No title)',
      description: event.description || undefined,
      start: event.start?.dateTime || event.start?.date || '',
      end: event.end?.dateTime || event.end?.date || '',
      location: event.location || undefined,
      attendees: (event.attendees || []).map(a => a.email || ''),
      status: event.status || 'confirmed',
      isAllDay: !event.start?.dateTime,
      organizer: event.organizer?.email || undefined,
      link: event.hangoutLink || event.htmlLink || undefined,
    }));

    return { events };
  } catch (err: any) {
    return { events: [], error: `Calendar error: ${err.message}` };
  }
}

// ─── Get upcoming events (next 7 days) ────────────────────────

export async function getUpcomingEvents(userId: number, days = 7): Promise<{ events: CalendarEvent[]; error?: string }> {
  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return getEvents(userId, now, future);
}

// ─── Create event ─────────────────────────────────────────────

export async function createEvent(userId: number, details: {
  title: string;
  description?: string;
  startTime: string;     // ISO datetime
  endTime: string;       // ISO datetime
  location?: string;
  attendees?: string[];  // email addresses
  addMeet?: boolean;     // add Google Meet link
}): Promise<{ event?: CalendarEvent; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { error };

  try {
    const calendar = google.calendar({ version: 'v3', auth: client });

    const eventBody: any = {
      summary: details.title,
      description: details.description,
      start: { dateTime: details.startTime, timeZone: 'Asia/Karachi' },
      end: { dateTime: details.endTime, timeZone: 'Asia/Karachi' },
      location: details.location,
      attendees: details.attendees?.map(email => ({ email })),
    };

    if (details.addMeet) {
      eventBody.conferenceData = {
        createRequest: { requestId: `tmcai-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } },
      };
    }

    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: eventBody,
      conferenceDataVersion: details.addMeet ? 1 : 0,
      sendUpdates: details.attendees?.length ? 'all' : 'none',
    });

    const event = response.data;
    return {
      event: {
        id: event.id!,
        title: event.summary || details.title,
        description: event.description || undefined,
        start: event.start?.dateTime || event.start?.date || details.startTime,
        end: event.end?.dateTime || event.end?.date || details.endTime,
        location: event.location || undefined,
        attendees: (event.attendees || []).map(a => a.email || ''),
        status: event.status || 'confirmed',
        isAllDay: false,
        organizer: event.organizer?.email || undefined,
        link: event.hangoutLink || event.htmlLink || undefined,
      },
    };
  } catch (err: any) {
    return { error: `Create event failed: ${err.message}` };
  }
}

// ─── Find free time slots ─────────────────────────────────────

export async function findFreeTime(userId: number, date: Date, durationMinutes = 60): Promise<{ slots: { start: string; end: string }[]; error?: string }> {
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9, 0);  // 9 AM
  const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 18, 0);    // 6 PM

  const { events, error } = await getEvents(userId, startOfDay, endOfDay);
  if (error) return { slots: [], error };

  // Find gaps between events
  const slots: { start: string; end: string }[] = [];
  let cursor = startOfDay.getTime();

  for (const event of events) {
    const eventStart = new Date(event.start).getTime();
    const eventEnd = new Date(event.end).getTime();

    if (eventStart - cursor >= durationMinutes * 60 * 1000) {
      slots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(cursor + durationMinutes * 60 * 1000).toISOString(),
      });
    }

    cursor = Math.max(cursor, eventEnd);
  }

  // Check remaining time after last event
  if (endOfDay.getTime() - cursor >= durationMinutes * 60 * 1000) {
    slots.push({
      start: new Date(cursor).toISOString(),
      end: new Date(cursor + durationMinutes * 60 * 1000).toISOString(),
    });
  }

  return { slots };
}

// ─── Delete event ─────────────────────────────────────────────

export async function deleteEvent(userId: number, eventId: string): Promise<{ success: boolean; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { success: false, error };

  try {
    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: `Delete failed: ${err.message}` };
  }
}

// ─── Update event ─────────────────────────────────────────────

/** Patch an existing calendar event. Pass only the fields you want
 *  to change. Returns the updated event on success or an error
 *  string on failure. */
export async function updateEvent(
  userId: number,
  eventId: string,
  patch: {
    title?: string;
    description?: string;
    startTime?: string;
    endTime?: string;
    location?: string;
    attendees?: string[];
  },
): Promise<{ event?: CalendarEvent; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { error };

  try {
    const calendar = google.calendar({ version: 'v3', auth: client });
    const body: any = {};
    if (patch.title !== undefined) body.summary = patch.title;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.location !== undefined) body.location = patch.location;
    if (patch.startTime !== undefined) body.start = { dateTime: patch.startTime, timeZone: 'Asia/Karachi' };
    if (patch.endTime !== undefined) body.end = { dateTime: patch.endTime, timeZone: 'Asia/Karachi' };
    if (patch.attendees !== undefined) body.attendees = patch.attendees.map((email) => ({ email }));

    const response = await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      requestBody: body,
      sendUpdates: 'all',
    });
    const event = response.data;
    return {
      event: {
        id: event.id!,
        title: event.summary || patch.title || '',
        description: event.description || undefined,
        start: event.start?.dateTime || event.start?.date || patch.startTime || '',
        end: event.end?.dateTime || event.end?.date || patch.endTime || '',
        location: event.location || undefined,
        attendees: event.attendees?.map((a) => a.email!).filter(Boolean) || [],
        status: event.status || 'confirmed',
        isAllDay: !!event.start?.date,
        organizer: event.organizer?.email || undefined,
        link: event.hangoutLink || event.htmlLink || undefined,
      },
    };
  } catch (err: any) {
    return { error: `Update failed: ${err.message}` };
  }
}
