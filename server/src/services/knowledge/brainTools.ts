/**
 * brainTools — read-only fetch tools the reasoning model can request
 * at runtime to ground its answer.
 *
 * Architectural shift (2026-05-25 per Basit "no false statements"):
 * before this, every question class needed its dataBlock pre-built
 * and injected before reasoning fired. When a novel question hit a
 * class without a block (e.g. "any email from Asad this week"),
 * reasoning had no ground truth and confabulated. Tool use closes the
 * gap: reasoning emits decision='tool_call' with a tool name + input,
 * the orchestrator runs the corresponding handler (a thin Prisma
 * query over canonical views), feeds the result back as a new
 * dataBlock, and reasoning re-decides with real data.
 *
 * Rules of the registry:
 *  - Tools are READ-ONLY. They never write, send, schedule, or
 *    mutate. Writes go through the action registry (which has
 *    preview / idempotency / userScopeGuard).
 *  - Every handler receives {userId, clientNumber} from the calling
 *    turn and MUST scope its query to that user. Cross-user reads
 *    are caught by userScopeGuard but the principle of least surprise
 *    says scope at the source.
 *  - Output shape is plain Markdown (the same format dataBlocks use)
 *    so the model can read it without parsing JSON.
 *  - Max iterations per turn = 3. Reasoning that loops past that gets
 *    forced into 'answer' or 'ask' with whatever data was collected.
 *  - Tool results are cached per turn (same input → same output) so
 *    reasoning can't blow up the latency budget with duplicate calls.
 */
import prisma from '../../db/prisma';
import { getOpenItems, getTodayCalendar } from '../views';

export interface BrainToolContext {
  userId: number;
  clientNumber: string;
}

export interface BrainToolDefinition {
  name: string;
  /** Shown to the LLM in the tool catalogue — concise, action-oriented. */
  description: string;
  /** JSON Schema for the input. Reasoning's emitted payload validates
   *  against this before the handler runs. */
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };
  handler: (input: any, ctx: BrainToolContext) => Promise<string>;
}

// ─── Helpers ─────────────────────────────────────────────────────

function unwrapEmail(raw: string | null | undefined): string {
  if (!raw) return '';
  const m = String(raw).match(/<([^>]+)>/);
  return (m?.[1] ?? raw).trim().toLowerCase();
}

function normalisePhone(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/[^\d+]/g, '');
}

