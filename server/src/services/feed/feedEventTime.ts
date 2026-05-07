/**
 * Source-native event time extraction for feed_events.
 *
 * Each external system stores "when did this event happen" differently:
 *   Gmail        — rawPayload.date           (RFC2822 string from Date header)
 *   WhatsApp     — rawPayload.timestamp      (Unix seconds, sometimes ms)
 *   Calendar     — rawPayload.start          (ISO string OR { dateTime, date })
 *   Google Tasks — rawPayload.updated / due  (ISO strings)
 *   Google Chat  — rawPayload.createTime     (ISO string)
 *
 * We normalize these to a Date at ingest time and persist as
 * feed_events.event_at so the 30-day attention window, Brief audit
 * timestamps, and archive search all read the truth — not the row
 * insertion time, which lies for any backfilled / scribed historical
 * pull.
 *
 * Returns null when no parseable timestamp exists (so the caller can
 * decide whether to fall back to createdAt).
 */
export function extractSourceEventTime(payload: any): Date | null {
  if (!payload || typeof payload !== 'object') return null;

  // Gmail — RFC2822 Date header.
  if (typeof payload.date === 'string' && payload.date) {
    const t = Date.parse(payload.date);
    if (Number.isFinite(t)) return new Date(t);
  }

  // WhatsApp — webjs gives Unix seconds; tolerate ms.
  if (typeof payload.timestamp === 'number' && payload.timestamp > 0) {
    const ms = payload.timestamp < 1e12 ? payload.timestamp * 1000 : payload.timestamp;
    return new Date(ms);
  }
  if (typeof payload.timestamp === 'string' && payload.timestamp) {
    const t = Date.parse(payload.timestamp);
    if (Number.isFinite(t)) return new Date(t);
    const num = Number(payload.timestamp);
    if (Number.isFinite(num) && num > 0) {
      const ms = num < 1e12 ? num * 1000 : num;
      return new Date(ms);
    }
  }

  // Calendar — start is ISO or { dateTime, date }.
  if (payload.start) {
    if (typeof payload.start === 'string') {
      const t = Date.parse(payload.start);
      if (Number.isFinite(t)) return new Date(t);
    } else if (typeof payload.start === 'object') {
      const s = payload.start.dateTime ?? payload.start.date;
      if (typeof s === 'string') {
        const t = Date.parse(s);
        if (Number.isFinite(t)) return new Date(t);
      }
    }
  }

  // Google Chat — createTime is ISO.
  if (typeof payload.createTime === 'string' && payload.createTime) {
    const t = Date.parse(payload.createTime);
    if (Number.isFinite(t)) return new Date(t);
  }

  // Google Tasks — `updated` (ISO) is the latest mutation time, more
  // useful for "did this change?" than the original due date.
  if (typeof payload.updated === 'string' && payload.updated) {
    const t = Date.parse(payload.updated);
    if (Number.isFinite(t)) return new Date(t);
  }
  if (typeof payload.due === 'string' && payload.due) {
    const t = Date.parse(payload.due);
    if (Number.isFinite(t)) return new Date(t);
  }

  return null;
}
