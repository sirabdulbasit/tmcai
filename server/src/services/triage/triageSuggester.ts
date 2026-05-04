/**
 * MyOS — Triage Suggester.
 *
 * Given a batch of fresh feed_events for a user (unread emails, new WhatsApp
 * messages, new tasks, meeting invites), produce a per-event suggestion that
 * Brain thinks the MD should take.
 *
 * Suggestions are lightweight — no LLM call yet — driven by:
 *   1. MD's own history: decision_logs + delegation_logs grouped by
 *      dedup_hash. If the MD has handled "same sender domain + same
 *      archetype" 5× the same way, that's the top suggestion.
 *   2. Archetype heuristics: subject patterns, sender category, existence of
 *      attachments etc. determine the archetype (reply_needed / delegate /
 *      inform_only / schedule / risk / acknowledge).
 *   3. Noise filter: newsletters / bulk / internal announcements get
 *      action='ignore' by default — MD can override, and each override
 *      increments a counter that eventually flips the default.
 *
 * Output per event shape:
 *   {
 *     feedEventId, itemType, sender, subject, preview,
 *     dedupHash, archetype,
 *     suggestedAction: 'draft_reply' | 'delegate' | 'add_open_item' |
 *                      'ignore' | 'schedule_meeting' | 'acknowledge',
 *     confidence: 0..1,
 *     rationale: "MD has done X for this sender N times",
 *     alternatives: Array<{ action, confidence }>,
 *     suggestedDelegateeUserId?: number,
 *     suggestedDelegateeEmail?: string
 *   }
 */
import crypto from 'crypto';
import prisma from '../../db/prisma';
import { scoreCriticality } from './criticalityEngineService';
import { evaluateGate, type GateMatch } from './ruleEngineService';

export type ItemType = 'email' | 'whatsapp' | 'task' | 'meeting';
export type Archetype = 'reply_needed' | 'delegate' | 'inform_only' | 'schedule_meeting' | 'review_risk' | 'acknowledge';
export type SuggestedAction = 'draft_reply' | 'delegate' | 'add_open_item' | 'ignore' | 'schedule_meeting' | 'acknowledge';

export interface AttentionItem {
  feedEventId: string;
  itemType: ItemType;
  from: string;
  fromEmail?: string;
  senderDomain?: string;
  subject: string;
  preview: string;
  receivedAt: string;
  dedupHash: string;
  archetype: Archetype;
  suggestedAction: SuggestedAction;
  confidence: number;
  rationale: string;
  alternatives: Array<{ action: SuggestedAction; confidence: number }>;
  suggestedDelegateeUserId?: number;
  suggestedDelegateeEmail?: string;
  suggestedDelegateeName?: string;
  /** Brain has an ACTIVE rule matching this pattern and will handle it
   *  autonomously — item should not surface in My Attention. */
  handledByRule?: boolean;
  /** Sender is an entity Brain knows from the Wiki layer with strong
   *  relationship (account/project stakeholder, key contact). UI should
   *  float these to the top and mark them visually. */
  critical?: boolean;
  /** Full criticality scorecard (phase 1–4 from the criticality engine).
   *  The UI uses this to explain WHY the item is critical instead of just
   *  a badge. `composite` is the 0–1 score the attention endpoint sorts by. */
  criticality?: {
    composite: number;
    band: 'critical' | 'high' | 'medium' | 'low';
    reasons: string[];
    dimensions: { timePressure: number; impact: number; relationshipRisk: number; cascade: number; patternAnomaly: number };
    superpowers: { absence: boolean; crossSource: boolean; decay: boolean };
  };
  /** True when this item is bulk/noise (newsletters, no-reply automation,
   *  marketing). UI groups these separately so real work isn't buried. */
  noise?: boolean;
  /** Active user-defined rules (mode=SUGGEST) that match this event. The
   *  UI renders each as a one-click "Apply rule X" button so the user
   *  can promote the suggestion into an actual action without typing. */
  suggestedRules?: Array<{
    ruleId: string;
    name: string;
    actionType: string;
    actionPayload: Record<string, unknown>;
    matchedOn: string[];
  }>;
  /** Dynamic, context-aware action buttons to render on the card. When
   *  absent, UI falls back to the default 4 (draft_reply / delegate /
   *  add_open_item / ignore). Each action includes a label tailored to
   *  what Brain already knows (e.g. "Delegate to Asad" when MD has
   *  delegated this sender to Asad 4 times before). */
  actions?: Array<{
    id: string;                 // action key (draft_reply, delegate, delegate_to_known, accept, decline, schedule, acknowledge, ignore, open_item, link_to_existing)
    label: string;              // rendered button text
    primary?: boolean;          // highlight as primary action
    delegatee?: { email?: string; name?: string };
    openItemId?: string;        // for link_to_existing
  }>;
  /** One-line "Brain knows..." context shown under the card — pulled
   *  from Wiki entity + decision history + open items. */
  contextBrief?: string | null;
  /** Calendar-specific fields (only populated when itemType === 'meeting').
   *  Gives the UI enough to render "Fri 2 May · 3:00–4:00 PM · Zoom" and
   *  flag conflicts with existing calendar entries. */
  meeting?: {
    start?: string;          // ISO timestamp
    end?: string;            // ISO timestamp
    isAllDay?: boolean;
    location?: string | null;
    organizerEmail?: string | null;
    selfOrganized?: boolean; // organizer === user (no RSVP needed)
    conflicts?: Array<{
      summary: string;
      start: string;
      end: string;
    }>;
    /** true when no existing events overlap the proposed window */
    isFree?: boolean;
  };
}