function fmtTimestamp(d: Date | string | null | undefined): string {
  if (!d) return '';
  try { return new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  catch { return ''; }
}

function emptyMarker(blockTitle: string, what: string): string {
  return `# ${blockTitle}\n(no ${what} found — say so plainly, do not invent)`;
}

// ─── Tool: fetch_calendar ────────────────────────────────────────

const fetchCalendar: BrainToolDefinition = {
  name: 'fetch_calendar',
  description: 'Get calendar events for the user across a date range. Use for "any meetings tomorrow", "what is on my calendar this week", "do I have anything on <date>".',
  inputSchema: {
    type: 'object',
    properties: {
      range: { type: 'string', description: 'one of: today, tomorrow, this_week, next_week, or YYYY-MM-DD for a specific day' },
    },
    required: ['range'],
  },
  handler: async ({ range }, { userId, clientNumber }) => {
    const { resolveUserTimezone, calendarRangeBounds, formatInZone } = await import('../userTimezoneService');
    const tz = await resolveUserTimezone(userId);
    if (range === 'today') {
      const events = await getTodayCalendar({ clientNumber, userId, opts: { timezone: tz } });
      if (events.length === 0) return '# Today\'s calendar\n(no meetings scheduled today)';
      return `# Today's calendar (times in ${tz})\n` + events.map((e) => {
        const att = e.attendees.length > 0
          ? ` — ${e.attendees.slice(0, 5).join(', ')}${e.attendees.length > 5 ? ` +${e.attendees.length - 5}` : ''}`
          : '';
        return `- ${e.localTime} ${e.title}${att}`;
      }).join('\n');
    }
    // For tomorrow/week/date, query feed_events directly (no canonical
    // view yet for arbitrary ranges — TODO move into views/calendar.ts).
    const bounds = calendarRangeBounds(range, tz);
    if (!bounds) {
      return `# Calendar — invalid range\nReceived "${range}". Valid: today | tomorrow | this_week | next_week | YYYY-MM-DD.`;
    }
    const fromDate = bounds.fromUtc; const toDate = bounds.toUtc;
    const events = await prisma.$queryRawUnsafe<Array<{
      event_at: Date; raw_payload: any; subject?: string | null;
    }>>(
      `SELECT event_at, raw_payload
         FROM feed_events
        WHERE client_number = $1 AND user_id = $2
          AND source_type = 'gcal'
          AND event_at IS NOT NULL
          AND event_at BETWEEN $3 AND $4
        ORDER BY event_at ASC
        LIMIT 50`,
      clientNumber, userId, fromDate, toDate,
    ).catch(() => [] as any[]);
    if (events.length === 0) return `# Calendar (${range})\n(no meetings in this range)`;
    const lines = events.map((e) => {
      const p = e.raw_payload ?? {};
      const title = String(p.summary ?? p.title ?? '(untitled)').slice(0, 120);
      const att   = Array.isArray(p.attendees) ? p.attendees.slice(0, 4).map((a: any) => a.email ?? a.displayName ?? '?').join(', ') : '';
      const when  = formatInZone(tz, new Date(e.event_at));
      return `- ${when} — ${title}${att ? ` · attendees: ${att}` : ''}`;
    });
    return `# Calendar (${range}, times already in the user's timezone ${tz})\n${lines.join('\n')}`;
  },
};

// ─── Tool: fetch_emails ──────────────────────────────────────────

const fetchEmails: BrainToolDefinition = {
  name: 'fetch_emails',
  description: 'Search the user\'s INBOUND emails by sender, subject substring, or recency. Use for "any email from <X>", "did <X> reply yet", "emails about <topic> this week". Returns up to 20 messages.',
  inputSchema: {
    type: 'object',
    properties: {
      from:             { type: 'string', description: 'sender email (partial OK) — pass when user names a specific person' },
      subject_contains: { type: 'string', description: 'subject substring (case-insensitive)' },
      last_n_days:      { type: 'integer', description: 'lookback window (default 7, max 30)' },
    },
  },
  handler: async ({ from, subject_contains, last_n_days }, { userId, clientNumber }) => {
    const days = Math.max(1, Math.min(30, Number(last_n_days ?? 7)));
    const fromQ = from ? String(from).trim().toLowerCase() : '';
    const subQ  = subject_contains ? String(subject_contains).trim().toLowerCase() : '';
    const rows = await prisma.$queryRawUnsafe<Array<{
      sender_name: string | null; sender_email: string | null;
      raw_payload: any; created_at: Date;
    }>>(
      `SELECT sender_name, sender_email, raw_payload, created_at
         FROM feed_events
        WHERE client_number = $1 AND user_id = $2
          AND source_type = 'gmail'
          AND created_at >= NOW() - INTERVAL '1 day' * $3
          AND (
            $4 = '' OR
            lower(COALESCE(substring(sender_email FROM '<([^>]+)>'), sender_email)) LIKE '%' || $4 || '%' OR
            lower(coalesce(sender_email,'')) LIKE '%' || $4 || '%'
          )
          AND (
            $5 = '' OR
            lower(coalesce(raw_payload->>'subject', '')) LIKE '%' || $5 || '%'
          )
        ORDER BY created_at DESC
        LIMIT 20`,
      clientNumber, userId, days, fromQ, subQ,
    ).catch(() => [] as any[]);
    if (rows.length === 0) {
      const filters = [from ? `from contains "${from}"` : null, subject_contains ? `subject contains "${subject_contains}"` : null].filter(Boolean).join(', ');
      return `# Emails (last ${days}d${filters ? `, ${filters}` : ''})\n(no matching emails found)`;
    }
    const lines = rows.map((r) => {
      const fe = unwrapEmail(r.sender_email);
      const fn = r.sender_name?.trim() || '';
      const subj = String(r.raw_payload?.subject ?? '').slice(0, 120) || '(no subject)';
      const snip = String(r.raw_payload?.snippet ?? '').replace(/\s+/g, ' ').slice(0, 140);
      return `- ${fmtTimestamp(r.created_at)} — From: ${fn ? `${fn} <${fe}>` : fe}\n  Subject: ${subj}${snip ? `\n  Snippet: ${snip}` : ''}`;
    });
    return `# Emails (last ${days}d, ${rows.length} match${rows.length === 1 ? '' : 'es'})\n${lines.join('\n')}`;
  },
};

// ─── Tool: fetch_sent_emails ─────────────────────────────────────

const fetchSentEmails: BrainToolDefinition = {
  name: 'fetch_sent_emails',
  description: 'Look up the user\'s Gmail SENT folder — proof of what actually went out. Use for "did I email <X>", "did the last email actually send", "check my sent items", "which account did it go from". Optionally filter by recipient. Reports the From: address (so the user can see which Gmail account was used), messageId, subject, and time.',
  inputSchema: {
    type: 'object',
    properties: {
      to:          { type: 'string', description: 'recipient email (optional — omit to list recent sent items across all recipients)' },
      last_n_days: { type: 'integer', description: 'lookback window (default 7, max 90)' },
      max:         { type: 'integer', description: 'max items to return (default 10, max 25)' },
    },
    required: [],
  },
  handler: async ({ to, last_n_days, max }, { userId }) => {
    const days = Math.max(1, Math.min(90, Number(last_n_days ?? 7)));
    const cap = Math.max(1, Math.min(25, Number(max ?? 10)));
    const target = typeof to === 'string' ? String(to).trim().toLowerCase() : '';

    // Recipient-scoped lookup: use the pre-existing tone-sample path
    // (has richer per-recipient filtering + body extraction).
    if (target && target.includes('@')) {
      try {
        const { getToneSamplesForRecipient } = await import('./senderToneService');
        const samples = await getToneSamplesForRecipient(userId, target, cap);
        if (!samples || samples.samples.length === 0) {
          return `# Sent emails to ${target} (last ${days}d via Gmail API)\n(no sent emails to this recipient found — this means the message never left, OR it was sent from a different account)`;
        }
        const lines = samples.samples.map((s) => {
          const date = s.sentAt ? new Date(s.sentAt).toISOString().slice(0, 10) : '';
          return `- ${date} — Subject: ${s.subject}\n  Body excerpt: ${s.body.replace(/\s+/g, ' ').slice(0, 200)}`;
        });
        return `# Sent emails to ${target} (newest first, ${samples.samples.length} shown)\n${lines.join('\n')}`;
      } catch (e: any) {
        return `# Sent emails to ${target}\n(lookup failed: ${e?.message ?? 'unknown error'})`;
      }
    }

    // Broad lookup: recent sent items across the account. Used when
    // the user asks "did the last one actually send" without naming
    // a recipient, or "show me what you've sent from my account today".
    try {
      const { getRecentSentSummary } = await import('../gmailService');
      const r = await getRecentSentSummary(userId, {
        max: cap,
        sinceHoursAgo: days * 24,
      });
      if (!r.ok) {
        return `# Recent sent emails\n(Gmail read failed: ${r.error ?? 'unknown'}. This usually means the user\'s Gmail token has expired — ask them to reconnect Google in Settings.)`;
      }
      if (r.items.length === 0) {
        return `# Recent sent emails (last ${days}d)\nNo sent messages found in the connected Google account (${r.fromAddress ?? 'address unknown'}). If the user believes they sent something recently, either the send never landed OR it went from a different account.`;
      }
      const lines = r.items.map((m) =>
        `- ${m.sentAt} — To: ${m.to} — Subject: ${m.subject} — id: ${m.messageId}`,
      );
      return `# Recent sent emails from ${r.fromAddress ?? '(account)'} — ${r.items.length} in last ${days}d\n${lines.join('\n')}`;
    } catch (e: any) {
      return `# Recent sent emails\n(lookup failed: ${e?.message ?? 'unknown'})`;
    }
  },
};

// ─── Tool: fetch_whatsapp_thread ─────────────────────────────────

const fetchWhatsAppThread: BrainToolDefinition = {
  name: 'fetch_whatsapp_thread',
  description: 'Read recent WhatsApp messages from a specific contact (both sides of the conversation). Use for "what did <X> say last", "show the WA thread with <X>".',
  inputSchema: {
    type: 'object',
    properties: {
      contact_phone_or_email: { type: 'string', description: 'normalised phone (digits+plus) OR email — Brain looks up the matching contact' },
      last_n_messages:        { type: 'integer', description: 'how many messages to pull (default 20, max 50)' },
    },
    required: ['contact_phone_or_email'],
  },
  handler: async ({ contact_phone_or_email, last_n_messages }, { userId, clientNumber }) => {
    const max = Math.max(1, Math.min(50, Number(last_n_messages ?? 20)));
    const needle = String(contact_phone_or_email ?? '').trim();
    if (!needle) return '# WhatsApp thread — missing identifier';
    const phone = normalisePhone(needle);
    const email = needle.includes('@') ? needle.toLowerCase() : '';
    // Resolve to chat identifier(s) via entity_person → metadata.phone
    let chatPhones: string[] = phone ? [phone] : [];
    if (!chatPhones.length && email) {
      const contact = await prisma.$queryRawUnsafe<Array<{ phone: string }>>(
        `SELECT regexp_replace(coalesce(metadata->>'phone',''), '[^0-9+]','','g') AS phone
           FROM wiki_pages
          WHERE client_number = $1 AND page_type='entity_person'
            AND lower(metadata->>'email') = $2
            AND status NOT IN ('archived','inactive','deleted','contradicted')`,
        clientNumber, email,
      ).catch(() => [] as any[]);
      chatPhones = contact.map((c) => c.phone).filter(Boolean);
    }
    if (!chatPhones.length) return `# WhatsApp thread with ${needle}\n(no WhatsApp number on file for this contact)`;
    const msgs = await prisma.$queryRawUnsafe<Array<{
      sender_phone: string | null; sender_name: string | null;
      raw_payload: any; created_at: Date; from_me: boolean;
    }>>(
      `SELECT sender_phone, sender_name, raw_payload, created_at,
              COALESCE((raw_payload->>'fromMe')::boolean, FALSE) AS from_me
         FROM feed_events
        WHERE client_number = $1 AND user_id = $2
          AND source_type = 'whatsapp'
          AND regexp_replace(coalesce(sender_phone,''), '[^0-9+]','','g') = ANY($3::text[])
        ORDER BY created_at DESC
        LIMIT $4`,
      clientNumber, userId, chatPhones, max,
    ).catch(() => [] as any[]);
    if (msgs.length === 0) return `# WhatsApp thread with ${needle}\n(no messages found)`;
    const lines = msgs.reverse().map((m) => {
      const who = m.from_me ? 'YOU' : (m.sender_name?.trim() || m.sender_phone || 'them');
      const body = String(m.raw_payload?.body ?? m.raw_payload?.text ?? '').replace(/\s+/g, ' ').slice(0, 300);
      return `- ${fmtTimestamp(m.created_at)} ${who}: ${body || '(empty)'}`;
    });
    return `# WhatsApp thread with ${needle} (oldest → newest, last ${msgs.length})\n${lines.join('\n')}`;
  },
};

// ─── Tool: fetch_open_items ──────────────────────────────────────

const fetchOpenItems: BrainToolDefinition = {
  name: 'fetch_open_items',
  description: 'Get the user\'s open items, optionally filtered. Use for "what items are due this week", "anything assigned to <X>", "what\'s overdue". Without filters returns the full active list.',
  inputSchema: {
    type: 'object',
    properties: {
      assignee_contact_id: { type: 'string', description: 'filter to items delegated to this contact (entity_person id)' },
      priority_min:        { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'minimum priority' },
      due_range:           { type: 'string', enum: ['today', 'this_week', 'overdue', 'future'], description: 'when due' },
      status:              { type: 'string', enum: ['active', 'completed', 'archived'], description: 'default active' },
    },
  },
  handler: async (opts, { userId, clientNumber }) => {
    const statuses = opts.status
      ? [String(opts.status)]
      : ['NEW', 'IN_PROGRESS', 'DELEGATED', 'AWAITING_RESPONSE'];
    const rows = await getOpenItems({
      clientNumber, userId,
      opts: { statuses, limit: 100 },
    }).catch(() => []);
    let filtered = rows as any[];
    if (opts.priority_min) {
      const order = ['low', 'medium', 'high', 'critical'];
      const min = order.indexOf(String(opts.priority_min));
      filtered = filtered.filter((r) => order.indexOf(String(r.priority ?? 'low')) >= min);
    }
    if (opts.assignee_contact_id) {
      filtered = filtered.filter((r) => String(r.delegateeContactId ?? '') === String(opts.assignee_contact_id));
    }
    if (opts.due_range) {
      const now = Date.now();
      const dayMs = 86_400_000;
      filtered = filtered.filter((r) => {
        if (!r.dueDate) return opts.due_range === 'future';
        const due = new Date(r.dueDate).getTime();
        if (opts.due_range === 'today')     return Math.abs(due - now) < dayMs;
        if (opts.due_range === 'this_week') return due - now <= 7 * dayMs && due - now >= -dayMs;
        if (opts.due_range === 'overdue')   return due < now;
        if (opts.due_range === 'future')    return due > now;
        return true;
      });
    }
    if (filtered.length === 0) return '# Open items (filtered)\n(no items match the filter)';
    const lines = filtered.slice(0, 50).map((r) => {
      const due = r.dueDate ? new Date(r.dueDate).toISOString().slice(0, 10) : '(no due)';
      return `- [${r.priority ?? '?'}] ${r.title} · due ${due}${r.delegateeName ? ` · delegated to ${r.delegateeName}` : ''}`;
    });
    return `# Open items (${filtered.length}${filtered.length > 50 ? ', showing first 50' : ''})\n${lines.join('\n')}`;
  },
};

// ─── Tool: fetch_contact_full ────────────────────────────────────

const fetchContactFull: BrainToolDefinition = {
  name: 'fetch_contact_full',
  description: 'Get all known information about a specific contact (email, phone, channels, scope, last interaction, provenance trail). Use for "who is X", "tell me about X", "what do we know about X".',
  inputSchema: {
    type: 'object',
    properties: {
      contact_email_or_phone_or_id: { type: 'string', description: 'email, normalised phone, or wiki_pages id starting with person:' },
    },
    required: ['contact_email_or_phone_or_id'],
  },
  handler: async ({ contact_email_or_phone_or_id }, { userId, clientNumber }) => {
    const needle = String(contact_email_or_phone_or_id ?? '').trim();
    if (!needle) return '# Contact lookup — missing identifier';
    let row: any = null;
    if (needle.startsWith('person:') || needle.startsWith('cm')) {
      row = await prisma.wikiPage.findFirst({
        where: { id: needle, clientNumber, pageType: 'entity_person' } as any,
        select: { id: true, title: true, userId: true, status: true, metadata: true, createdAt: true, lastUpdatedAt: true },
      }).catch(() => null);
    } else if (needle.includes('@')) {
      const email = needle.toLowerCase();
      const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, title, user_id AS "userId", status, metadata, created_at AS "createdAt", last_updated_at AS "lastUpdatedAt"
           FROM wiki_pages
          WHERE client_number = $1 AND page_type='entity_person'
            AND lower(metadata->>'email') = $2
          LIMIT 1`,
        clientNumber, email,
      ).catch(() => [] as any[]);
      row = rows[0] ?? null;
    } else {
      const phone = normalisePhone(needle);
      const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, title, user_id AS "userId", status, metadata, created_at AS "createdAt", last_updated_at AS "lastUpdatedAt"
           FROM wiki_pages
          WHERE client_number = $1 AND page_type='entity_person'
            AND regexp_replace(coalesce(metadata->>'phone',''), '[^0-9+]','','g') = $2
          LIMIT 1`,
        clientNumber, phone,
      ).catch(() => [] as any[]);
      row = rows[0] ?? null;
    }
    if (!row) return `# Contact lookup: ${needle}\n(no contact found with that identifier)`;
    const md = row.metadata ?? {};
    const ownerLabel = row.userId === userId ? 'you' : `another user (id ${row.userId})`;
    const lines = [
      `Title: ${row.title}`,
      `Email: ${md.email ?? '(none)'}`,
      `Phone: ${md.phone ?? '(none)'}`,
      `Scope: ${md.scope ?? 'normal'}`,
      `Owner: ${ownerLabel}`,
      `Status: ${row.status}`,
      `Channels seen on: ${Array.isArray(md.channels) ? md.channels.join(', ') : '(none recorded)'}`,
      `First seen: ${md.first_seen_at ?? row.createdAt?.toString?.()?.slice(0, 10) ?? '(unknown)'}`,
      `Source: ${md.source ?? md.imported_from ?? '(unrecorded)'}`,
    ];
    // Saved-vs-pushname distinction (WA-sourced contacts). When
    // isUserSavedContact=true, the user has this person in their
    // phone's address book — Brain can confidently say "you have them
    // in your contacts". When false, Brain should say "they're on
    // WhatsApp as <pushname> but I don't see them in your saved
    // contacts."
    if (md.isUserSavedContact !== undefined) {
      lines.push(`In user's phone contacts: ${md.isUserSavedContact ? 'YES' : 'NO'}`);
      if (md.contactNames_savedName)   lines.push(`Saved name (user's phonebook): ${md.contactNames_savedName}`);
      if (md.contactNames_pushname)    lines.push(`WhatsApp pushname (sender's choice): ${md.contactNames_pushname}`);
      if (md.contactNames_verifiedName) lines.push(`Verified business name: ${md.contactNames_verifiedName}`);
    }
    if (md.publicSetBy) lines.push(`Published by: user ${md.publicSetBy} on ${md.publicSince ?? '?'}`);
    if (md.brainMutedBy) lines.push(`Muted by: user ${md.brainMutedBy}`);
    return `# Contact: ${row.title}\n${lines.map((l) => `- ${l}`).join('\n')}`;
  },
};

