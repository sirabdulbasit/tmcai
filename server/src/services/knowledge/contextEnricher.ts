/**
 * MyOS — Context Enricher.
 *
 * Before Brain suggests what to do with a new feed event, it needs to
 * already know the background: who the sender is, what Brain knows about
 * them from the Wiki, how the MD has historically handled them, what
 * Open Items already track their work, and what delegations are live.
 *
 * gatherSenderContext() returns the full background in one shot so
 * triageSuggester can reason with it. Consumers should treat it as a
 * best-effort enrichment — any individual lookup can fail silently.
 *
 * Caching: none yet. Each triage call makes ~5 small queries that all hit
 * indexed columns. If hot-path latency becomes a concern, add a 60s LRU
 * keyed on (userId, senderEmail).
 */
import prisma from '../../db/prisma';

export interface EntityBrief {
  id: string;
  name: string;
  entityType: string;
  company: string | null;
  role: string | null;
  relationshipStrength: number | null;
  lastInteraction: Date | null;
}

export interface DecisionSummary {
  action: string;
  count: number;
  lastAt: Date;
}

export interface DelegationSummary {
  to: string;
  count: number;
  lastAt: Date;
}

export interface RelatedOpenItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  updatedAt: Date;
}

export interface SenderContext {
  entity: EntityBrief | null;
  /** Aggregated MD decisions for this exact sender in last 90 days */
  decisions: DecisionSummary[];
  /** Who MD has historically delegated this sender's work to */
  delegations: DelegationSummary[];
  /** OpenItems that are already tracking this sender's work */
  relatedOpenItems: RelatedOpenItem[];
  /** First 300 chars of the entity wiki page, if one exists — compact summary
   *  suitable for an LLM to consume without bloating the prompt. */
  wikiSnippet: string | null;
  /** Full message history from this sender in last 90 days — titles, dates,
   *  source. Lets Brain see "how long has this conversation been going" and
   *  reason about recency (first-contact vs long-running). */
  senderHistory: Array<{
    subject: string;
    sourceType: string;
    receivedAt: Date;
    feedEventId: string;
  }>;
  /** The most recent thread/conversation for this exact message — last 6
   *  messages in the same Gmail thread or WhatsApp chat. Already populated
   *  at WhatsApp ingest; Gmail is fetched on-demand here via threadId. */
  threadContext: Array<{
    from: 'me' | 'them';
    text: string;
    timestamp: number;
  }>;
  /** Stats for fast classifier heuristics without opening each list */
  stats: {
    totalDecisions: number;
    totalDelegations: number;
    dominantAction: string | null;
    dominantDelegatee: string | null;
    isKnownContact: boolean;
    /** How many messages exchanged with this sender in 90d */
    interactionCount: number;
    /** Is this the first time MD has ever interacted with this sender? */
    firstContact: boolean;
  };
}

/** Lightweight cross-cut brief — ~20 tokens — that the UI shows as a
 *  human-readable "Brain knows..." line under the attention card. */
export function summariseContext(ctx: SenderContext): string | null {
  const bits: string[] = [];
  if (ctx.entity) {
    const pieces: string[] = [];
    if (ctx.entity.company) pieces.push(ctx.entity.company);
    if (ctx.entity.role) pieces.push(ctx.entity.role);
    if (pieces.length > 0) bits.push(pieces.join(', '));
  }
  if (ctx.stats.firstContact) {
    bits.push('first contact');
  } else if (ctx.stats.interactionCount > 0) {
    bits.push(`${ctx.stats.interactionCount} message${ctx.stats.interactionCount > 1 ? 's' : ''} in last 90 days`);
  }
  if (ctx.stats.dominantDelegatee && ctx.stats.totalDelegations >= 2) {
    bits.push(`usually delegated to ${ctx.stats.dominantDelegatee}`);
  } else if (ctx.stats.dominantAction && ctx.stats.totalDecisions >= 3) {
    const verb = ({ dismissed: 'archived', approved: 'replied to', snoozed: 'opened as item', delegated: 'delegated' } as any)[ctx.stats.dominantAction] ?? ctx.stats.dominantAction;
    bits.push(`${verb} ${ctx.stats.totalDecisions}× before`);
  }
  if (ctx.relatedOpenItems.length > 0) {
    bits.push(`${ctx.relatedOpenItems.length} open item${ctx.relatedOpenItems.length > 1 ? 's' : ''} tracking this`);
  }
  if (ctx.threadContext.length > 0) {
    bits.push(`${ctx.threadContext.length}-turn thread`);
  }
  return bits.length > 0 ? bits.join(' · ') : null;
}

// 30-second in-memory cache. Triage for one Day Brief load might hit the
// same sender in multiple events; page refreshes within the same minute
// shouldn't re-query the Wiki + decision_logs from scratch. Keyed on
// (userId, senderEmail) — threadContextSeed is passed through untouched
// so caching a row doesn't flatten per-event conversation state.
interface CachedContext { ctx: SenderContext; fetchedAt: number }
const ctxCache = new Map<string, CachedContext>();
const CTX_TTL_MS = 30_000;