const BULK_HEADER_HINTS = /\b(newsletter|digest|unsubscribe|no[-_.]?reply|noreply|mailer|notifications?|updates?)@/i;
const PROMOTIONAL_SUBJECT = /(webinar|save\s+\d+%|\s\bsale\b|unsubscribe|weekly digest|monthly update)/i;
const INTERNAL_ANNOUNCEMENT = /\b(announcement|company update|reminder|holiday|all[- ]?hands)\b/i;
const SCHEDULE_HINTS = /\b(meeting|call|invite|calendar|reschedule|schedule|availability)\b/i;
const APPROVAL_HINTS = /\b(approve|approval|sign.?off|review|authorise|authoris?ation)\b/i;
const QUESTION_HINTS = /\b(question|clarif|please (help|advise|confirm)|can you|could you|kindly|urgent|need your)/i;

// Canonical hash over the dimensions that define "same pattern"
export function computeDedupHash(parts: {
  userId: number;
  itemType: ItemType;
  archetype: Archetype;
  senderDomain?: string;
  actionArchetype?: string;
}): string {
  const str = [
    parts.userId,
    parts.itemType,
    parts.archetype,
    (parts.senderDomain ?? '').toLowerCase(),
    parts.actionArchetype ?? '',
  ].join('::');
  return crypto.createHash('sha256').update(str).digest('hex');
}

function domainOf(email?: string): string | undefined {
  if (!email) return undefined;
  const m = email.match(/@([^>\s]+)/);
  return m?.[1]?.toLowerCase();
}

function classifyArchetype(itemType: ItemType, from: string, subject: string, preview: string): Archetype {
  const all = `${from} ${subject} ${preview}`;
  if (BULK_HEADER_HINTS.test(from) || PROMOTIONAL_SUBJECT.test(subject)) return 'inform_only';
  if (SCHEDULE_HINTS.test(all)) return 'schedule_meeting';
  if (APPROVAL_HINTS.test(all)) return 'review_risk';
  if (QUESTION_HINTS.test(all)) return 'reply_needed';
  if (INTERNAL_ANNOUNCEMENT.test(all)) return 'acknowledge';
  return 'reply_needed';
}

function defaultAction(archetype: Archetype): SuggestedAction {
  switch (archetype) {
    case 'inform_only': return 'ignore';
    case 'schedule_meeting': return 'schedule_meeting';
    case 'review_risk': return 'add_open_item';
    case 'reply_needed': return 'draft_reply';
    case 'acknowledge': return 'acknowledge';
    case 'delegate': return 'delegate';
  }
}

/**
 * Look up MD's history for this pattern. If there's a clear dominant choice,
 * return it as the top suggestion.
 */
