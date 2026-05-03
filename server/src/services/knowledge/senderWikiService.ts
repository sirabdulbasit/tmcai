/**
 * MyOS — Sender & Sender+Topic Wiki pages.
 *
 * On every new feed_event, Brain maintains two compact Wiki pages that
 * serve as the "living memory" of a relationship:
 *
 *   1. sender_history (one per senderEmail)
 *      - What Brain knows about this person overall: recent interactions,
 *        dominant actions, who you delegate their work to, link to the
 *        entity wiki if scribed.
 *
 *   2. sender_topic (one per senderEmail × dedupHash)
 *      - The thread-level memory: what you've discussed with this sender
 *        on this topic, what you've decided before, and when.
 *
 * These pages are stored as markdown in WikiPage.bodyMarkdown. Cheap
 * updates (append a bullet, bump counts) happen on every ingest.
 * LLM-authored summaries re-run on a threshold (every 10 new messages
 * since last summarization, or weekly). Triage reads the markdown body
 * directly — no recompute from feed_events needed.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('sender-wiki');

const LLM_RESUMMARIZE_EVERY_N = 10;

interface UpsertParams {
  clientNumber: string;
  userId: number;
  /** Sender's email (when the source is email). At least one of
   *  senderEmail / senderPhone must be present. */
  senderEmail?: string | null;
  /** Sender's phone (when the source is WhatsApp / SMS). */
  senderPhone?: string | null;
  senderName?: string | null;
  subject?: string | null;
  preview?: string | null;
  dedupHash?: string | null;
  archetype?: string | null;
  sourceType: string;
  feedEventId: string;
  receivedAt: Date;
  /** When true (backfill walk), skip the LLM resummarize trigger. The
   *  backfill orchestrator runs summarization once per sender at the end
   *  instead of per-batch. */
  mode?: 'ingest' | 'backfill';
}

/**
 * Compose a short bullet for the Recent section.
 * Line 1: "- YYYY-MM-DD · source · subject"
 * Line 2 (if preview available): "      <snippet, 280 chars>"
 *
 * Including the Gmail snippet is what lets Brain actually quote from the
 * message in chat instead of saying "I don't have the content". Capped at
 * 280 chars per message so 15 messages stay inside ~5KB of page body.
 */