// ─── Tool: fetch_user_profile ────────────────────────────────────

const fetchUserProfile: BrainToolDefinition = {
  name: 'fetch_user_profile',
  description: 'Get the user\'s own profile (email, phone, WhatsApp number, role, timezone). Use when the user asks "what\'s my X" or anything about themselves.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, { userId }) => {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, name: true, email: true, userType: true,
        notificationPreferences: true, jobDescription: true,
        contactNumber: true, city: true,
      } as any,
    }).catch(() => null) as any;
    if (!u) return '# User profile\n(profile lookup failed)';
    const prefs = (u.notificationPreferences ?? {}) as any;
    const bc = prefs.brain_channel ?? {};
    const { resolveUserTimezone } = await import('../userTimezoneService');
    const effectiveTz = bc.timezone ?? await resolveUserTimezone(userId);
    const lines = [
      `Name: ${u.name ?? '(unset)'}`,
      `Email: ${u.email ?? '(unset)'}`,
      `Role: ${u.userType ?? '(unset)'}${u.jobDescription ? ` — ${u.jobDescription}` : ''}`,
      `WhatsApp number: ${bc.whatsappNumber ?? '(not set in Brain Channel settings)'}`,
      `Phone: ${u.contactNumber ?? '(not set)'}`,
      `Timezone: ${effectiveTz}`,
      `Day Brief time: ${bc.dayBriefTime ?? '08:30'} ${effectiveTz}`,
    ];
    return `# Your profile\n${lines.map((l) => `- ${l}`).join('\n')}`;
  },
};