async function historyDrivenSuggestion(
  clientNumber: string,
  userId: number,
  dedupHash: string,
): Promise<{ action: SuggestedAction; confidence: number; n: number; delegatee?: { userId?: number; email?: string; name?: string } } | null> {
  const [decisions, delegations] = await Promise.all([
    prisma.decisionLog.findMany({
      where: { clientNumber, userId, dedupHash },
      select: { userDecision: true, actionTaken: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }).catch(() => []),
    prisma.delegationLog.findMany({
      where: { clientNumber, userId, dedupHash },
      select: { delegateeUserId: true, delegateeEmail: true, delegateeName: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }).catch(() => []),
  ]);

  const total = decisions.length + delegations.length;
  if (total < 2) return null; // not enough evidence yet

  // Tally choices. Delegations are their own bucket; within decisions we
  // use user_decision which encodes: approved (= Brain suggestion stood) /
  // overrode / delegated / snoozed / dismissed.
  const buckets: Record<SuggestedAction, number> = {
    draft_reply: 0, delegate: 0, add_open_item: 0, ignore: 0, schedule_meeting: 0, acknowledge: 0,
  };
  for (const d of decisions) {
    const k = d.userDecision?.toLowerCase();
    if (k === 'approved' || k === 'replied') buckets.draft_reply += 1;
    else if (k === 'delegated') buckets.delegate += 1;
    else if (k === 'dismissed' || k === 'ignored') buckets.ignore += 1;
    else if (k === 'snoozed') buckets.add_open_item += 1;
    else if (k === 'overrode') buckets.add_open_item += 1;
  }
  buckets.delegate += delegations.length;

  let top: SuggestedAction = 'draft_reply';
  let topN = 0;
  for (const [action, n] of Object.entries(buckets) as Array<[SuggestedAction, number]>) {
    if (n > topN) { topN = n; top = action; }
  }
  if (topN === 0) return null;
  const confidence = topN / total;

  let delegatee: { userId?: number; email?: string; name?: string } | undefined;
  if (top === 'delegate' && delegations.length > 0) {
    // Pick the most-frequent delegatee
    const tally = new Map<string, { userId?: number; email?: string; name?: string; n: number }>();
    for (const d of delegations) {
      const key = String(d.delegateeUserId ?? d.delegateeEmail ?? 'unknown');
      const cur = tally.get(key) ?? { userId: d.delegateeUserId ?? undefined, email: d.delegateeEmail ?? undefined, name: d.delegateeName ?? undefined, n: 0 };
      cur.n += 1;
      tally.set(key, cur);
    }
    const winner = Array.from(tally.values()).sort((a, b) => b.n - a.n)[0];
    if (winner) delegatee = { userId: winner.userId, email: winner.email, name: winner.name };
  }

  return { action: top, confidence, n: total, delegatee };
}

export async function suggestForFeedEvent(row: {
  id: string;
  clientNumber: string;
  userId: number;
  sourceType: string;
  senderEmail: string | null;
  senderName: string | null;
  rawPayload: Record<string, unknown> | null;
  createdAt: Date;
}): Promise<AttentionItem> {
  const itemType: ItemType =
    row.sourceType === 'gmail' ? 'email' :
    row.sourceType === 'whatsapp' ? 'whatsapp' :
    row.sourceType === 'gcal' ? 'meeting' :
    row.sourceType === 'gtasks' ? 'task' : 'email';

  const payload = row.rawPayload ?? {};
  // Subject varies by source — emails use "subject", calendar uses "summary",
  // tasks use "title", WhatsApp has no subject. Fall through so a calendar
  // invite shows its event name instead of "(no subject)".
  const p: any = payload;
  const subject = String(
    p.subject ?? p.summary ?? p.title ?? p.eventName ?? ''
  ).slice(0, 300);
  const preview = String((payload as any).snippet ?? (payload as any).body ?? (payload as any).description ?? '').slice(0, 200);
  const fromFull = String((payload as any).from ?? (payload as any).organizer?.email ?? (payload as any).organizer?.displayName ?? row.senderName ?? row.senderEmail ?? '');
  const fromEmail = row.senderEmail ?? undefined;
  const senderDomain = domainOf(fromEmail ?? fromFull);

  // ── Self-message gate ──
  // If the sender IS the user (their own email or one of their integration
  // mailboxes — Gmail "from me" copies, WhatsApp messages where isFromMe=true),
  // the item is the user's own outbound, not someone asking THEM for action.
  // Surfacing it as Attention (or worse, pushing it as a critical alert) is
  // the bug behind "Brain: 1 critical item — basit.ahmed@tmcltd.ai is a key
  // client". Skip it entirely.
  const userRow = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { email: true, integrationEmail: true },
  } as any).catch(() => null) as { email?: string | null; integrationEmail?: string | null } | null;
  const userEmails = new Set(
    [userRow?.email, userRow?.integrationEmail]
      .filter(Boolean)
      .map((e) => String(e).toLowerCase()),
  );
  const fromMeFlag = (payload as any).fromMe === true || (payload as any).isFromMe === true;
  const senderIsSelf =
    fromMeFlag ||
    (fromEmail && userEmails.has(String(fromEmail).toLowerCase())) ||
    (typeof fromFull === 'string' && [...userEmails].some((u) => fromFull.toLowerCase().includes(u)));
  if (senderIsSelf) {
    return {
      id: row.id,
      feedEventId: row.id,
      itemType,
      archetype: 'inform_only',
      from: fromFull,
      fromEmail: fromEmail ?? null,
      subject,
      preview,
      receivedAt: row.createdAt.toISOString(),
      sourceType: row.sourceType,
      suggestedAction: 'ignore',
      confidence: 1,
      rationale: 'Self-authored message — not surfaced.',
      alternatives: [],
      handledByRule: false,
      noise: true,                  // keeps it out of My Attention
      critical: false,              // and out of critical-bundle pushes
      criticality: null as any,
      dedupHash: '',
    } as AttentionItem;
  }

  const archetype = classifyArchetype(itemType, fromFull, subject, preview);
  const dedupHash = computeDedupHash({ userId: row.userId, itemType, archetype, senderDomain });

  // ── Rule-Engine Gate ─────────────────────────────────────
  // Run deterministic rules BEFORE any LLM-touching path. A match
  // returns an auto-handled AttentionItem so the criticality engine
  // and any downstream LLM calls are skipped entirely. Fails open:
  // gate errors fall through to the normal triage path.
  let gateMatch: GateMatch | null = null;
  try {
    // Stars are an explicit user signal — when the user has rated
    // this sender ≥ 4 stars, never let a rule auto-archive their
    // message. We read stars here and pass into the gate so rules
    // can predicate on `importance_stars`.
    let importanceStars = 0;
    if (row.senderEmail) {
      try {
        const { getStarsForSender } = await import('../knowledge/entitySweepService');
        importanceStars = await getStarsForSender(row.clientNumber, row.userId, row.senderEmail);
      } catch { /* default 0 */ }
    }
    gateMatch = await evaluateGate({
      clientNumber: row.clientNumber,
      userId: row.userId,
      event: {
        id: row.id,
        sourceType: row.sourceType,
        eventType: (payload as any)?.eventType ?? null,
        senderEmail: row.senderEmail,
        senderName: row.senderName,
        recipientCount: Array.isArray((payload as any)?.to) ? (payload as any).to.length : 1,
        isCcOnly: !!(payload as any)?.ccOnly,
        hasAttachment: !!(payload as any)?.hasAttachment,
        subject, bodyPreview: preview,
        receivedAt: row.createdAt,
        importanceStars,
      },
    });
    // Hard rule: stars 4-5 senders bypass auto_handle/auto_ack/block
    // even if a rule matched. The rule still fires (auditable in
    // gate_rule_firings) but we override the decision so the message
    // surfaces normally.
    if (gateMatch && importanceStars >= 4 &&
        ['auto_handle', 'auto_ack', 'block'].includes(gateMatch.decision)) {
      gateMatch = null;
    }
  } catch { /* gate is fail-open by design */ }

  if (gateMatch) {
    const a = gateMatch.action;
    const isNoise = a.decision === 'auto_ack' || (a.tags ?? []).includes('newsletter');
    return {
      feedEventId: row.id,
      itemType,
      from: fromFull,
      fromEmail,
      senderDomain,
      subject,
      preview,
      receivedAt: row.createdAt.toISOString(),
      dedupHash,
      archetype,
      suggestedAction: a.openItemAction === 'tag_and_close' ? 'ignore'
        : a.decision === 'auto_ack' ? 'ignore'
        : a.decision === 'block' ? 'ignore'
        : 'add_open_item',
      confidence: 1.0,
      rationale: `Gate rule "${gateMatch.ruleName}" (${gateMatch.ruleScope}) matched — ${a.decision}.`,
      alternatives: [],
      handledByRule: true,
      noise: isNoise,
    } as AttentionItem;
  }

  const history = await historyDrivenSuggestion(row.clientNumber, row.userId, dedupHash);

  let suggestedAction: SuggestedAction = defaultAction(archetype);
  let confidence = 0.35;
  let rationale = `No prior pattern — applying default for ${archetype.replace('_', ' ')}`;
  let delegatee: { userId?: number; email?: string; name?: string } | undefined;

  if (history) {
    suggestedAction = history.action;
    confidence = Math.max(confidence, history.confidence);
    rationale = `MD chose this ${history.n} times before (${Math.round(history.confidence * 100)}% consistent)`;
    delegatee = history.delegatee;
  }

  // Even if history is thin, offer a best-fit delegatee recommendation from
  // the People Intelligence retriever — it reads users + delegation history
  // + workload + department tokens. Promotes "Delegate" to a real name.
  if (!delegatee || !delegatee.userId) {
    try {
      const { suggestOwner } = await import('../knowledge/peopleIntelligenceService');
      const owners = await suggestOwner({
        clientNumber: row.clientNumber,
        itemType,
        archetype,
        senderDomain,
        senderEmail: fromEmail,
        subject,
        preview,
        excludeUserId: row.userId,
        limit: 1,
      });
      const top = owners[0];
      if (top && top.score > 0.1) {
        delegatee = { userId: top.userId, email: top.email, name: top.name };
        // Only bump confidence + rationale if we weren't already confident from
        // history; this complements the hash match rather than replacing it.
        if (!history) {
          rationale = top.reasons.length > 0
            ? `${top.name}: ${top.reasons.slice(0, 2).join(' · ')}`
            : `${top.name} has the closest fit`;
        }
      }
    } catch {
      /* best-effort — fall back to no-name delegate */
    }
  }

  // If there's an ACTIVE shadow_rule matching this hash, the suggestion IS
  // what Brain will execute autonomously (or has already executed). We mark
  // it so the UI can hide it from My Attention.
  const activeRule = await prisma.shadowRule.findFirst({
    where: { clientNumber: row.clientNumber, userId: row.userId, mode: 'ACTIVE', triggerCondition: { path: ['hash'], equals: dedupHash } as any },
    select: { id: true, action: true, agreement: true },
  }).catch(() => null);
  if (activeRule) {
    suggestedAction = (activeRule.action as SuggestedAction) || suggestedAction;
    confidence = Math.max(confidence, activeRule.agreement ?? 0.95);
    rationale = `Active rule #${activeRule.id} (${Math.round((activeRule.agreement ?? 0) * 100)}% agreement) — Brain handles this`;
  }

  // Always include the two most common alternatives so the MD sees options
  const alt: SuggestedAction[] = ['draft_reply', 'delegate', 'add_open_item', 'ignore'].filter((a) => a !== suggestedAction) as SuggestedAction[];
  const alternatives = alt.slice(0, 3).map((action) => ({ action, confidence: 0.15 }));

  // ── Noise detection ──
  // Bulk senders, marketing, auto-generated notifications. If the archetype
  // is inform_only AND the sender looks automated (no-reply, mailer-daemon,
  // newsletters), mark it so the UI can group it separately.
  const fromRaw = String((row.rawPayload as any)?.from ?? row.senderEmail ?? '').toLowerCase();
  const looksAutomated = BULK_HEADER_HINTS.test(fromRaw) ||
    /mailer[- ]daemon/.test(fromRaw) ||
    /bounce|noreply|no[-_.]?reply|notifications?@|updates?@|alerts?@|digest@/.test(fromRaw);
  const noise = archetype === 'inform_only' && looksAutomated;

  // ── Full sender context + organization snapshot ──
  // Wiki entity + historical decisions + delegations + open items + full
  // 90-day message history from this sender + current thread/chat +
  // tenant-wide org state. Everything Brain could reasonably know before
  // forming an opinion about this one event.
  const { gatherSenderContext, summariseContext } = await import('../knowledge/contextEnricher');
  const threadId = (payload as any).threadId ?? null;
  const threadContextSeed = Array.isArray((payload as any).threadContext)
    ? (payload as any).threadContext
    : undefined;
  const [ctx, org, topicSnippet] = await Promise.all([
    gatherSenderContext({
      clientNumber: row.clientNumber,
      userId: row.userId,
      senderEmail: fromEmail ?? null,
      threadId,
      threadContextSeed,
      sourceType: row.sourceType,
    }).catch(() => null),
    (async () => {
      try {
        const { getOrgSnapshot } = await import('../knowledge/organizationKnowledge');
        return await getOrgSnapshot(row.clientNumber, row.userId);
      } catch { return null; }
    })(),
    (async () => {
      if (!fromEmail || !dedupHash) return null;
      try {
        const { getSenderTopicMarkdown } = await import('../knowledge/senderWikiService');
        return await getSenderTopicMarkdown(row.clientNumber, row.userId, fromEmail, dedupHash, 600);
      } catch { return null; }
    })(),
  ]);

  let contextBrief: string | null = null;
  if (ctx) contextBrief = summariseContext(ctx);

  // ── Calendar details + conflict check ──
  // Extract start/end/location + check whether it overlaps with anything
  // already on MD's calendar. Drives both the date/time line on the card
  // and the "Propose alternative" action when conflicts exist.
  let meeting: AttentionItem['meeting'] | undefined;
  if (itemType === 'meeting') {
    const pm: any = payload;
    const startStr = pm.start ?? pm.start?.dateTime ?? pm.start?.date ?? null;
    const endStr = pm.end ?? pm.end?.dateTime ?? pm.end?.date ?? null;
    const organizerEmail = pm.organizer?.email ?? pm.organizer ?? null;
    const userEmail = await prisma.user.findUnique({ where: { id: row.userId }, select: { email: true, integrationEmail: true } as any })
      .then((u) => (u as any)?.integrationEmail ?? u?.email ?? null).catch(() => null);
    const selfOrganized = !!(organizerEmail && userEmail && String(organizerEmail).toLowerCase() === String(userEmail).toLowerCase());

    // Conflict check — only if we have a real start/end and it's not all-day.
    let conflicts: Array<{ summary: string; start: string; end: string }> = [];
    let isFree: boolean | undefined;
    try {
      if (startStr && endStr && !pm.isAllDay && !selfOrganized) {
        const startD = new Date(startStr);
        const endD = new Date(endStr);
        if (!isNaN(startD.getTime()) && !isNaN(endD.getTime()) && endD > startD) {
          const { getEvents } = await import('../calendarService');
          const widen = 30 * 60 * 1000; // pad 30 min each side to catch borderline overlaps
          const r = await getEvents(row.userId, new Date(startD.getTime() - widen), new Date(endD.getTime() + widen), 25);
          conflicts = (r.events || [])
            .filter((e: any) => e.id !== pm.eventId && e.start && e.end)
            .filter((e: any) => {
              const s = new Date(e.start).getTime();
              const en = new Date(e.end).getTime();
              return s < endD.getTime() && en > startD.getTime();
            })
            .slice(0, 3)
            .map((e: any) => ({
              summary: String(e.title ?? e.summary ?? '(untitled)'),
              start: new Date(e.start).toISOString(),
              end: new Date(e.end).toISOString(),
            }));
          isFree = conflicts.length === 0;
        }
      }
    } catch { /* best-effort */ }

    meeting = {
      start: startStr ? new Date(startStr).toISOString() : undefined,
      end: endStr ? new Date(endStr).toISOString() : undefined,
      isAllDay: !!pm.isAllDay,
      location: pm.location ?? null,
      organizerEmail,
      selfOrganized,
      conflicts,
      isFree,
    };
  }

  // ── LIVING BRAIN: LLM reasoner ──
  // Replaces hardcoded rationale templates + branching action logic with
  // a single context-aware LLM call. Cached per dedup_hash for 1 hour so
  // N matching attention cards share 1 reasoning call.
  const { reasonAboutEvent } = await import('./triageReasoner');
  const faclDocs = org?.faclDocs ?? [];
  // Shortlist FACL docs whose title keywords appear in the subject/preview
  // so the LLM sees the most relevant ones first (everything else is
  // available via the title list).
  const blob = (subject + ' ' + preview).toLowerCase();
  const faclRelevantDocs = faclDocs.filter((d: any) => {
    const title = String(d.title).toLowerCase();
    const words = title.split(/[\s/—–-]+/).filter((w: string) => w.length >= 4);
    return words.some((w: string) => blob.includes(w));
  }).slice(0, 3).map((d: any) => ({ title: d.title, summary: String(d.summary || '').slice(0, 400) }));

  const senderOnActiveAccount = !!(org && ctx?.entity?.company && org.activeAccounts.some((a: any) => a.company && a.company.toLowerCase() === ctx.entity!.company!.toLowerCase()));
  const senderOnActiveProject = !!(org && ctx?.entity?.company && org.activeProjects.some((p: any) => p.company && p.company.toLowerCase() === ctx.entity!.company!.toLowerCase()));

  const decision = await reasonAboutEvent(dedupHash, {
    userId: row.userId,
    clientNumber: row.clientNumber,
    itemType,
    sourceType: row.sourceType,
    from: fromFull,
    fromEmail: fromEmail ?? null,
    senderDomain: senderDomain ?? null,
    subject,
    preview,
    sender: {
      isKnown: ctx?.stats.isKnownContact ?? false,
      entityName: ctx?.entity?.name ?? null,
      company: ctx?.entity?.company ?? null,
      role: ctx?.entity?.role ?? null,
      relationshipStrength: ctx?.entity?.relationshipStrength ?? null,
      interactionCount: ctx?.stats.interactionCount ?? 0,
      firstContact: ctx?.stats.firstContact ?? true,
      senderHistoryMarkdown: ctx?.wikiSnippet ?? null,
      topicMemoryMarkdown: topicSnippet,
      recentDecisionCounts: (ctx?.decisions ?? []).reduce((acc: Record<string, number>, d) => {
        acc[d.action] = (acc[d.action] ?? 0) + d.count;
        return acc;
      }, {}),
      dominantDelegatee: ctx?.stats.dominantDelegatee ?? null,
      dominantDelegationCount: ctx?.stats.totalDelegations ?? 0,
      relatedOpenItems: (ctx?.relatedOpenItems ?? []).slice(0, 5).map((o) => ({ title: o.title, status: o.status })),
      threadContext: (ctx?.threadContext ?? []).slice(-6).map((t) => ({ from: t.from, text: t.text })),
    },
    org: {
      senderOnActiveAccount,
      senderOnActiveProject,
      faclDocTitles: faclDocs.map((d: any) => d.title),
      faclRelevantDocs,
    },
    meeting: meeting ? {
      start: meeting.start, end: meeting.end, isAllDay: meeting.isAllDay,
      selfOrganized: meeting.selfOrganized,
      hasConflicts: (meeting.conflicts?.length ?? 0) > 0,
      conflictTitles: meeting.conflicts?.map((c: any) => c.summary) ?? [],
    } : undefined,
    activeRule: activeRule ? { action: activeRule.action, agreement: activeRule.agreement ?? 0 } : null,
  });

  // Preserve the link_to_existing openItemId since the LLM doesn't know it
  if (ctx && ctx.relatedOpenItems.length > 0) {
    const link = ctx.relatedOpenItems[0];
    decision.actions = decision.actions.map((a) =>
      a.id === 'link_to_existing' ? { ...a, openItemId: link.id } as any : a,
    );
  }

  // Criticality scoring — runs the full 5-dimension + 3-superpower engine
  // against this event. Replaces the LLM's boolean `critical` flag with a
  // principled 0..1 composite score. Noise items skip scoring (bulk/auto
  // stuff by definition isn't critical).
  let criticality: Awaited<ReturnType<typeof scoreCriticality>> | null = null;
  if (!decision.noise) {
    // User email lookup — needed for To/CC addressing analysis.
    const u = await prisma.user.findUnique({
      where: { id: row.userId },
      select: { email: true, integrationEmail: true, clientNumber: true },
    }).catch(() => null);
    const userEmail = u?.integrationEmail ?? u?.email ?? null;
    // Safety: only use the user row if it belongs to the same tenant.
    const sameTenant = u?.clientNumber === row.clientNumber;
    const senderEntity = ctx?.entity ?? null;
    try {
      criticality = await scoreCriticality({
        clientNumber: row.clientNumber,
        userId: row.userId,
        itemType: itemType as any,
        sourceType: row.sourceType,
        from: fromFull,
        fromEmail: fromEmail ?? null,
        toHeader: typeof p.to === 'string' ? p.to : null,
        ccHeader: typeof p.cc === 'string' ? p.cc : null,
        userEmail: sameTenant ? userEmail : null,
        subject, preview,
        receivedAt: row.createdAt,
        entityId: (senderEntity as any)?.id ?? null,
        senderDomain: senderDomain ?? null,
        relationshipStrength: (senderEntity as any)?.relationshipStrength ?? null,
        hints: {
          isSenderOnActiveAccount: senderOnActiveAccount,
        },
      });
    } catch { /* leave criticality null; fall back to LLM's boolean */ }
  }

  const isCritical = criticality ? criticality.band === 'critical' : !!decision.critical;

  // User-defined action rules — surface SUGGEST-mode matches on this
  // event so the UI can render a one-click "Apply rule X" button. AUTO
  // rules already fired in autonomousExecutor before we got here, so
  // they won't surface as suggestions. DRAFT rules only log silently.
  let suggestedRules: AttentionItem['suggestedRules'] = undefined;
  try {
    const triggerKind: import('../userActionRuleService').TriggerKind =
      row.sourceType === 'gmail' ? 'inbound_email'
      : row.sourceType === 'whatsapp' ? 'inbound_whatsapp'
      : row.sourceType === 'gchat' ? 'inbound_chat'
      : 'inbound_any';
    const { evaluateRulesForEvent } = await import('../userActionRuleService');
    const matches = await evaluateRulesForEvent({
      clientNumber: row.clientNumber, userId: row.userId,
      triggerKind,
      senderEmail: fromEmail ?? null,
      senderName: row.senderName ?? null,
      senderDomain: senderDomain ?? null,
      subject, body: preview,
      archetype,
    });
    const suggestMatches = matches.filter((m) => m.rule.mode === 'SUGGEST');
    if (suggestMatches.length > 0) {
      suggestedRules = suggestMatches.map((m) => ({
        ruleId: m.rule.id,
        name: m.rule.name,
        actionType: m.rule.actionType,
        actionPayload: m.rule.actionPayload,
        matchedOn: m.matchedOn,
      }));
    }
  } catch { /* best effort — don't fail the suggester on rule lookup */ }

  return {
    feedEventId: row.id,
    itemType,
    from: fromFull,
    fromEmail,
    senderDomain,
    subject,
    preview,
    receivedAt: row.createdAt.toISOString(),
    dedupHash,
    archetype: decision.archetype,
    suggestedAction: decision.suggestedAction,
    confidence: decision.confidence,
    rationale: decision.rationale,
    alternatives,
    suggestedDelegateeUserId: delegatee?.userId,
    suggestedDelegateeEmail: delegatee?.email,
    suggestedDelegateeName: delegatee?.name,
    handledByRule: !!activeRule,
    critical: isCritical,
    noise: decision.noise,
    actions: decision.actions as any,
    suggestedRules,
    contextBrief,
    meeting,
    criticality: criticality ? {
      composite: criticality.composite,
      band: criticality.band,
      reasons: criticality.reasons,
      dimensions: criticality.dimensions,
      superpowers: {
        absence:     criticality.superpowers.absence.triggered,
        crossSource: criticality.superpowers.crossSource.triggered,
        decay:       criticality.superpowers.decay.triggered,
      },
    } : undefined,
  };
}