function bullet(p: UpsertParams): string {
  const date = p.receivedAt.toISOString().slice(0, 10);
  const subj = (p.subject ?? '').slice(0, 120) || '(no subject)';
  const preview = (p.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
  const header = `- ${date} · ${p.sourceType} · ${subj}`;
  return preview ? `${header}\n  > ${preview}` : header;
}

/**
 * Render the page body from stored metadata. Kept deterministic + tiny so
 * we can regenerate without re-querying the DB on every call.
 */
function mergeChannels(prev: unknown, newSource: string | null | undefined): string[] {
  const set = new Set<string>(Array.isArray(prev) ? prev.filter((x): x is string => typeof x === 'string') : []);
  if (typeof newSource === 'string' && newSource.trim()) set.add(newSource.trim());
  return Array.from(set);
}

function renderSenderPage(meta: any): string {
  const name = meta.name ?? meta.senderEmail ?? meta.senderPhone;
  const lines: string[] = [];
  lines.push(`# ${name}`);
  if (meta.email) lines.push(`**Email:** ${meta.email}`);
  if (meta.phone) lines.push(`**Phone / WhatsApp:** ${meta.phone}`);
  if (meta.company) lines.push(`**Company:** ${meta.company}`);
  if (meta.role) lines.push(`**Role:** ${meta.role}`);
  if (Array.isArray(meta.channels) && meta.channels.length > 0) {
    lines.push(`**Channels seen:** ${meta.channels.join(', ')}`);
  }
  if (meta.entityId) lines.push(`**Person ID:** \`${meta.entityId}\` — same person across every channel`);
  lines.push('');
  lines.push(`**Interactions:** ${meta.totalInteractions ?? 0}  `);
  lines.push(`**Last seen:** ${meta.lastSeenAt ?? '—'}  `);
  if (meta.dominantAction) lines.push(`**Usually:** ${meta.dominantAction}  `);
  if (meta.dominantDelegatee) lines.push(`**Delegated to:** ${meta.dominantDelegatee}`);
  lines.push('');
  if (meta.summary) {
    lines.push('## Summary');
    lines.push(meta.summary);
    lines.push('');
  }
  if (meta.recent && meta.recent.length > 0) {
    lines.push('## Recent');
    lines.push(...meta.recent.slice(-10));
    lines.push('');
  }
  return lines.join('\n');
}

function renderTopicPage(meta: any): string {
  const lines: string[] = [];
  lines.push(`# ${meta.senderEmail} · ${meta.topicLabel ?? meta.archetype ?? 'topic'}`);
  lines.push(`**Pattern hash:** \`${meta.dedupHash ?? '—'}\``);
  lines.push(`**Interactions:** ${meta.totalInteractions ?? 0}  `);
  lines.push(`**Last seen:** ${meta.lastSeenAt ?? '—'}  `);
  if (meta.decisionCount) lines.push(`**MD decisions logged:** ${meta.decisionCount}  `);
  if (meta.dominantAction) lines.push(`**Typical action:** ${meta.dominantAction}`);
  lines.push('');
  if (meta.summary) {
    lines.push('## Summary');
    lines.push(meta.summary);
    lines.push('');
  }
  if (meta.recent && meta.recent.length > 0) {
    lines.push('## Recent');
    lines.push(...meta.recent.slice(-6));
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Upsert the sender_history page and, if dedupHash present, the
 * sender_topic page too. Called fire-and-forget from the ingest path.
 */
export async function updateSenderWikiOnIngest(params: UpsertParams): Promise<void> {
  const { clientNumber, userId, senderEmail, senderPhone } = params;
  // We need at least one channel identifier. The page title + metadata
  // use the email when present (backwards-compatible with existing
  // rows), otherwise fall back to the phone number for WhatsApp / SMS.
  const pageKey = (senderEmail ?? senderPhone ?? '').trim();
  if (!pageKey) return;

  const now = new Date();

  // ── Resolve canonical person entity — unifies this sender across
  //    channels. On email → upsert entity by email (bridge to existing
  //    phone-only record if name matches). On WhatsApp → upsert by phone
  //    (bridge to existing email-only record by name).
  const { resolvePersonByEmail, resolvePersonByPhone } = await import('./personIdentityService');
  let entityId: string | null = null;
  if (senderEmail) {
    entityId = await resolvePersonByEmail(senderEmail, {
      clientNumber,
      name: params.senderName ?? null,
    });
  } else if (senderPhone) {
    entityId = await resolvePersonByPhone(senderPhone, {
      clientNumber,
      name: params.senderName ?? null,
    });
  }

  // ── Enrich metadata from the resolved entity (cheap, indexed lookup) ──
  const entity = entityId
    ? await prisma.entity.findUnique({
        where: { id: entityId },
        select: { name: true, company: true, role: true, email: true, phone: true },
      }).catch(() => null)
    : null;

  // ── 1. Sender page ──
  try {
    const existing = await prisma.wikiPage.findFirst({
      where: { clientNumber, userId, pageType: 'sender_history', title: pageKey } as any,
      select: { id: true, metadata: true, bodyMarkdown: true },
    });

    const prevMeta: any = existing?.metadata ?? {};
    const recent: string[] = Array.isArray(prevMeta.recent) ? prevMeta.recent : [];
    recent.push(bullet(params));
    // keep last 15 bullets; drop oldest
    const trimmed = recent.slice(-15);

    const totalInteractions = (prevMeta.totalInteractions ?? 0) + 1;
    const sinceLastSummary = (prevMeta.sinceLastSummary ?? 0) + 1;

    const nextMeta = {
      senderEmail: senderEmail ?? prevMeta.senderEmail ?? null,
      senderPhone: senderPhone ?? prevMeta.senderPhone ?? null,
      email: entity?.email ?? senderEmail ?? prevMeta.email ?? null,
      phone: entity?.phone ?? senderPhone ?? prevMeta.phone ?? null,
      // entityId links every channel for this person together — composer
      // uses it to pull every wiki_page for the same human in one shot.
      entityId: entityId ?? prevMeta.entityId ?? null,
      channels: mergeChannels(prevMeta.channels, params.sourceType),
      name: entity?.name ?? params.senderName ?? prevMeta.name ?? pageKey,
      company: entity?.company ?? prevMeta.company ?? null,
      role: entity?.role ?? prevMeta.role ?? null,
      totalInteractions,
      lastSeenAt: now.toISOString().slice(0, 16).replace('T', ' '),
      recent: trimmed,
      dominantAction: prevMeta.dominantAction ?? null,
      dominantDelegatee: prevMeta.dominantDelegatee ?? null,
      summary: prevMeta.summary ?? null,
      sinceLastSummary,
      lastSummaryAt: prevMeta.lastSummaryAt ?? null,
    };

    const body = renderSenderPage(nextMeta);

    let senderPageId: string;
    if (existing) {
      await prisma.wikiPage.update({
        where: { id: existing.id },
        data: { bodyMarkdown: body, metadata: nextMeta as any, lastUpdatedBy: 'sender_wiki', lastUpdatedAt: now },
      });
      senderPageId = existing.id;
    } else {
      const created = await prisma.wikiPage.create({
        data: {
          clientNumber, userId, pageType: 'sender_history', title: pageKey,
          storage: 'postgres',
          bodyMarkdown: body,
          metadata: nextMeta as any,
          lastUpdatedBy: 'sender_wiki',
          status: 'active',
        } as any,
      });
      senderPageId = created.id;
    }

    // Concept layer — queue a person-concept synthesis (debounced 5 min)
    // so repeated activity from the same person doesn't spam the LLM.
    if (entityId) {
      void (async () => {
        try {
          const { enqueueSynthesis } = await import('./conceptSynthesizerService');
          enqueueSynthesis({ clientNumber, kind: 'person', id: entityId });
        } catch { /* best effort */ }
      })();
    }

    // Semantic retrieval — embed the page fire-and-forget so it becomes
    // findable by vector similarity on the next Brain turn.
    void (async () => {
      try {
        const { embedWikiPage } = await import('./wikiEmbeddingService');
        await embedWikiPage(senderPageId);
      } catch { /* best effort */ }
    })();

    // LLM re-summarization at threshold — fire-and-forget from here.
    // Skipped during backfill walks (orchestrator runs it once per sender
    // after all historical events are folded in).
    if (params.mode !== 'backfill' && sinceLastSummary >= LLM_RESUMMARIZE_EVERY_N && senderEmail) {
      // resummarizeSenderPage is email-scoped today; WA-only senders skip this pass.
      void resummarizeSenderPage(clientNumber, userId, senderEmail).catch((e) =>
        log.warn('sender resummarize failed', { senderEmail, error: e.message }));
    }
  } catch (e: any) {
    log.warn('sender page upsert failed', { pageKey, error: e.message });
  }

  // ── 2. Sender × topic page (dedup_hash keyed) ──
  if (params.dedupHash && params.archetype) {
    try {
      const topicTitle = `${pageKey}::${params.dedupHash.slice(0, 12)}`;
      const existing = await prisma.wikiPage.findFirst({
        where: { clientNumber, userId, pageType: 'sender_topic', title: topicTitle } as any,
        select: { id: true, metadata: true },
      });

      const prevMeta: any = existing?.metadata ?? {};
      const recent: string[] = Array.isArray(prevMeta.recent) ? prevMeta.recent : [];
      recent.push(bullet(params));

      const nextMeta = {
        senderEmail: senderEmail ?? prevMeta.senderEmail ?? null,
        senderPhone: senderPhone ?? prevMeta.senderPhone ?? null,
        entityId: entityId ?? prevMeta.entityId ?? null,
        channels: mergeChannels(prevMeta.channels, params.sourceType),
        dedupHash: params.dedupHash,
        archetype: params.archetype,
        topicLabel: prevMeta.topicLabel ?? (params.subject ?? params.archetype),
        totalInteractions: (prevMeta.totalInteractions ?? 0) + 1,
        lastSeenAt: now.toISOString().slice(0, 16).replace('T', ' '),
        recent: recent.slice(-8),
        summary: prevMeta.summary ?? null,
        dominantAction: prevMeta.dominantAction ?? null,
        decisionCount: prevMeta.decisionCount ?? 0,
        sinceLastSummary: (prevMeta.sinceLastSummary ?? 0) + 1,
        lastSummaryAt: prevMeta.lastSummaryAt ?? null,
      };

      const body = renderTopicPage(nextMeta);

      let topicPageId: string;
      if (existing) {
        await prisma.wikiPage.update({
          where: { id: existing.id },
          data: { bodyMarkdown: body, metadata: nextMeta as any, lastUpdatedBy: 'sender_wiki', lastUpdatedAt: now },
        });
        topicPageId = existing.id;
      } else {
        const created = await prisma.wikiPage.create({
          data: {
            clientNumber, userId, pageType: 'sender_topic', title: topicTitle,
            storage: 'postgres',
            bodyMarkdown: body,
            metadata: nextMeta as any,
            lastUpdatedBy: 'sender_wiki',
            status: 'active',
          } as any,
        });
        topicPageId = created.id;
      }
      void (async () => {
        try {
          const { embedWikiPage } = await import('./wikiEmbeddingService');
          await embedWikiPage(topicPageId);
        } catch { /* best effort */ }
      })();
    } catch (e: any) {
      log.warn('topic page upsert failed', { senderEmail, error: e.message });
    }
  }
}

/**
 * Pull the sender_history markdown body. Triage reads this instead of
 * recomputing 90 days of feed_events. Returns null if no page exists yet.
 */
export async function getSenderHistoryMarkdown(
  clientNumber: string,
  userId: number,
  senderEmail: string,
  maxChars = 800,
): Promise<string | null> {
  const page = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId, pageType: 'sender_history', title: senderEmail } as any,
    select: { bodyMarkdown: true },
  }).catch(() => null);
  if (!page?.bodyMarkdown) return null;
  return page.bodyMarkdown.length > maxChars ? page.bodyMarkdown.slice(0, maxChars) + '…' : page.bodyMarkdown;
}