// ─── Tool: fetch_recent_messages ─────────────────────────────────

const fetchRecentMessages: BrainToolDefinition = {
  name: 'fetch_recent_messages',
  description: 'Get the user\'s most recent inbound messages across any channel. Use for "what came in", "anything new", "latest activity". Returns mixed feed (email + WA + calendar) in chronological order.',
  inputSchema: {
    type: 'object',
    properties: {
      channel:          { type: 'string', enum: ['any', 'gmail', 'whatsapp', 'gcal'], description: 'default any' },
      last_n_hours:     { type: 'integer', description: 'lookback window in hours (default 24, max 168)' },
      limit:            { type: 'integer', description: 'max rows (default 15, max 50)' },
    },
  },
  handler: async ({ channel, last_n_hours, limit }, { userId, clientNumber }) => {
    const hours = Math.max(1, Math.min(168, Number(last_n_hours ?? 24)));
    const max   = Math.max(1, Math.min(50, Number(limit ?? 15)));
    const ch    = channel && channel !== 'any' ? String(channel) : null;
    const rows = await prisma.$queryRawUnsafe<Array<{
      source_type: string; sender_email: string | null; sender_phone: string | null;
      sender_name: string | null; raw_payload: any; created_at: Date;
    }>>(
      `SELECT source_type, sender_email, sender_phone, sender_name, raw_payload, created_at
         FROM feed_events
        WHERE client_number = $1 AND user_id = $2
          AND created_at >= NOW() - INTERVAL '1 hour' * $3
          AND ($4::text IS NULL OR source_type = $4)
          AND COALESCE((raw_payload->>'fromMe')::boolean, FALSE) = FALSE
        ORDER BY created_at DESC
        LIMIT $5`,
      clientNumber, userId, hours, ch, max,
    ).catch(() => [] as any[]);
    if (rows.length === 0) return `# Recent messages (last ${hours}h${ch ? `, ${ch}` : ''})\n(nothing in this window)`;
    const lines = rows.map((r) => {
      const who = r.source_type === 'whatsapp'
        ? (r.sender_name?.trim() || r.sender_phone || 'unknown')
        : `${r.sender_name?.trim() || ''} <${unwrapEmail(r.sender_email)}>`;
      const subj = String(r.raw_payload?.subject ?? '').slice(0, 80);
      const body = String(r.raw_payload?.body ?? r.raw_payload?.snippet ?? r.raw_payload?.text ?? '').replace(/\s+/g, ' ').slice(0, 180);
      return `- ${fmtTimestamp(r.created_at)} [${r.source_type}] ${who}${subj ? ` · ${subj}` : ''}${body ? `\n    ${body}` : ''}`;
    });
    return `# Recent messages (last ${hours}h${ch ? `, ${ch}` : ''}, ${rows.length} of ${max} max)\n${lines.join('\n')}`;
  },
};