/**
 * Best-effort extractor of the source-native event timestamp from a
 * feed_event payload. Falls back to row.createdAt when nothing parseable.
 *
 * Why this matters: feed_events.createdAt is INGESTION time. When the
 * historical scribe pulls 30 days of Gmail in one pass, every row gets
 * createdAt=now() — making the 7-day attention window catch month-old
 * emails as if they just arrived. We need the source's own timestamp:
 *   - Gmail: rawPayload.date (RFC2822 from the Date: header)
 *   - WhatsApp: rawPayload.timestamp (Unix seconds)
 *   - Calendar: rawPayload.start (ISO date or { dateTime })
 */
function extractEventOccurredAt(row: { rawPayload: any; createdAt: Date }): Date {
  const p = row.rawPayload || {};
  // Gmail
  if (typeof p.date === 'string' && p.date) {
    const t = Date.parse(p.date);
    if (Number.isFinite(t)) return new Date(t);
  }
  // WhatsApp — webjs gives Unix seconds; tolerate ms.
  if (typeof p.timestamp === 'number' && p.timestamp > 0) {
    const ms = p.timestamp < 1e12 ? p.timestamp * 1000 : p.timestamp;
    return new Date(ms);
  }
  // Calendar — start is either ISO string or { dateTime, date }
  if (p.start) {
    if (typeof p.start === 'string') {
      const t = Date.parse(p.start);
      if (Number.isFinite(t)) return new Date(t);
    } else if (typeof p.start === 'object') {
      const s = p.start.dateTime ?? p.start.date;
      if (typeof s === 'string') {
        const t = Date.parse(s);
        if (Number.isFinite(t)) return new Date(t);
      }
    }
  }
  return row.createdAt;
}