/** Same for the (sender × topic) page. */
export async function getSenderTopicMarkdown(
  clientNumber: string,
  userId: number,
  senderEmail: string,
  dedupHash: string,
  maxChars = 600,
): Promise<string | null> {
  const topicTitle = `${senderEmail}::${dedupHash.slice(0, 12)}`;
  const page = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId, pageType: 'sender_topic', title: topicTitle } as any,
    select: { bodyMarkdown: true },
  }).catch(() => null);
  if (!page?.bodyMarkdown) return null;
  return page.bodyMarkdown.length > maxChars ? page.bodyMarkdown.slice(0, maxChars) + '…' : page.bodyMarkdown;
}

/**
 * Re-summarize the sender page with an LLM. Runs at a threshold to keep
 * cost bounded (not every ingest). Pulls full sender history + Wiki
 * entity page if any, asks for a 2-3 sentence summary, stores it in
 * metadata.summary and resets sinceLastSummary.
 */
export async function resummarizeSenderPage(clientNumber: string, userId: number, senderEmail: string): Promise<void> {
  const page = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId, pageType: 'sender_history', title: senderEmail } as any,
    select: { id: true, metadata: true },
  }).catch(() => null);
  if (!page) return;
  const meta: any = page.metadata ?? {};

  // Pull last 15 actual feed events for summarization input
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const events = await prisma.feedEvent.findMany({
    where: { clientNumber, userId, senderEmail: { equals: senderEmail, mode: 'insensitive' }, createdAt: { gte: since } } as any,
    select: { rawPayload: true, sourceType: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 15,
  }).catch(() => [] as any[]);

  if (events.length < 2) return;

  const timeline = events.reverse().map((e: any) => {
    const p: any = e.rawPayload ?? {};
    const subj = String(p.subject ?? '').slice(0, 120);
    const snippet = String(p.snippet ?? p.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
    const when = new Date(e.createdAt).toISOString().slice(0, 10);
    return snippet
      ? `- ${when} [${e.sourceType}] ${subj}\n    > ${snippet}`
      : `- ${when} [${e.sourceType}] ${subj}`;
  }).join('\n');

  try {
    const { callLLM } = await import('../llmRouter');
    const sys = `You maintain a one-paragraph running memory for the MD about a specific person they interact with. Write 2-3 short sentences (max 60 words) summarising WHO this person is (if known), WHAT they typically write about, HOW the MD has been handling them, and ANY open loops. Plain prose, no bullet list, no headers. Never invent facts not in the timeline.`;
    const user = `Person: ${meta.name ?? senderEmail} <${senderEmail}>
${meta.company ? `Company: ${meta.company}\n` : ''}${meta.role ? `Role: ${meta.role}\n` : ''}Total interactions in last 90d: ${events.length}
${meta.dominantAction ? `Typical MD response: ${meta.dominantAction}\n` : ''}${meta.dominantDelegatee ? `Often delegated to: ${meta.dominantDelegatee}\n` : ''}
Timeline (oldest → newest):
${timeline}

Write the running memory paragraph:`;
    const r = await callLLM(sys, user, { maxTokens: 180, userId, clientNumber, purpose: 'sender_wiki_summary' });
    const summary = r.text.trim();
    if (!summary) return;

    const nextMeta = { ...meta, summary, sinceLastSummary: 0, lastSummaryAt: new Date().toISOString() };
    const body = renderSenderPage(nextMeta);
    await prisma.wikiPage.update({
      where: { id: page.id },
      data: { bodyMarkdown: body, metadata: nextMeta as any, lastUpdatedBy: 'sender_wiki_llm', lastUpdatedAt: new Date() },
    });
    log.info('sender page re-summarized', { senderEmail, events: events.length });
  } catch (e: any) {
    log.warn('sender resummarize LLM failed', { senderEmail, error: e.message });
  }
}
