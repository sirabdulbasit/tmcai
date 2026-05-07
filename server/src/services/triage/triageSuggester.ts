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
  /** Raw RFC2822 form ("Name <addr@x>") — kept for pattern matching
   *  inside the engine. Don't render this to the user. */
  from: string;
  /** Cleaned display name for the UI. Title-cased, no angle brackets,
   *  falls back to the email's local-part when the From: header had no
   *  display name. Always prefer this over `from` for rendering. */
  fromDisplay?: string;
  fromEmail?: string;
  senderDomain?: string;
  /** Importance stars (0..5) the user assigned to this sender in
   *  Contacts. UI surfaces ★ next to the name on the card so the user
   *  can see WHY a routine-looking message is being treated as
   *  critical. 0 means unrated; we still send the field so the
   *  client can render absence consistently. */
  senderStars?: number;
  /** Addressing classification for emails:
   *    'to'    — user's email is in the To header (action expected)
   *    'cc'    — user is CC-only (informational)
   *    'bcc'   — user is BCC (rare, similar to To/CC depending on intent)
   *    'none'  — user not in any header (mailing list, fwd, etc.)
   *    null    — non-email or info missing
   *  UI surfaces a small pill on the card so the user sees why an
   *  email is in inform_only vs reply_needed. */
  addressing?: 'to' | 'cc' | 'bcc' | 'none' | null;
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

// In-memory cache for triage results. Keyed by feed_event_id; value is
// the full AttentionItem the suggester returned. Survives multiple
// /brief/attention requests within the same Node process. Cleared on
// boot (restart = warm cache rebuilds).
//
// Invalidation strategy:
//   - TTL: 10 min — caps how stale a cached suggestion can be (history
//     shifts as user decides on similar items)
//   - explicit clear when decision_log writes (called from /brief/decide)
//   - explicit clear when pattern_hidden writes (called from /brief/hide)
//
// Cache hit avoids: archetype classify + history lookup + criticality
// scoring (5 dimension calls) + rule gate eval. Big savings — first
// page load is ~11s for haseeb's 200 candidates; second load (warm
// cache) drops to ~1s because almost every row hits.
const TRIAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const triageCache = new Map<string, { value: AttentionItem; expires: number }>();
// Bound the cache so a busy tenant doesn't blow heap. LRU-ish — when
// over limit we drop the oldest 20% in one sweep.
const TRIAGE_CACHE_MAX = 5000;

export function invalidateTriageCache(feedEventId: string): void {
  triageCache.delete(feedEventId);
}

export function clearTriageCache(): void {
  triageCache.clear();
}

// Public entrypoint — returns cached result if available, otherwise
// runs the full pipeline and caches.
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
  const cached = triageCache.get(row.id);
  if (cached && cached.expires > Date.now()) {
    return cached.value;
  }
  const result = await _doTriage(row);
  // Cap cache size — drop oldest entries first.
  if (triageCache.size >= TRIAGE_CACHE_MAX) {
    const toDelete = Math.floor(TRIAGE_CACHE_MAX * 0.2);
    let i = 0;
    for (const key of triageCache.keys()) {
      if (i >= toDelete) break;
      triageCache.delete(key);
      i++;
    }
  }
  triageCache.set(row.id, { value: result, expires: Date.now() + TRIAGE_CACHE_TTL_MS });
  return result;
}