/**
 * Return attention items for the user. Caller passes feed_event rows (unread
 * / not-yet-acted-on). Each returns with a fresh suggestion.
 */
export async function buildAttentionList(
  clientNumber: string,
  userId: number,
  limit = 30,
): Promise<AttentionItem[]> {
  // 7-day rolling window of items MD hasn't decided on yet. We no longer
  // gate on feed_events.status — that column is sometimes flipped to
  // 'processed' by legacy code paths even when the user hasn't touched
  // anything. Instead we exclude rows that have a matching decision_log
  // (the authoritative signal that MD acted on this specific event).
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Only TERMINAL decisions hide the card. 'drafted' is pending — MD
  // started drafting but hasn't sent, so we keep showing the card with
  // the draft rendered inline below it.
  const TERMINAL_DECISIONS = ['approved', 'delegated', 'snoozed', 'dismissed', 'overrode'];
  const decidedIds = await prisma.decisionLog.findMany({
    where: {
      clientNumber, userId,
      createdAt: { gte: sevenDaysAgo },
      entityId: { not: null } as any,
      userDecision: { in: TERMINAL_DECISIONS } as any,
    } as any,
    select: { entityId: true },
  }).catch(() => [] as Array<{ entityId: string | null }>);
  const decidedSet = new Set(decidedIds.map((d) => d.entityId).filter(Boolean) as string[]);

  // Widen the SQL window to 90 days. The historical scribe writes
  // createdAt=now() for month-old emails, so a tight 7-day SQL window
  // would either miss legitimately fresh items (if it strictly used the
  // event's true date — we don't have that as a column yet) or include
  // a flood of month-old rows (current behaviour). We over-fetch here
  // and filter on the source-native timestamp in JS below.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const rows = await prisma.feedEvent.findMany({
    where: {
      clientNumber,
      userId,
      sourceType: { in: ['gmail', 'whatsapp', 'gcal', 'gtasks'] as any },
      createdAt: { gte: ninetyDaysAgo },
    } as any,
    select: { id: true, clientNumber: true, userId: true, sourceType: true, senderEmail: true, senderName: true, rawPayload: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: limit * 10, // over-fetch — most rows will be filtered out by the 7-day event-date filter
  });

  // Drop events whose dedup_hash has been hidden by this user.
  const hashes = new Set<string>();
  const hidden = await prisma.patternHidden.findMany({
    where: { clientNumber, userId, source: 'decision' },
    select: { dedupHash: true },
  });
  hidden.forEach((h) => hashes.add(h.dedupHash));

  // Filter:
  //  1. Drop already-decided rows (no point running LLM on them).
  //  2. Drop rows whose source-native timestamp is older than the 7-day
  //     attention window. Without this, historical scribe ingests every
  //     row with createdAt=now() and floods My Attention with month-old
  //     mail.
  const candidates = rows.filter((r) => {
    if (decidedSet.has(r.id)) return false;
    const eventDate = extractEventOccurredAt(r);
    return eventDate >= sevenDaysAgo;
  });

  // Run suggestForFeedEvent in PARALLEL across candidates. Each call does
  // 5+ DB reads (entity, decisions, delegations, open items, wiki, org
  // snapshot) — serializing them meant Day Brief load grew linearly with
  // attention count. Promise.all cuts that to the slowest single row.
  const suggestions = await Promise.all(candidates.map((r) =>
    suggestForFeedEvent({
      id: r.id,
      clientNumber: r.clientNumber,
      userId: r.userId ?? userId,
      sourceType: r.sourceType,
      senderEmail: r.senderEmail,
      senderName: r.senderName,
      rawPayload: r.rawPayload as Record<string, unknown> | null,
      createdAt: r.createdAt,
    }).catch(() => null),
  ));

  const items: AttentionItem[] = [];
  for (const item of suggestions) {
    if (!item) continue;
    if (items.length >= limit) break;
    if (hashes.has(item.dedupHash)) continue;
    if (item.handledByRule) continue;  // autonomous — lives in Section 1, not Attention
    items.push(item);
  }

  // Hard cap on the critical band. The old UX was drowning in
  // false-positive criticals because the LLM's boolean flag was too
  // liberal. We now have a 0..1 composite from the criticality engine,
  // so we can be strict: keep at most MAX_CRITICAL items flagged
  // critical (the highest-scoring ones), and demote the rest to regular.
  // This preserves the SIGNAL the badge is supposed to carry.
  const MAX_CRITICAL = 5;
  const criticals = items
    .map((it, idx) => ({ idx, score: it.criticality?.composite ?? (it.critical ? 0.8 : 0) }))
    .filter((x) => x.score >= 0.8)
    .sort((a, b) => b.score - a.score);
  const keepIdx = new Set(criticals.slice(0, MAX_CRITICAL).map((x) => x.idx));
  for (let i = 0; i < items.length; i++) {
    if (items[i].critical && !keepIdx.has(i)) {
      items[i].critical = false;  // demote excess criticals to regular band
    }
  }

  // Sort: critical first (by composite DESC), then others by composite DESC,
  // then by receivedAt DESC. Keeps the highest-signal items at the top.
  items.sort((a, b) => {
    if (!!a.critical !== !!b.critical) return a.critical ? -1 : 1;
    const sa = a.criticality?.composite ?? 0;
    const sb = b.criticality?.composite ?? 0;
    if (sb !== sa) return sb - sa;
    return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
  });

  return items;
}