// ─── Tool: fetch_tenant_users ────────────────────────────────────

const fetchTenantUsers: BrainToolDefinition = {
  name: 'fetch_tenant_users',
  description: 'List the other active users in the tenant (teammates). Use for "who else is on Brain", "who can I delegate to", "is <X> on the team".',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, { userId, clientNumber }) => {
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: number; name: string; email: string; user_type: string; is_active: boolean;
    }>>(
      `SELECT id, name, email, user_type, is_active
         FROM users
        WHERE client_number = $1 AND is_active = TRUE
        ORDER BY id`,
      clientNumber,
    ).catch(() => [] as any[]);
    if (rows.length === 0) return '# Tenant users\n(no active users found)';
    const lines = rows.map((u) => `- ${u.id === userId ? '[YOU] ' : ''}${u.name} <${u.email}> · ${u.user_type}`);
    return `# Tenant users (${rows.length} active)\n${lines.join('\n')}`;
  },
};

// ─── Registry ────────────────────────────────────────────────────

export const BRAIN_TOOLS: BrainToolDefinition[] = [
  fetchCalendar,
  fetchEmails,
  fetchSentEmails,
  fetchWhatsAppThread,
  fetchOpenItems,
  fetchContactFull,
  fetchUserProfile,
  fetchRecentMessages,
  fetchTenantUsers,
];

