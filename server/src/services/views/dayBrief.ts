/**
 * Canonical view: Day Brief.
 *
 * The ONE function that returns the user's Day Brief data — used by
 * the Page (briefRoutes), the WhatsApp dispatch job (dayBriefDispatchJob),
 * and the Brain chat composer when intent='day_brief'.
 *
 * Per Basit 2026-05-25 "brief on chat (whatsapp and UI) and brief page
 * should have same data". Before this, the Page used computeBriefPartition
 * directly (returning structured cards) and the chat path used the LLM
 * composer with separate sub-blocks (open items + calendar + attention).
 * The sources were aligned (both routed through the views layer) but the
 * LLM could re-rank / drop items in narration, producing chat briefs
 * inconsistent with what the Page showed.
 *
 * This view returns the SAME structured object both surfaces consume:
 *   - Page renders the object as tiles directly (no LLM in the loop).
 *   - Chat injects a deterministic Markdown rendering of the object as
 *     a dataBlock, and reasoning narrates ONLY from that block under
 *     anti-fabrication rules. The block lists every item in order;
 *     reasoning is forbidden from re-ranking, dropping, or inventing.
 *
 * Caching: each underlying view (openItems / attention / calendar) has
 * its own TTL. getDayBrief doesn't add a wrapping cache — composes them
 * fresh per call. The partition cache (90s TTL on attention) is the
 * main savings for back-to-back calls.
 */
import prisma from '../../db/prisma';
import { getOpenItems, type OpenItemRow } from './openItems';
import { getAttentionSurface, type AttentionRow } from './attention';
import { getTodayCalendar, type CalendarEventRow } from './calendar';

export interface DayBriefData {
  /** When this brief was assembled — useful for stale-data hints. */
  generatedAt: Date;
  /** Today's date in user's local tz, ISO YYYY-MM-DD. */
  localDate: string;
  localTimezone: string;
  /** Calendar events for today. Sorted by start time. */
  calendar: CalendarEventRow[];
  /** Open items sorted by priority then due-date. Capped at 20 for
   *  the brief surface — the Action Center shows the full list. */
  openItems: OpenItemRow[];
  /** My Attention surface — items where Brain needs the user's call.
   *  Already sorted by the partition service's canonical ranking. */
  attention: AttentionRow[];
  /** Recent inbound emails (last 24h, capped 10). Quick "what came in"
   *  without scrolling Gmail. */
  recentEmails: Array<{
    fromName: string;
    fromEmail: string;
    subject: string;
    snippet: string;
    receivedAt: Date;
  }>;
  /** Recent inbound WhatsApp (last 24h, capped 10), with known-contact
   *  resolution. Unknown senders labelled. */
  recentWhatsApp: Array<{
    fromName: string;          // resolved contact title or '(not in contacts)'
    fromPhone: string;
    body: string;
    receivedAt: Date;
    knownContact: boolean;
  }>;
}

export interface GetDayBriefOpts {
  /** Override timezone (default: user's brain_channel timezone or PKT). */
  timezone?: string;
  /** Cap openItems count for the brief surface. Default 20. */
  openItemsCap?: number;
  /** Cap attention count. Default 30. */
  attentionCap?: number;
}

export async function getDayBrief(args: {
  clientNumber: string;
  userId: number;
  opts?: GetDayBriefOpts;
}): Promise<DayBriefData> {
  const { clientNumber, userId, opts } = args;
  const { resolveUserTimezone, formatLocalDate } = await import('../userTimezoneService');
  const timezone = opts?.timezone ?? await resolveUserTimezone(userId);
  const generatedAt = new Date();
  const localDate = formatLocalDate(timezone, generatedAt);

  const [calendar, openItems, attention, emails, waMsgs] = await Promise.all([
    getTodayCalendar({ clientNumber, userId, opts: { timezone } }).catch(() => [] as CalendarEventRow[]),
    getOpenItems({ clientNumber, userId, opts: { limit: opts?.openItemsCap ?? 20 } }).catch(() => [] as OpenItemRow[]),
    getAttentionSurface({ clientNumber, userId, opts: { limit: opts?.attentionCap ?? 30 } }).catch(() => [] as AttentionRow[]),
    prisma.$queryRawUnsafe<Array<{
      sender_name: string | null; sender_email: string | null;
      raw_payload: any; created_at: Date;
    }>>(
      `SELECT sender_name, sender_email, raw_payload, created_at
         FROM feed_events
        WHERE client_number = $1 AND user_id = $2 AND source_type='gmail'
          AND created_at >= NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC LIMIT 10`,
      clientNumber, userId,
    ).catch(() => [] as any[]),
    prisma.$queryRawUnsafe<Array<{
      sender_phone: string | null; sender_name: string | null;
      raw_payload: any; created_at: Date;
    }>>(
      `SELECT sender_phone, sender_name, raw_payload, created_at
         FROM feed_events
        WHERE client_number = $1 AND user_id = $2 AND source_type='whatsapp'
          AND COALESCE((raw_payload->>'fromMe')::boolean, FALSE) = FALSE
          AND created_at >= NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC LIMIT 10`,
      clientNumber, userId,
    ).catch(() => [] as any[]),
  ]);

  // Resolve WA phones to known-contact names.
  const phones = Array.from(new Set(waMsgs.map((m) => (m.sender_phone ?? '').replace(/[^\d+]/g, '')).filter(Boolean)));
  const known = new Map<string, string>();
  if (phones.length > 0) {
    const rows = await prisma.$queryRawUnsafe<Array<{ title: string; phone: string }>>(
      `SELECT title, regexp_replace(coalesce(metadata->>'phone',''), '[^0-9+]','','g') AS phone
         FROM wiki_pages
        WHERE client_number = $1 AND page_type='entity_person'
          AND user_id = $2
          AND status NOT IN ('archived','inactive','deleted','contradicted')
          AND regexp_replace(coalesce(metadata->>'phone',''), '[^0-9+]','','g') = ANY($3::text[])`,
      clientNumber, userId, phones,
    ).catch(() => [] as any[]);
    for (const r of rows) known.set(r.phone, r.title);
  }

  return {
    generatedAt,
    localDate,
    localTimezone: timezone,
    calendar,
    openItems,
    attention,
    recentEmails: emails.map((r) => {
      const unwrap = r.sender_email?.match(/<([^>]+)>/)?.[1] ?? r.sender_email ?? '';
      return {
        fromName: r.sender_name?.trim() || '',
        fromEmail: unwrap.toLowerCase(),
        subject: String(r.raw_payload?.subject ?? '').slice(0, 200) || '(no subject)',
        snippet: String(r.raw_payload?.snippet ?? '').replace(/\s+/g, ' ').slice(0, 200),
        receivedAt: r.created_at,
      };
    }),
    recentWhatsApp: waMsgs.map((m) => {
      const phone = (m.sender_phone ?? '').replace(/[^\d+]/g, '');
      const knownName = known.get(phone);
      return {
        fromName: knownName ?? m.sender_name?.trim() ?? '(not in contacts)',
        fromPhone: phone,
        body: String(m.raw_payload?.body ?? m.raw_payload?.text ?? '').replace(/\s+/g, ' ').slice(0, 200),
        receivedAt: m.created_at,
        knownContact: !!knownName,
      };
    }),
  };
}