async function _doTriage(row: {
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
    row.sourceType === 'gchat' ? 'whatsapp' :  // Google Chat shares the WhatsApp tab — both are real-time chat
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
  // Compute a cleaned display name once. Used for every AttentionItem
  // render so the Day Brief never shows raw RFC2822 ("L&OD\" <…>") or
  // stray quote artifacts. Engine still uses fromFull internally for
  // pattern-matching (bulk-mailer detection etc.) where the raw form
  // carries signal.
  const { normalizeContactName } = await import('../knowledge/entitySweepService');
  const fromDisplay = normalizeContactName(row.senderName ?? fromFull, fromEmail ?? null) || (fromEmail ?? fromFull);

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
      fromDisplay,
      fromEmail: fromEmail ?? null,
      subject,
      preview,
      receivedAt: extractEventOccurredAt(row).toISOString(),
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

  // Addressing-aware archetype. The bare classifyArchetype only sees
  // sender + subject + preview — it can't tell whether the user is
  // CC-only (informational) or in the To header (action expected).
  // Apply a deterministic override BEFORE the LLM path so CC-only
  // emails consistently land as inform_only without needing the
  // criticality engine to figure it out from prose.
  let archetype = classifyArchetype(itemType, fromFull, subject, preview);
  if (itemType === 'email') {
    const toRaw = String((payload as any).to ?? '').toLowerCase();
    const ccRaw = String((payload as any).cc ?? '').toLowerCase();
    const meEmails = userEmails;  // already computed for self-message gate
    const userInTo = [...meEmails].some((e) => toRaw.includes(e));
    const userInCc = [...meEmails].some((e) => ccRaw.includes(e));
    if (userInCc && !userInTo) {
      // CC-only → almost always informational. Override unless the
      // base classifier flagged it as schedule_meeting or review_risk
      // (those are still action-relevant even when CC'd).
      if (archetype !== 'schedule_meeting' && archetype !== 'review_risk') {
        archetype = 'inform_only';
      }
    }
  }
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
        receivedAt: extractEventOccurredAt(row),
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

  // ── Platform-default automated-sender filter ─────────────
  // Catches departmental mailers (LOD@, training@, announcements@,
  // events@, advisory@, etc.) and embedded-noreply addresses
  // (powerautomatenoreply@…) that already exist as contacts. The
  // contact-create junk filter doesn't help here because the row
  // already exists. Same star-bypass as the rule gate: ≥4★ senders
  // never get auto-archived even by this filter.
  if (!gateMatch && fromEmail) {
    let importanceStars = 0;
    try {
      const { getStarsForSender } = await import('../knowledge/entitySweepService');
      importanceStars = await getStarsForSender(row.clientNumber, row.userId, fromEmail);
    } catch { /* default 0 */ }
    if (importanceStars < 4) {
      const { isLikelyAutomated } = await import('../knowledge/senderQualityFilter');
      if (isLikelyAutomated(fromEmail)) {
        return {
          feedEventId: row.id,
          itemType,
          from: fromFull,
      fromDisplay,
          fromEmail,
          senderDomain,
          subject,
          preview,
          receivedAt: extractEventOccurredAt(row).toISOString(),
          dedupHash,
          archetype: 'inform_only',
          suggestedAction: 'ignore',
          confidence: 0.95,
          rationale: 'Automated / departmental mailer pattern — auto-archived. Star this sender to override.',
          alternatives: [],
          handledByRule: true,
          noise: true,
        } as AttentionItem;
      }
    }
  }

  if (gateMatch) {
    const a = gateMatch.action;
    const isNoise = a.decision === 'auto_ack' || (a.tags ?? []).includes('newsletter');
    return {
      feedEventId: row.id,
      itemType,
      from: fromFull,
      fromDisplay,
      fromEmail,
      senderDomain,
      subject,
      preview,
      receivedAt: extractEventOccurredAt(row).toISOString(),
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
      // Look up the delegator's identity so we can exclude them from
      // candidates by email + name, not just userId. Catches the
      // "delegate to yourself" bug when duplicate user rows exist or
      // when the delegator's name fuzzy-matches another user.
      const me = await prisma.user.findUnique({
        where: { id: row.userId },
        select: { email: true, name: true, integrationEmail: true } as any,
      }).catch(() => null) as { email?: string | null; name?: string | null; integrationEmail?: string | null } | null;

      const owners = await suggestOwner({
        clientNumber: row.clientNumber,
        itemType,
        archetype,
        senderDomain,
        senderEmail: fromEmail,
        subject,
        preview,
        excludeUserId: row.userId,
        excludeEmail: me?.email ?? null,
        excludeIntegrationEmail: me?.integrationEmail ?? null,
        excludeName: me?.name ?? null,
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
        receivedAt: extractEventOccurredAt(row),
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
      fromDisplay,
    fromEmail,
    senderDomain,
    subject,
    preview,
    receivedAt: extractEventOccurredAt(row).toISOString(),
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
    // Sender's importance stars (0..5). Sourced from the criticality
    // engine's signals so we never disagree with it. UI shows ★ next
    // to the sender name on the card.
    senderStars: (criticality as any)?.signals?.importanceStars ?? 0,
    // Addressing classification — compute once, surface on the card.
    addressing: (() => {
      if (itemType !== 'email') return null;
      const toRaw = String((payload as any).to ?? '').toLowerCase();
      const ccRaw = String((payload as any).cc ?? '').toLowerCase();
      const bccRaw = String((payload as any).bcc ?? '').toLowerCase();
      const meEmails = userEmails;
      const inTo = [...meEmails].some((e) => toRaw.includes(e));
      const inCc = [...meEmails].some((e) => ccRaw.includes(e));
      const inBcc = [...meEmails].some((e) => bccRaw.includes(e));
      if (inTo) return 'to' as const;
      if (inCc) return 'cc' as const;
      if (inBcc) return 'bcc' as const;
      return 'none' as const;
    })(),
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
  // Rolling window of items MD hasn't decided on yet. Default 7 days,
  // overridable via ATTENTION_WINDOW_DAYS env (e.g. 30 for dev/staging
  // where the DB dump is older and 7 days would exclude everything).
  // We no longer gate on feed_events.status — that column is
  // sometimes flipped to 'processed' by legacy code paths even when
  // the user hasn't touched anything. Instead we exclude rows that
  // have a matching decision_log (the authoritative signal that MD
  // acted on this specific event).
  // Window split per user spec (2026-05-07): My Attention surfaces up
  // to 30 days of unattended items so nothing falls through. Brief
  // (buildHandledList) keeps the tighter 7-day audit window. Anything
  // older lives in Wiki, searchable.
  const ATTENTION_WINDOW_DAYS = Math.max(1, Math.min(90, parseInt(process.env.ATTENTION_WINDOW_DAYS ?? '30', 10) || 30));
  const sevenDaysAgo = new Date(Date.now() - ATTENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

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

  // Thread-replied set: any Gmail thread the user has already sent a
  // reply on (via Brain's draft system) within the last 30 days. New
  // feed_events for the SAME thread create new feedEventIds, so the
  // decidedSet above (keyed by feedEventId) doesn't catch follow-on
  // pulls of the same conversation. Without this, "Looking for
  // Opportunity" surfaces a 3rd time after MD has already replied
  // twice — observed on prod 2026-05-07. Resolve by mapping recent
  // 'reply_sent' decisions back to their threadIds via feed_events.
  const replyWindowAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const repliedRows = await prisma.decisionLog.findMany({
    where: {
      clientNumber, userId,
      createdAt: { gte: replyWindowAgo },
      actionTaken: 'reply_sent',
      entityId: { not: null } as any,
    } as any,
    select: { entityId: true },
  }).catch(() => [] as Array<{ entityId: string | null }>);
  const repliedFeIds = repliedRows.map((r) => r.entityId).filter(Boolean) as string[];
  const repliedThreadIds = new Set<string>();
  if (repliedFeIds.length > 0) {
    const repliedFeeds = await prisma.feedEvent.findMany({
      where: { id: { in: repliedFeIds }, clientNumber, sourceType: 'gmail' },
      select: { rawPayload: true },
    }).catch(() => [] as Array<{ rawPayload: any }>);
    for (const f of repliedFeeds) {
      const tid = (f.rawPayload as any)?.threadId;
      if (typeof tid === 'string' && tid) repliedThreadIds.add(tid);
    }
  }

  // Widen the SQL window to 90 days. The historical scribe writes
  // createdAt=now() for month-old emails, so a tight 7-day SQL window
  // would either miss legitimately fresh items (if it strictly used the
  // event's true date — we don't have that as a column yet) or include
  // a flood of month-old rows (current behaviour). We over-fetch here
  // and filter on the source-native timestamp in JS below.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  // Hard ceiling on rows we ever try to triage in one request. With a
  // wide ATTENTION_WINDOW_DAYS (e.g. 30 on dev) the over-fetch ceiling
  // can climb into the thousands; running suggestForFeedEvent over
  // 1000+ rows in parallel exhausts heap (4GB OOM observed on
  // 2026-05-07). Cap protects steady-state regardless of window
  // width.
  const MAX_CANDIDATES = 200;
  // Per-channel quotas — without this, a busy channel (166 Google
  // Tasks, observed on prod 2026-05-07) crowds out everything else
  // because eventDate-DESC sort puts far-future task due dates above
  // this-week's meetings. The user's My Attention then becomes 100%
  // tasks while emails and calendar items fall past position 200 and
  // never reach triage.
  //
  // Quotas (must sum to MAX_CANDIDATES):
  //   email + whatsapp + chat   = 100  (priority lane)
  //   calendar                  =  50
  //   tasks                     =  50
  //
  // Each channel runs its own SQL fetch so per-channel ordering
  // (newest createdAt for each) decides what survives. Then we
  // merge and triage.
  // Quotas raised again per user feedback ("still seeing many emails
  // not reflecting at Day Brief"). Was 60/30/30 = 120 candidates;
  // user has 70+ unread emails this week so the quota was capping
  // visibility before triage even ran. New 200/50/50 = 300 total.
  // First-load cost climbs from ~6s back toward ~12s, but the
  // triage cache makes repeats free, and Day Brief now reflects the
  // user's actual inbox volume instead of an artificial ceiling.
  const QUOTA_EMAIL_LIKE = 200;
  const QUOTA_CALENDAR = 50;
  const QUOTA_TASKS = 50;
  const [emailRows, calRows, taskRows] = await Promise.all([
    prisma.feedEvent.findMany({
      where: {
        clientNumber, userId,
        sourceType: { in: ['gmail', 'whatsapp', 'gchat'] as any },
        createdAt: { gte: ninetyDaysAgo },
      } as any,
      select: { id: true, clientNumber: true, userId: true, sourceType: true, senderEmail: true, senderName: true, rawPayload: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: QUOTA_EMAIL_LIKE * 3,  // over-fetch, post-filter trims
    }),
    prisma.feedEvent.findMany({
      where: {
        clientNumber, userId,
        sourceType: 'gcal' as any,
        createdAt: { gte: ninetyDaysAgo },
      } as any,
      select: { id: true, clientNumber: true, userId: true, sourceType: true, senderEmail: true, senderName: true, rawPayload: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: QUOTA_CALENDAR * 3,
    }),
    prisma.feedEvent.findMany({
      where: {
        clientNumber, userId,
        sourceType: 'gtasks' as any,
        createdAt: { gte: ninetyDaysAgo },
      } as any,
      select: { id: true, clientNumber: true, userId: true, sourceType: true, senderEmail: true, senderName: true, rawPayload: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: QUOTA_TASKS * 3,
    }),
  ]);

  // Drop events whose dedup_hash has been hidden by this user.
  const hashes = new Set<string>();
  const hidden = await prisma.patternHidden.findMany({
    where: { clientNumber, userId, source: 'decision' },
    select: { dedupHash: true },
  });
  hidden.forEach((h) => hashes.add(h.dedupHash));

  // Per-channel filter+sort+slice. Each channel applies the same
  // rules but to its own bucket so a busy channel can't crowd out
  // the others.
  //
  // Importantly: we do NOT skip emails just because the user read
  // them in Gmail. Per user instruction (2026-05-07): "Triage will
  // not skip any email which handled outside of Brain. It should
  // see how it is handled inside Brain." Reading an email in Gmail
  // is not a Brain action — the user may still want to delegate /
  // add to open items / etc. via Day Brief. Items leave Attention
  // ONLY when the user takes a Brain action (decision_log entry)
  // or Brain auto-classifies them (handledByRule / noise / autonomy).
  // The Gmail read-state sync still runs (rawPayload.isUnread is
  // populated) so triage and the cards have read-state context, but
  // it doesn't gate visibility.
  function pickFromBucket(bucket: typeof emailRows, quota: number) {
    return bucket
      .filter((r) => !decidedSet.has(r.id))
      // Suppress feed_events for Gmail threads the user has already
      // replied on, by ANY means — Brain's draft button OR Gmail compose
      // directly OR mobile app. The userRepliedThread flag is stamped
      // by gmailReadStateSyncJob from `q=in:sent` results, which is the
      // ground truth regardless of which client sent the reply.
      // The legacy repliedThreadIds Set (built from decision_logs) is
      // kept as a redundant secondary check in case the read-state sync
      // hasn't run yet for a brand-new draft.
      .filter((r) => {
        if (r.sourceType !== 'gmail') return true;
        const payload = r.rawPayload as any;
        if (payload?.userRepliedThread === true) return false;
        const tid = payload?.threadId;
        return !tid || !repliedThreadIds.has(tid);
      })
      .map((r) => ({ row: r, eventDate: extractEventOccurredAt(r) }))
      .filter((x) => x.eventDate >= sevenDaysAgo)
      .sort((a, b) => b.eventDate.getTime() - a.eventDate.getTime())
      .slice(0, quota)
      .map((x) => x.row);
  }
  const emailCandidates = pickFromBucket(emailRows, QUOTA_EMAIL_LIKE);
  const calCandidates = pickFromBucket(calRows, QUOTA_CALENDAR);
  const taskCandidates = pickFromBucket(taskRows, QUOTA_TASKS);
  const candidates = [...emailCandidates, ...calCandidates, ...taskCandidates];

  // Run suggestForFeedEvent in PARALLEL across candidates — but in
  // batches to keep memory bounded. With wide windows + heavy
  // payloads, unbounded Promise.all OOMs the V8 heap; batching
  // 25-at-a-time keeps the working set small while preserving most
  // of the parallelism benefit.
  const BATCH_SIZE = 25;
  const suggestions: Array<AttentionItem | null> = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map((r) =>
      suggestForFeedEvent({
        id: r.id,
        clientNumber: r.clientNumber,
        userId: r.userId ?? userId,
        sourceType: r.sourceType,
        senderEmail: r.senderEmail,
        senderName: r.senderName,
        rawPayload: r.rawPayload as Record<string, unknown> | null,
        createdAt: r.createdAt,
      }).catch(() => null as AttentionItem | null),
    ));
    suggestions.push(...batchResults);
  }

  const items: AttentionItem[] = [];
  for (const item of suggestions) {
    if (!item) continue;
    if (hashes.has(item.dedupHash)) continue;
    if (item.handledByRule) continue;  // autonomous — lives in Section 1, not Attention
    items.push(item);
  }

  // ── Recurring meeting series collapse ──
  // A weekly cadence ("Project MATRIX Weekly Governance Meeting") arrives
  // as N separate calendar invites — one per occurrence — each producing
  // its own attention card. The user just sees the same decision N times.
  // Collapse: group meetings by (organizer, normalised subject) and keep
  // only the EARLIEST upcoming occurrence; attach `seriesCount` so the UI
  // can render "3 occurrences" + "delegate the whole series" affordance.
  const collapsedItems: AttentionItem[] = [];
  const seriesMap = new Map<string, AttentionItem[]>();
  for (const it of items) {
    if (it.itemType !== 'meeting') {
      collapsedItems.push(it);
      continue;
    }
    const subjectKey = (it.subject || '').toLowerCase()
      .replace(/[\s\-_/.]+/g, ' ')
      .replace(/\b(weekly|biweekly|bi-weekly|monthly|daily)\b/g, '')
      .trim();
    const organiser = (it.fromEmail || it.from || '').toLowerCase();
    const seriesKey = `${organiser}::${subjectKey}`;
    if (!seriesMap.has(seriesKey)) seriesMap.set(seriesKey, []);
    seriesMap.get(seriesKey)!.push(it);
  }
  for (const occurrences of seriesMap.values()) {
    if (occurrences.length === 1) {
      collapsedItems.push(occurrences[0]);
      continue;
    }
    // Pick the earliest upcoming occurrence as the representative.
    occurrences.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
    const representative = occurrences[0];
    (representative as any).seriesCount = occurrences.length;
    (representative as any).seriesOccurrenceIds = occurrences.map((o) => o.feedEventId);
    representative.rationale = `${representative.rationale}\nThis is occurrence 1 of ${occurrences.length} in the series — accepting/delegating applies to all.`;
    collapsedItems.push(representative);
  }
  items.length = 0;
  items.push(...collapsedItems);

  // ── CC suppression ──
  // Emails where the user is on CC (not To/Bcc) drop OFF My Attention by
  // default. Most CC mail is FYI/informational and crowds the actionable
  // list. They still live in the archive — Brief accountability + search
  // surface them — but we don't ask the user to decide on them.
  //
  // Override (keep on My Attention): the criticality engine already
  // factors sentiment, urgency, escalation keywords, owner/escalation
  // matrix matches, and tempo anomalies. If those signals are loud
  // enough to push band → 'high' or 'critical', or fire any of the three
  // superpowers (absence / cross-source / decay), the CC is meaningful
  // and stays. Senders the user has explicitly starred (3+) also stay —
  // user has flagged the relationship as worth the interruption.
  //
  // This implements the rule: "User receives only To-addressed emails in
  // My Attention; CC emails only when something critical (escalation,
  // sentiment, resignation, etc.) — Brain decides."
  const ccFiltered = items.filter((it) => {
    if (it.itemType !== 'email') return true;
    if (it.addressing !== 'cc') return true;
    if (it.critical) return true;
    const band = it.criticality?.band;
    if (band === 'high' || band === 'critical') return true;
    const sp = it.criticality?.superpowers;
    if (sp?.absence || sp?.crossSource || sp?.decay) return true;
    if ((it.senderStars ?? 0) >= 3) return true;
    return false;
  });
  items.length = 0;
  items.push(...ccFiltered);

  // ── Autonomy gate ──
  // Brain's historyDrivenSuggestion can return ≥0.85 confidence with N
  // prior matching delegations. At that point, surfacing the card again
  // is noise — Brain already knows what to do. Drop it from My Attention
  // and let the autonomous shadow rule pipeline pick it up. We don't
  // execute the action here (that's the executor's job); we just stop
  // bothering the user with a decision they've made dozens of times.
  // Delegation needs an actual delegate (no point auto-handling if we
  // don't know who to send it to).
  const AUTONOMY_THRESHOLD = 0.85;
  const autonomousFiltered = items.filter((it) => {
    if (it.critical) return true; // never auto-hide criticals
    const isAutonomyReady =
      (it.confidence ?? 0) >= AUTONOMY_THRESHOLD
      && it.suggestedAction === 'delegate'
      && !!it.suggestedDelegateeUserId;
    return !isAutonomyReady;
  });
  items.length = 0;
  items.push(...autonomousFiltered);

  // Trim to limit AFTER collapse + autonomy filter so we surface the
  // most useful `limit` decisions, not the first N pre-collapse items.
  if (items.length > limit) items.length = limit;

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

// ─────────────────────────────────────────────────────────────────
// Day Brief — "100% accountability" model
// ─────────────────────────────────────────────────────────────────
//
// The user's principle: every inbox item (email, WhatsApp, task, calendar,
// chat) within the Day Brief window must be visible somewhere — either in
// "My Attention" (Brain wants the user to decide) OR in "Brief" (Brain
// handled it autonomously). No silent drops.
//
// buildAttentionList already returns the "My Attention" half. This pair —
// HandledItem + buildHandledList — returns the "Brief" half: items that
// Brain triaged but chose NOT to surface. Each is tagged with a bucket so
// the UI can render a one-line summary explaining what Brain decided and
// why.
//
// Bucket meanings:
//   'auto_rule'           — A user-defined action rule fired (handledByRule=true).
//                           Reason: "Rule '<name>' fired".
//   'auto_noise'          — Triage classified as bulk/newsletter/marketing.
//                           Reason: "Bulk / no-reply / newsletter — auto-ignored".
//   'auto_self'           — Sender is the user themselves (own outbound).
//                           Reason: "You sent this — not surfaced".
//   'auto_high_confidence'— Brain saw a strong delegation history pattern and
//                           the autonomy gate suppressed it. Reason mentions
//                           the delegate count + delegatee name.
//   'auto_decided'        — User already terminally decided on this item.
//                           Reason: "You've already <decided>".
//   'auto_cc_only'        — Email where you're on CC, not To. Suppressed
//                           from My Attention as FYI; criticality engine
//                           did not flag it as escalation/sentiment/
//                           pattern-anomaly. Still searchable in Brief.
//
// User-scoped: every query filters by clientNumber + userId, identical to
// buildAttentionList. No tenant or per-user data crosses this boundary.

/**
 * Top-level grouping of buckets per the user's 2026-05-07 spec:
 *   "Brief should inform what Nexeo did by itself or what user did and when."
 *
 * - 'nexeo_handled' = Brain or rule chose the disposition without you
 *   touching it (auto_rule, auto_high_confidence, auto_noise,
 *   auto_cc_only, auto_self).
 * - 'you_handled'   = you took the action on this item (auto_decided —
 *   replied / delegated / snoozed / dismissed).
 */
export type HandledCategory = 'nexeo_handled' | 'you_handled';

export interface HandledItem {
  feedEventId: string;
  bucket: 'auto_rule' | 'auto_noise' | 'auto_self' | 'auto_high_confidence' | 'auto_decided' | 'auto_cc_only';
  /** Two-way roll-up so the UI can show "Nexeo handled" vs "You handled" tabs. */
  category: HandledCategory;
  reason: string;
  itemType: ItemType;
  sourceType: string;
  from: string;
  fromDisplay: string;
  fromEmail: string | null;
  subject: string;
  preview: string;
  receivedAt: string;
  /** When the disposition was made (decision_log.createdAt for user
   *  actions; falls back to receivedAt when Brain made a passive call
   *  like noise/cc-only). The UI shows this as the "when" timestamp
   *  on the audit trail. */
  decidedAt: string;
  archetype: Archetype;
  /** What Brain WOULD have suggested if it had to ask the user. Empty for
   *  rule-handled items (the rule defines the action). */
  intendedAction?: SuggestedAction;
  /** Filled when bucket = 'auto_high_confidence' so the UI can show the
   *  delegate name. */
  delegateeName?: string;
  delegateeEmail?: string;
  /** Filled when bucket = 'auto_rule' so the UI can show which rule fired. */
  ruleName?: string;
}

/**
 * Return all items Brain handled without bothering the user, within the
 * Day Brief window (last 7 days, source-native timestamp). Mirrors the
 * buildAttentionList query so the math accounts for every feed event:
 *
 *   buildAttentionList(...).length + buildHandledList(...).length
 *     = (items in window not yet aged out)
 *
 * Same per-event triage cost as buildAttentionList — we share nothing
 * today. If the duplication shows up as a perf cost, we'll merge into a
 * single buildDayBriefSlate() that returns both lists.
 */
export async function buildHandledList(
  clientNumber: string,
  userId: number,
  limit = 50,
): Promise<HandledItem[]> {
  // Brief shows the audit trail of the last 7 days — what Nexeo handled
  // and what you handled, with timestamps. Older handled work lives in
  // Wiki, searchable. Tighter than My Attention's 30-day unattended
  // window so the audit feels current without drowning in old activity.
  const BRIEF_WINDOW_DAYS = Math.max(1, Math.min(30, parseInt(process.env.BRIEF_WINDOW_DAYS ?? '7', 10) || 7));
  const sevenDaysAgo = new Date(Date.now() - BRIEF_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // Pull terminal decisions so we can show them under their own bucket
  // ('auto_decided'). Same set buildAttentionList uses to suppress.
  // We also capture the decision timestamp so Brief can show "you
  // delegated this on Mon 5 May, 2:30 PM" — the audit trail the user
  // explicitly asked for: "Brief should also inform what Nexeo did by
  // itself or what user did and when (date & time)."
  const TERMINAL_DECISIONS = ['approved', 'delegated', 'snoozed', 'dismissed', 'overrode'];
  const decisionRows = await prisma.decisionLog.findMany({
    where: {
      clientNumber, userId,
      createdAt: { gte: sevenDaysAgo },
      entityId: { not: null } as any,
      userDecision: { in: TERMINAL_DECISIONS } as any,
    } as any,
    select: { entityId: true, userDecision: true, createdAt: true },
  }).catch(() => [] as Array<{ entityId: string | null; userDecision: string; createdAt: Date }>);
  const decidedMap = new Map<string, { decision: string; at: Date }>();
  for (const r of decisionRows) {
    if (r.entityId) decidedMap.set(r.entityId, { decision: r.userDecision, at: r.createdAt });
  }

  // Mirror buildAttentionList's thread-replied set so a feed_event
  // for a thread the user has already replied on lands in Brief
  // 'auto_decided' bucket instead of vanishing entirely. Keeps the
  // attention.length + handled.length accounting honest.
  const replyWindowAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const repliedRows = await prisma.decisionLog.findMany({
    where: {
      clientNumber, userId,
      createdAt: { gte: replyWindowAgo },
      actionTaken: 'reply_sent',
      entityId: { not: null } as any,
    } as any,
    select: { entityId: true },
  }).catch(() => [] as Array<{ entityId: string | null }>);
  const repliedFeIds = repliedRows.map((r) => r.entityId).filter(Boolean) as string[];
  const repliedThreadIds = new Set<string>();
  if (repliedFeIds.length > 0) {
    const repliedFeeds = await prisma.feedEvent.findMany({
      where: { id: { in: repliedFeIds }, clientNumber, sourceType: 'gmail' },
      select: { rawPayload: true },
    }).catch(() => [] as Array<{ rawPayload: any }>);
    for (const f of repliedFeeds) {
      const tid = (f.rawPayload as any)?.threadId;
      if (typeof tid === 'string' && tid) repliedThreadIds.add(tid);
    }
  }

  // Per-channel quotas matching buildAttentionList — keeps the
  // handled list balanced across channels for the same reason.
  const QUOTA_EMAIL_LIKE = 200;
  const QUOTA_CALENDAR = 50;
  const QUOTA_TASKS = 50;
  const [emailRows, calRows, taskRows] = await Promise.all([
    prisma.feedEvent.findMany({
      where: {
        clientNumber, userId,
        sourceType: { in: ['gmail', 'whatsapp', 'gchat'] as any },
        createdAt: { gte: ninetyDaysAgo },
      } as any,
      select: { id: true, clientNumber: true, userId: true, sourceType: true, senderEmail: true, senderName: true, rawPayload: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: QUOTA_EMAIL_LIKE * 3,
    }),
    prisma.feedEvent.findMany({
      where: {
        clientNumber, userId,
        sourceType: 'gcal' as any,
        createdAt: { gte: ninetyDaysAgo },
      } as any,
      select: { id: true, clientNumber: true, userId: true, sourceType: true, senderEmail: true, senderName: true, rawPayload: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: QUOTA_CALENDAR * 3,
    }),
    prisma.feedEvent.findMany({
      where: {
        clientNumber, userId,
        sourceType: 'gtasks' as any,
        createdAt: { gte: ninetyDaysAgo },
      } as any,
      select: { id: true, clientNumber: true, userId: true, sourceType: true, senderEmail: true, senderName: true, rawPayload: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: QUOTA_TASKS * 3,
    }),
  ]);

  function pickFromBucket(bucket: typeof emailRows, quota: number) {
    return bucket
      .map((r) => ({ row: r, eventDate: extractEventOccurredAt(r) }))
      .filter((x) => x.eventDate >= sevenDaysAgo)
      .sort((a, b) => b.eventDate.getTime() - a.eventDate.getTime())
      .slice(0, quota)
      .map((x) => x.row);
  }
  const candidates = [
    ...pickFromBucket(emailRows, QUOTA_EMAIL_LIKE),
    ...pickFromBucket(calRows, QUOTA_CALENDAR),
    ...pickFromBucket(taskRows, QUOTA_TASKS),
  ];

  // Batched triage — keeps memory bounded even for wide windows.
  const HANDLED_BATCH_SIZE = 25;
  const suggestions: Array<AttentionItem | null> = [];
  for (let i = 0; i < candidates.length; i += HANDLED_BATCH_SIZE) {
    const batch = candidates.slice(i, i + HANDLED_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map((r) =>
      suggestForFeedEvent({
        id: r.id,
        clientNumber: r.clientNumber,
        userId: r.userId ?? userId,
        sourceType: r.sourceType,
        senderEmail: r.senderEmail,
        senderName: r.senderName,
        rawPayload: r.rawPayload as Record<string, unknown> | null,
        createdAt: r.createdAt,
      }).catch(() => null as AttentionItem | null),
    ));
    suggestions.push(...batchResults);
  }

  // Hidden-pattern set — these were already silently dropped by Brain's
  // pattern memory (user clicked "Hide pattern" once, every matching
  // item is suppressed). Surfacing them in Brief honours the "no silent
  // drops" rule: user sees Brain is hiding 12 newsletters from sender X
  // instead of those just disappearing.
  const hiddenHashes = new Set<string>();
  const hidden = await prisma.patternHidden.findMany({
    where: { clientNumber, userId, source: 'decision' },
    select: { dedupHash: true },
  }).catch(() => [] as Array<{ dedupHash: string }>);
  hidden.forEach((h) => hiddenHashes.add(h.dedupHash));

  const out: HandledItem[] = [];
  const AUTONOMY_THRESHOLD = 0.85;

  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i];
    const item = suggestions[i];
    const decided = decidedMap.get(r.id);

    // Common projection — keep this aligned with the AttentionItem shape
    // so the client can render either bucket from one component.
    const base = (it: any) => ({
      feedEventId: r.id,
      itemType: (it?.itemType as ItemType) ?? (r.sourceType === 'gmail' ? 'email' : r.sourceType === 'gcal' ? 'meeting' : r.sourceType === 'whatsapp' ? 'whatsapp' : 'task') as ItemType,
      sourceType: r.sourceType,
      from: it?.from ?? r.senderName ?? r.senderEmail ?? '',
      fromDisplay: it?.fromDisplay ?? r.senderName ?? r.senderEmail ?? '',
      fromEmail: r.senderEmail ?? null,
      subject: it?.subject ?? '',
      preview: it?.preview ?? '',
      // Use the source-native event date, not feed_events.createdAt
      // (which is ingestion time and lies for backfilled/scribed
      // historical pulls — the user saw a 14 April email tagged "4d
      // ago" because the row was inserted 4 days ago).
      receivedAt: extractEventOccurredAt(r).toISOString(),
      archetype: (it?.archetype as Archetype) ?? 'inform_only',
    });

    // Order matters — first match wins so a single item lands in exactly
    // one bucket. 'auto_decided' takes precedence (user-driven), then
    // rule, self, noise, autonomy.
    if (decided) {
      out.push({
        ...base(item),
        bucket: 'auto_decided',
        category: 'you_handled',
        decidedAt: decided.at.toISOString(),
        reason: `You ${decided.decision} this`,
      });
      continue;
    }

    // Same-thread-replied: a different feed_event but the same Gmail
    // thread the user has already responded to. Bucket as auto_decided
    // so the user sees "Brain knew you'd already replied" instead of a
    // re-ask card or silent disappearance. Two signals — userRepliedThread
    // flag (from in:sent sync, the ground truth) and decision_log lookup
    // (legacy fallback for very fresh drafts).
    if (r.sourceType === 'gmail') {
      const payload = r.rawPayload as any;
      const tid = payload?.threadId;
      if (payload?.userRepliedThread === true || (tid && repliedThreadIds.has(tid))) {
        out.push({
          ...base(item),
          bucket: 'auto_decided',
          category: 'you_handled',
          // No precise decidedAt for off-Brain replies — fall back to
          // when the inbound arrived (the message we're suppressing).
          // The Sent-folder sync that set userRepliedThread doesn't
          // capture per-thread reply timestamps yet.
          decidedAt: extractEventOccurredAt(r).toISOString(),
          reason: 'You already replied on this thread',
        });
        continue;
      }
    }

    if (!item) continue; // triage threw — leave for the diagnostic, not Brief

    if (hiddenHashes.has(item.dedupHash)) {
      out.push({
        ...base(item),
        bucket: 'auto_noise',
        category: 'nexeo_handled',
        decidedAt: extractEventOccurredAt(r).toISOString(),
        reason: 'Pattern you hid — auto-suppressed',
        intendedAction: item.suggestedAction,
      });
      continue;
    }

    if (item.handledByRule) {
      const rule = item.suggestedRules?.[0];
      out.push({
        ...base(item),
        bucket: 'auto_rule',
        category: 'nexeo_handled',
        decidedAt: extractEventOccurredAt(r).toISOString(),
        reason: rule ? `Rule '${rule.name}' fired` : 'Auto-handled by a rule',
        intendedAction: item.suggestedAction,
        ruleName: rule?.name,
      });
      continue;
    }

    if (item.noise) {
      out.push({
        ...base(item),
        bucket: 'auto_noise',
        category: 'nexeo_handled',
        decidedAt: extractEventOccurredAt(r).toISOString(),
        reason: 'Bulk / no-reply / newsletter — auto-ignored',
        intendedAction: item.suggestedAction,
      });
      continue;
    }

    // Self-message gate — sender = user. The triage suggester returns
    // these with noise=true already, so the noise branch above usually
    // catches them. Keep this branch as a safety net for non-noise
    // self-messages (e.g. you @-mentioned yourself in WhatsApp).
    const isSelf = !!item.fromEmail && (item as any).senderIsSelf === true;
    if (isSelf) {
      out.push({
        ...base(item),
        bucket: 'auto_self',
        // You did this — outbound from your account.
        category: 'you_handled',
        decidedAt: extractEventOccurredAt(r).toISOString(),
        reason: 'You sent this — not surfaced',
        intendedAction: item.suggestedAction,
      });
      continue;
    }

    // CC suppression — mirrors the filter in buildAttentionList so an
    // item dropped there is still accounted for here. Same override
    // conditions: criticality band high/critical, any superpower
    // triggered, ★3+ sender, or LLM-flagged critical → not suppressed.
    if (item.itemType === 'email' && item.addressing === 'cc' && !item.critical) {
      const band = item.criticality?.band;
      const sp = item.criticality?.superpowers;
      const overridden =
        band === 'high' || band === 'critical'
        || sp?.absence || sp?.crossSource || sp?.decay
        || (item.senderStars ?? 0) >= 3;
      if (!overridden) {
        out.push({
          ...base(item),
          bucket: 'auto_cc_only',
          category: 'nexeo_handled',
          decidedAt: extractEventOccurredAt(r).toISOString(),
          reason: 'You were on CC — Brain didn’t see escalation, sentiment, or pattern anomaly worth surfacing',
          intendedAction: item.suggestedAction,
        });
        continue;
      }
    }

    // Autonomy gate — high-confidence delegations. Mirrors the filter in
    // buildAttentionList so an item caught there is accounted for here.
    const isAutonomyReady =
      (item.confidence ?? 0) >= AUTONOMY_THRESHOLD
      && item.suggestedAction === 'delegate'
      && !!item.suggestedDelegateeUserId
      && !item.critical;
    if (isAutonomyReady) {
      const dn = item.suggestedDelegateeName ?? item.suggestedDelegateeEmail ?? 'a teammate';
      out.push({
        ...base(item),
        bucket: 'auto_high_confidence',
        category: 'nexeo_handled',
        decidedAt: extractEventOccurredAt(r).toISOString(),
        reason: `Brain knows to delegate this to ${dn} — based on your past pattern`,
        intendedAction: 'delegate',
        delegateeName: item.suggestedDelegateeName,
        delegateeEmail: item.suggestedDelegateeEmail,
      });
      continue;
    }

    // Anything else — this item DID make it to My Attention. Don't
    // double-count by including it here.
  }

  // Newest first, capped at the limit. Bucketed counts are computed
  // client-side from this array.
  out.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
  return out.slice(0, limit);
}