/**
 * Gather full background for an incoming feed event from `senderEmail`.
 * Every query is best-effort — if Wiki layer isn't populated yet, returns
 * empty context and caller still gets a working attention item.
 */
export async function gatherSenderContext(params: {
  clientNumber: string;
  userId: number;
  senderEmail: string | null;
  /** WhatsApp/SMS/phone-based senders have no email — pass senderPhone
   *  so the history lookup can match by either identifier. Without this
   *  the function would return firstContact=true for every WhatsApp
   *  contact regardless of how many messages exist (the bug Basit hit
   *  on 2026-05-14: Abdul Haseeb's 11-message thread showing as
   *  "first contact" because the senderHistory query only matched
   *  senderEmail). */
  senderPhone?: string | null;
  /** Optional: a Gmail threadId or WhatsApp chatId — if provided, thread
   *  context will be fetched even when the current event didn't carry it. */
  threadId?: string | null;
  /** Optional: thread context already supplied by the ingest path
   *  (whatsapp_personal enriches this at ingest). Skips re-fetch. */
  threadContextSeed?: Array<{ from: 'me' | 'them'; text: string; timestamp: number }>;
  /** Optional: the current feed event's source type, used to decide how
   *  to fetch thread context (gmail thread vs whatsapp chat). */
  sourceType?: string;
}): Promise<SenderContext> {
  const empty: SenderContext = {
    entity: null,
    decisions: [],
    delegations: [],
    relatedOpenItems: [],
    wikiSnippet: null,
    senderHistory: [],
    threadContext: [],
    stats: {
      totalDecisions: 0,
      totalDelegations: 0,
      dominantAction: null,
      dominantDelegatee: null,
      isKnownContact: false,
      interactionCount: 0,
      firstContact: true,
    },
  };
  const { clientNumber, userId, senderEmail, senderPhone, threadContextSeed } = params;
  // Need at least one identifier to look anything up. Email was the
  // only original key — now phone is accepted too.
  if (!senderEmail && !senderPhone) return empty;

  // Cache hit — threadContextSeed is swapped in fresh so the cached shell
  // reflects the CURRENT event's conversation state, not a stale one.
  const cacheKeyId = senderEmail ? senderEmail.toLowerCase() : `phone:${(senderPhone ?? '').replace(/[^\d+]/g, '')}`;
  const cacheKey = `${clientNumber}:${userId}:${cacheKeyId}`;
  const cached = ctxCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CTX_TTL_MS) {
    if (threadContextSeed && threadContextSeed.length > 0) {
      return { ...cached.ctx, threadContext: threadContextSeed };
    }
    return cached.ctx;
  }

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // ── 1. Entity lookup — Wiki knows this person? ──
  const entity = await prisma.entity.findFirst({
    where: {
      clientNumber,
      email: { equals: senderEmail, mode: 'insensitive' },
    } as any,
    select: { id: true, name: true, entityType: true, company: true, role: true, relationshipStrength: true, lastInteraction: true },
  }).catch(() => null);

  // ── 2. MD's decision history on this exact sender ──
  const decisionRows = await prisma.$queryRawUnsafe<Array<{ action: string; n: number; last_at: Date }>>(
    `SELECT dl.user_decision AS action, COUNT(*)::int AS n, MAX(dl.created_at) AS last_at
     FROM decision_logs dl
     LEFT JOIN feed_events fe ON fe.id = dl.entity_id
     WHERE dl.client_number = $1 AND dl.user_id = $2 AND dl.created_at >= $3
       AND fe.sender_email = $4
     GROUP BY dl.user_decision
     ORDER BY n DESC LIMIT 5`,
    clientNumber, userId, since, senderEmail,
  ).catch(() => [] as any[]);

  const decisions: DecisionSummary[] = decisionRows.map((r) => ({
    action: r.action,
    count: Number(r.n),
    lastAt: new Date(r.last_at),
  }));

  // ── 3. Who MD has delegated this sender's work to ──
  const delegationRows = await prisma.$queryRawUnsafe<Array<{ name: string | null; email: string | null; n: number; last_at: Date }>>(
    `SELECT dg.delegatee_name AS name, dg.delegatee_email AS email, COUNT(*)::int AS n, MAX(dg.created_at) AS last_at
     FROM delegation_logs dg
     WHERE dg.client_number = $1 AND dg.user_id = $2 AND dg.created_at >= $3
       AND dg.sender_email = $4
       AND dg.delegated_by = 'user'
     GROUP BY dg.delegatee_name, dg.delegatee_email
     ORDER BY n DESC LIMIT 5`,
    clientNumber, userId, since, senderEmail,
  ).catch(() => [] as any[]);

  const delegations: DelegationSummary[] = delegationRows.map((r) => ({
    to: r.name ?? r.email ?? 'someone',
    count: Number(r.n),
    lastAt: new Date(r.last_at),
  }));

  // ── 4. Active OpenItems related to this sender ──
  const relatedOpenItems = await prisma.openItem.findMany({
    where: {
      clientNumber,
      userId,
      status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'WAITING_INFO', 'DELEGATED'] as any },
      OR: [
        { delegateeEmail: { equals: senderEmail, mode: 'insensitive' } } as any,
        { description: { contains: senderEmail, mode: 'insensitive' } } as any,
      ],
    } as any,
    select: { id: true, title: true, status: true, priority: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
    take: 5,
  }).catch(() => [] as any[]);

  // ── 5. Wiki snippets — sender_history + entity page + sender_topic ──
  // Prefer the sender_history page (maintained on every ingest, richer
  // running memory). Fall back to the entity page if no sender_history
  // exists yet. The topic page is pulled by the triage layer using the
  // dedup_hash at suggest-time (not here, since we don't have the hash).
  let wikiSnippet: string | null = null;
  if (senderEmail) {
    try {
      const { getSenderHistoryMarkdown } = await import('./senderWikiService');
      wikiSnippet = await getSenderHistoryMarkdown(clientNumber, userId, senderEmail, 800);
    } catch { /* fall through to entity lookup */ }
  }
  if (!wikiSnippet && entity) {
    const page = await prisma.wikiPage.findFirst({
      where: { clientNumber, userId, pageType: 'entity', title: entity.name } as any,
      select: { bodyMarkdown: true },
    }).catch(() => null);
    if (page?.bodyMarkdown) {
      wikiSnippet = String(page.bodyMarkdown).replace(/\s+/g, ' ').slice(0, 300).trim() || null;
    }
  }

  // ── 6. Full message history from this sender in last 90 days ──
  // Not just decisions — every inbound feed event. Gives Brain the shape
  // of the relationship: new contact vs long-running thread vs sporadic.
  // Match by EITHER senderEmail OR senderPhone — a WhatsApp contact
  // with no email still has months of interactions; matching on email
  // alone made firstContact=true for every WA-only sender, even
  // 11-thread regulars (Abdul Haseeb 2026-05-14).
  const normalizedPhone = senderPhone ? senderPhone.replace(/[^\d+]/g, '') : '';
  const senderHistory = await prisma.feedEvent.findMany({
    where: {
      clientNumber,
      userId,
      createdAt: { gte: since },
      OR: [
        ...(senderEmail ? [{ senderEmail: { equals: senderEmail, mode: 'insensitive' as const } }] : []),
        ...(normalizedPhone ? [{ senderPhone: normalizedPhone }] : []),
      ],
    } as any,
    select: { id: true, rawPayload: true, sourceType: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 25,
  }).catch(() => [] as any[]);

  const senderHistoryBrief = senderHistory.map((fe: any) => {
    const p: any = fe.rawPayload ?? {};
    return {
      subject: String(p.subject ?? p.summary ?? p.title ?? p.body ?? '').slice(0, 120),
      sourceType: fe.sourceType,
      receivedAt: fe.createdAt,
      feedEventId: fe.id,
    };
  });

  // ── 7. Thread context for THIS conversation ──
  // For WhatsApp, the ingest path already grabs 10 turns into
  // rawPayload.threadContext — we pass it through as a seed for free.
  // For Gmail, fetching the thread on-demand from the API is a 200ms+
  // round-trip per email, which murders Day Brief load time when there
  // are 50 attention cards. We SKIP Gmail thread fetch during triage;
  // reply-composition code paths (composeEmail / composeWhatsAppReply)
  // fetch thread context lazily via fetchEmailThreadContext when needed.
  const threadContext: Array<{ from: 'me' | 'them'; text: string; timestamp: number }> =
    (threadContextSeed && threadContextSeed.length > 0) ? threadContextSeed : [];

  // ── Stats roll-up ──
  const totalDecisions = decisions.reduce((s, d) => s + d.count, 0);
  const totalDelegations = delegations.reduce((s, d) => s + d.count, 0);
  const dominantAction = decisions[0]?.action ?? null;
  const dominantDelegatee = delegations[0]?.to ?? null;
  const interactionCount = senderHistoryBrief.length;
  // First contact if no prior feed events AND no entity AND no decisions
  const firstContact = interactionCount <= 1 && !entity && totalDecisions === 0;

  const result: SenderContext = {
    entity,
    decisions,
    delegations,
    relatedOpenItems,
    wikiSnippet,
    senderHistory: senderHistoryBrief,
    threadContext,
    stats: {
      totalDecisions,
      totalDelegations,
      dominantAction,
      dominantDelegatee,
      isKnownContact: !!entity || totalDecisions > 0 || interactionCount > 1,
      interactionCount,
      firstContact,
    },
  };
  ctxCache.set(cacheKey, { ctx: result, fetchedAt: Date.now() });
  return result;
}