export function getBrainTool(name: string): BrainToolDefinition | undefined {
  return BRAIN_TOOLS.find((t) => t.name === name);
}

/** Render the tool catalogue for the reasoning system prompt. */
export function renderToolCatalogue(): string {
  const lines: string[] = [];
  for (const t of BRAIN_TOOLS) {
    lines.push(`- **${t.name}**: ${t.description}`);
    const props = t.inputSchema.properties ?? {};
    const required = t.inputSchema.required ?? [];
    for (const k of Object.keys(props)) {
      const p = props[k];
      const isReq = required.includes(k);
      lines.push(`    - ${k}${isReq ? ' (required)' : ''}: ${p.type ?? 'any'}${p.description ? ` — ${p.description}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** Execute a tool call. Returns the rendered Markdown block (or an
 *  error notice formatted the same way — so reasoning gets a uniform
 *  surface even when something goes wrong). */
export async function executeBrainTool(
  name: string,
  input: Record<string, unknown>,
  ctx: BrainToolContext,
): Promise<string> {
  const tool = getBrainTool(name);
  if (!tool) return `# Tool error\nUnknown tool "${name}". Available: ${BRAIN_TOOLS.map((t) => t.name).join(', ')}.`;
  try {
    return await tool.handler(input, ctx);
  } catch (err: any) {
    return `# Tool error (${name})\n${err?.message ?? 'unknown error'}`;
  }
}