/**
 * Render the Day Brief as a Markdown dataBlock for reasoning to narrate.
 * The chat path uses this as a single block and reasoning is forbidden
 * (per anti-fabrication rules) from adding/removing/re-ranking items.
 *
 * The Page does NOT use this — it consumes the structured DayBriefData
 * directly and renders tiles.
 */
export function renderDayBriefBlock(data: DayBriefData): string {
  const parts: string[] = [];
  parts.push(`# Day Brief for ${data.localDate} (timezone ${data.localTimezone})`);
  parts.push('STRICT RULE: when narrating this brief to the user, list every item in this block in the order shown. Do NOT re-rank, do NOT drop items, do NOT add items not in this block. Empty sections must be reported as empty ("no meetings today", "no new emails", etc.) — never hidden silently.');

  parts.push(`\n## Today's calendar (${data.calendar.length})`);
  if (data.calendar.length === 0) parts.push('- (no meetings scheduled today)');
  else for (const e of data.calendar) {
    const att = e.attendees.length > 0
      ? ` — ${e.attendees.slice(0, 4).join(', ')}${e.attendees.length > 4 ? ` +${e.attendees.length - 4}` : ''}`
      : '';
    parts.push(`- ${e.localTime} ${e.title}${att}`);
  }

  parts.push(`\n## My Attention (${data.attention.length})`);
  if (data.attention.length === 0) parts.push('- (nothing in my attention right now)');
  else for (const a of data.attention.slice(0, 10)) {
    const t = (a as any).title || (a as any).subject || (a as any).preview || (a as any).itemType || 'item';
    const src = (a as any).itemType || 'unknown';
    parts.push(`- [${src}] ${String(t).slice(0, 140)}`);
  }
  if (data.attention.length > 10) parts.push(`- … and ${data.attention.length - 10} more in My Attention`);

  parts.push(`\n## Open items (${data.openItems.length})`);
  if (data.openItems.length === 0) parts.push('- (no open items)');
  else for (const it of data.openItems.slice(0, 10)) {
    const due = it.dueDate ? new Date(it.dueDate).toISOString().slice(0, 10) : 'no due';
    const del = it.delegateeName ? ` · delegated to ${it.delegateeName}` : '';
    parts.push(`- [${it.priority ?? '?'}] ${it.title} · due ${due}${del}`);
  }
  if (data.openItems.length > 10) parts.push(`- … and ${data.openItems.length - 10} more open items`);

  parts.push(`\n## Recent emails — last 24h (${data.recentEmails.length})`);
  if (data.recentEmails.length === 0) parts.push('- (no emails in the last 24 hours)');
  else for (const e of data.recentEmails.slice(0, 5)) {
    const t = new Date(e.receivedAt).toISOString().slice(11, 16);
    parts.push(`- ${t} UTC · ${e.fromName ? `${e.fromName} <${e.fromEmail}>` : e.fromEmail}: ${e.subject}`);
  }
  if (data.recentEmails.length > 5) parts.push(`- … and ${data.recentEmails.length - 5} more emails`);

  parts.push(`\n## Recent WhatsApp — last 24h (${data.recentWhatsApp.length})`);
  if (data.recentWhatsApp.length === 0) parts.push('- (no WhatsApp messages in the last 24 hours)');
  else for (const m of data.recentWhatsApp.slice(0, 5)) {
    const t = new Date(m.receivedAt).toISOString().slice(11, 16);
    const tag = m.knownContact ? '' : ' [not in contacts]';
    parts.push(`- ${t} UTC · ${m.fromName}${tag}: ${m.body.slice(0, 120)}`);
  }
  if (data.recentWhatsApp.length > 5) parts.push(`- … and ${data.recentWhatsApp.length - 5} more messages`);

  return parts.join('\n');
}
