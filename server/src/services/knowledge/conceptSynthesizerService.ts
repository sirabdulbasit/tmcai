/**
 * Concept Synthesizer — builds the TOPIC-FIRST layer of the LLM Wiki.
 *
 * Two concept page types sit on top of the source pages (sender_history,
 * sender_topic, attachment_doc, org_doc):
 *
 *   entity_person — ONE page per canonical human. Aggregates every
 *                   source page tagged with that person's entityId.
 *                   Classifies internal (tenant colleague) vs external
 *                   (outside contact). Produces a running "who they are"
 *                   summary + list of topics they've engaged on + key
 *                   documents they've sent.
 *
 *   topic         — ONE page per recurring subject (a project, deal,
 *                   initiative). Aggregates every source page that
 *                   mentions it. Produces a running "what is this" +
 *                   list of people involved + key documents + status.
 *
 * Many-to-many: a person can have many topics, a topic can involve many
 * people — we link both sides via wiki_page_links so the graph is
 * navigable from either direction.
 *
 * Synthesis is driven by `enqueueSynthesis()` — called fire-and-forget
 * from sender-wiki + propagation upserts. A light in-memory debouncer
 * batches multiple updates to the same concept before the next LLM
 * summary call. This keeps cost bounded: one synthesis per person per
 * ~5 min of activity, not per message.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { BRAIN_SCHEMA_VERSION } from './brainSchema';
import { callLLM } from '../llmRouter';

const log = createLogger('concept-synth');

const DEBOUNCE_MS = 5 * 60 * 1000;
const LLM_MAX_TOKENS = 450;

// ─── Queue + debouncer ─────────────────────────────────────────

type Kind = 'person' | 'topic';
interface PendingKey { clientNumber: string; kind: Kind; id: string; }

const scheduled = new Map<string, NodeJS.Timeout>();

function keyOf(p: PendingKey): string {
  return `${p.clientNumber}:${p.kind}:${p.id}`;
}

export function enqueueSynthesis(p: PendingKey): void {
  const k = keyOf(p);
  const existing = scheduled.get(k);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(async () => {
    scheduled.delete(k);
    try {
      if (p.kind === 'person') await synthesizePerson(p.clientNumber, p.id);
      else await synthesizeTopic(p.clientNumber, p.id);
    } catch (err: any) {
      log.warn('synthesize failed', { key: k, error: err.message });
    }
  }, DEBOUNCE_MS);
  handle.unref?.();
  scheduled.set(k, handle);
}

/** Run immediately, skipping the debounce. Used by backfill + tests. */
export async function synthesizeNow(p: PendingKey): Promise<string | null> {
  if (p.kind === 'person') return synthesizePerson(p.clientNumber, p.id);
  return synthesizeTopic(p.clientNumber, p.id);
}

// ─── entity_person ─────────────────────────────────────────────

/**
 * Build/update the `entity_person` wiki page for one canonical human.
 * Scans every source page tagged with this entityId, produces a
 * unified summary + topic list + document list + timeline.
 */
export async function synthesizePerson(clientNumber: string, entityId: string): Promise<string | null> {
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    select: {
      id: true, name: true, email: true, phone: true,
      company: true, role: true, relationshipStrength: true,
      lastInteraction: true, clientNumber: true,
    },
  }).catch(() => null);
  if (!entity) return null;
  if (entity.clientNumber !== clientNumber) return null;

  const scope = await classifyPersonScope(clientNumber, entity.email, entity.phone);

  // Fetch all source pages linked to this entity across every user in the tenant.
  // Person pages are tenant-shared (a colleague writing to Basit vs Abdul is
  // still the same person), so the concept page surfaces every interaction.
  const linkedPages = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, user_id AS "userId", page_type AS "pageType", title,
            SUBSTRING(COALESCE(body_markdown,''), 1, 800) AS snippet,
            last_updated_at AS "lastUpdatedAt", source_count AS "sourceCount"
       FROM wiki_pages
      WHERE client_number = $1
        AND metadata->>'entityId' = $2
        AND status NOT IN ('superseded','deleted')
      ORDER BY last_updated_at DESC
      LIMIT 60`,
    clientNumber, entityId,
  ).catch(() => []);

  if (linkedPages.length === 0) return null;

  // Partition linked pages for the body
  const senderPages = linkedPages.filter((p) => p.pageType === 'sender_history' || p.pageType === 'sender_topic');
  const attachmentPages = linkedPages.filter((p) => p.pageType === 'attachment_doc');
  const otherPages = linkedPages.filter((p) => !['sender_history', 'sender_topic', 'attachment_doc'].includes(p.pageType));

  // Topics = unique sender_topic subjects, already a rough aggregation
  const topicTitles = Array.from(new Set(
    senderPages
      .filter((p) => p.pageType === 'sender_topic')
      .map((p) => String(p.title).split('::')[0] + ' · ' + (extractTopicFromSenderTopic(p.snippet) ?? 'topic')),
  ));

  // LLM running summary — one paragraph that grows with context.
  const llmInput = [
    `Person: ${entity.name}${entity.email ? ` <${entity.email}>` : ''}${entity.phone ? ` (phone ${entity.phone})` : ''}`,
    `Company: ${entity.company ?? '—'}  Role: ${entity.role ?? '—'}  Scope: ${scope}`,
    `Total linked pages: ${linkedPages.length} (${senderPages.length} sender · ${attachmentPages.length} attachments · ${otherPages.length} other)`,
    '',
    'Recent source pages:',
    ...senderPages.slice(0, 10).map((p) => `  - [${p.pageType}] ${p.title.slice(0, 80)} — ${String(p.snippet ?? '').replace(/\s+/g, ' ').slice(0, 200)}`),
    ...attachmentPages.slice(0, 6).map((p) => `  - [attachment] ${p.title.slice(0, 80)}`),
  ].join('\n');

  let summary = '';
  try {
    const sys = `You write a 2-3 paragraph "running memory" about a specific person for an AI executive assistant. Lead with WHO THEY ARE (role, company, internal/external). Then what they're WORKING ON with this user (key topics, active deals, documents). Then any OPEN LOOPS (pending responses, unresolved threads). Never invent facts not in the source pages. Plain prose — no bullets, no headers. Max 220 words.`;
    const r = await callLLM(sys, llmInput, {
      maxTokens: LLM_MAX_TOKENS,
      userId: 0, clientNumber, purpose: 'concept_person',
    });
    summary = r.text.trim();
  } catch (err: any) {
    log.warn('person summary LLM failed', { entityId, error: err.message });
    // Fallback: deterministic skeleton
    summary = `${entity.name}${entity.role ? `, ${entity.role}` : ''}${entity.company ? ` at ${entity.company}` : ''}. ${scope === 'internal' ? 'Internal colleague.' : 'External contact.'} ${linkedPages.length} pages of interaction history across ${senderPages.length ? 'email/messages' : 'sources'}${attachmentPages.length ? ` and ${attachmentPages.length} shared documents` : ''}.`;
  }

  const body = renderPersonPage({ entity, scope, summary, senderPages, attachmentPages, otherPages, topicTitles, linkedPages });

  // Title — prefer full name, fall back to email/phone
  const title = (entity.name || entity.email || entity.phone || entityId).slice(0, 300);

  // Store under a stable tenant user. We use the MD's userId so the page
  // is written in their scope, but since entity_person is a tenant-shared
  // concept page, every user's Brain reads it.
  const mdUser = await pickTenantScope(clientNumber);
  if (!mdUser) return null;

  // Per Basit 2026-05-25 (locked rule): contacts default to 'normal'.
  // 'tenant' (Public) is ONLY set when the user explicitly publishes
  // via /entity-catalog/:id/publish or the set_contact_scope chat action.
  // Concept synthesizer must NEVER auto-promote entity_person pages.
  //
  // This was the root cause of the recurring Public-badge bug: this
  // synthesizer ran on every entity-discovery turn and wrote
  // scope: 'tenant' into the metadata, blowing away user opt-ins and
  // promoting auto-discovered contacts that should stay private.

  // Load existing scope + publish-audit fields so we preserve them
  // when updating an entity_person page (so the user's manual
  // Make-Public / Make-Private opt-ins survive synthesis).
  const existing = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId: mdUser, pageType: 'entity_person', title },
    select: { id: true, metadata: true },
  }).catch(() => null);

  const existingMeta = (existing?.metadata as Record<string, unknown> | null) ?? {};
  const preservedScope = typeof existingMeta.scope === 'string' && ['tenant', 'normal', 'private'].includes(existingMeta.scope as string)
    ? (existingMeta.scope as string)
    : 'normal';

  const metadata: any = {
    schemaVersion: BRAIN_SCHEMA_VERSION,
    scope: preservedScope,
    personScope: scope,
    authoredBy: 'concept_synthesizer',
    entityId: entity.id,
    email: entity.email ?? null,
    phone: entity.phone ?? null,
    company: entity.company ?? null,
    role: entity.role ?? null,
    linkedPageCount: linkedPages.length,
    lastSynthesizedAt: new Date().toISOString(),
  };
  // Preserve publish-audit fields if they exist (so /entity-catalog/:id
  // /publish opt-ins aren't erased by every synth run).
  if (existingMeta.publicSetBy !== undefined) metadata.publicSetBy = existingMeta.publicSetBy;
  if (existingMeta.publicSince !== undefined) metadata.publicSince = existingMeta.publicSince;
  if (existingMeta.brainMutedBy !== undefined) metadata.brainMutedBy = existingMeta.brainMutedBy;
  if (existingMeta.brainMutedAt !== undefined) metadata.brainMutedAt = existingMeta.brainMutedAt;
  // Also preserve any user-set fields like stars + linked-person link.
  if (existingMeta.user_stars !== undefined) metadata.user_stars = existingMeta.user_stars;
  if (existingMeta.linkedPersonId !== undefined) metadata.linkedPersonId = existingMeta.linkedPersonId;

  let pageId: string;
  if (existing) {
    await prisma.wikiPage.update({
      where: { id: existing.id },
      data: { bodyMarkdown: body, metadata, lastUpdatedAt: new Date(), lastUpdatedBy: 'concept_synthesizer', status: 'active' },
    });
    pageId = existing.id;
  } else {
    const created = await prisma.wikiPage.create({
      data: {
        clientNumber, userId: mdUser,
        pageType: 'entity_person', title,
        bodyMarkdown: body, metadata,
        storage: 'postgres', status: 'active',
        sourceCount: linkedPages.length,
        lastUpdatedBy: 'concept_synthesizer',
      },
    });
    pageId = created.id;
  }

  // Wire person → every source page (one direction; source pages already
  // carry metadata.entityId, so we don't need the reverse link for lookup)
  await linkFromPersonToSources(clientNumber, mdUser, pageId, linkedPages);

  // Embed so semantic search "tell me about X" lands on this page
  void (async () => {
    try {
      const { embedWikiPage } = await import('./wikiEmbeddingService');
      await embedWikiPage(pageId);
    } catch { /* best-effort */ }
  })();

  return pageId;
}

function renderPersonPage(p: {
  entity: { id: string; name: string | null; email: string | null; phone: string | null; company: string | null; role: string | null };
  scope: 'internal' | 'external' | 'unknown';
  summary: string;
  senderPages: any[];
  attachmentPages: any[];
  otherPages: any[];
  topicTitles: string[];
  linkedPages: any[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${p.entity.name ?? p.entity.email ?? p.entity.phone ?? 'Unknown'}`);
  lines.push('');
  const badge = p.scope === 'internal' ? '🏢 Internal colleague' : p.scope === 'external' ? '🌐 External contact' : '⚙️ Scope unknown';
  lines.push(`**Scope:** ${badge}`);
  if (p.entity.email) lines.push(`**Email:** ${p.entity.email}`);
  if (p.entity.phone) lines.push(`**Phone / WhatsApp:** ${p.entity.phone}`);
  if (p.entity.company) lines.push(`**Company:** ${p.entity.company}`);
  if (p.entity.role) lines.push(`**Role:** ${p.entity.role}`);
  lines.push(`**Entity ID:** \`${p.entity.id}\``);
  lines.push('');

  if (p.summary) {
    lines.push('## Summary');
    lines.push(p.summary);
    lines.push('');
  }

  if (p.topicTitles.length > 0) {
    lines.push('## Topics discussed');
    for (const t of p.topicTitles.slice(0, 25)) lines.push(`- ${t}`);
    lines.push('');
  }

  if (p.attachmentPages.length > 0) {
    lines.push('## Documents shared');
    for (const a of p.attachmentPages.slice(0, 25)) {
      lines.push(`- \`${a.id}\` ${a.title}`);
    }
    lines.push('');
  }

  lines.push('## Recent timeline');
  for (const page of p.linkedPages.slice(0, 20)) {
    const date = page.lastUpdatedAt ? new Date(page.lastUpdatedAt).toISOString().slice(0, 10) : '';
    lines.push(`- ${date} · [${page.pageType}] ${String(page.title).slice(0, 90)}`);
  }
  lines.push('');

  lines.push(`_Auto-synthesized from ${p.linkedPages.length} source pages by the concept synthesizer. Source pages linked via \`metadata.entityId\` — see each for full content._`);
  return lines.join('\n');
}

async function linkFromPersonToSources(
  clientNumber: string,
  userId: number,
  personPageId: string,
  sources: Array<{ id: string }>,
): Promise<void> {
  for (const s of sources) {
    await prisma.wikiPageLink.upsert({
      where: { fromPageId_toPageId_linkType: { fromPageId: personPageId, toPageId: s.id, linkType: 'related' } } as any,
      update: {},
      create: {
        clientNumber, userId,
        fromPageId: personPageId, toPageId: s.id, linkType: 'related',
      },
    }).catch(() => {});
  }
}

// ─── topic ─────────────────────────────────────────────────────

/**
 * Build/update the `topic` wiki page for one named subject (typically
 * a project slug). `topicKey` is the stable canonical name.
 *
 * A topic is any named thing that recurs across multiple senders or
 * multiple sources — Satori, SFML implementation, IP strategy. We pull
 * every source page whose body mentions the topic name (case-insensitive
 * substring) AND every `project` page with that title.
 */
export async function synthesizeTopic(clientNumber: string, topicKey: string): Promise<string | null> {
  const name = topicKey.trim();
  if (name.length < 3) return null;

  // All wiki pages mentioning the topic (body ILIKE) that belong to this tenant.
  const linked = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, user_id AS "userId", page_type AS "pageType", title,
            metadata->>'entityId' AS "entityId",
            SUBSTRING(COALESCE(body_markdown,''), 1, 600) AS snippet,
            last_updated_at AS "lastUpdatedAt"
       FROM wiki_pages
      WHERE client_number = $1
        AND page_type NOT IN ('topic','tenant_index','tenant_log','entity_person')
        AND status NOT IN ('superseded','deleted')
        AND (
          title ILIKE '%' || $2 || '%'
          OR body_markdown ILIKE '%' || $2 || '%'
        )
      ORDER BY last_updated_at DESC
      LIMIT 50`,
    clientNumber, name,
  ).catch(() => []);

  if (linked.length < 2) return null;

  // Distinct people involved — pull entityId set and resolve names
  const entityIds = Array.from(new Set(linked.map((p) => p.entityId).filter(Boolean)));
  const people = entityIds.length > 0 ? await prisma.entity.findMany({
    where: { id: { in: entityIds as string[] }, clientNumber },
    select: { id: true, name: true, email: true, phone: true, company: true },
  }).catch(() => [] as any[]) : [] as any[];

  // Compose the LLM running summary
  const llmInput = [
    `Topic: ${name}`,
    `Mentions across ${linked.length} source pages. Involves ${people.length} distinct people.`,
    '',
    'People involved:',
    ...people.slice(0, 10).map((p) => `  - ${p.name}${p.email ? ` <${p.email}>` : ''}${p.company ? ` @ ${p.company}` : ''}`),
    '',
    'Source page snippets:',
    ...linked.slice(0, 15).map((p) => `  - [${p.pageType}] ${p.title.slice(0, 80)}: ${String(p.snippet ?? '').replace(/\s+/g, ' ').slice(0, 180)}`),
  ].join('\n');

  let summary = '';
  try {
    const sys = `You write a 2-paragraph "running memory" about a specific topic, project, or initiative for an AI executive assistant. Paragraph 1: what this topic IS (purpose, scope, status). Paragraph 2: WHERE IT STANDS (who's leading, pending actions, open blockers). Never invent facts. Plain prose, max 200 words.`;
    const r = await callLLM(sys, llmInput, {
      maxTokens: LLM_MAX_TOKENS,
      userId: 0, clientNumber, purpose: 'concept_topic',
    });
    summary = r.text.trim();
  } catch (err: any) {
    log.warn('topic summary LLM failed', { name, error: err.message });
    summary = `${name} — mentioned across ${linked.length} source pages involving ${people.length} distinct people.`;
  }

  const body = renderTopicPage({ name, summary, people, linked });
  const mdUser = await pickTenantScope(clientNumber);
  if (!mdUser) return null;

  const metadata: any = {
    schemaVersion: BRAIN_SCHEMA_VERSION,
    scope: 'tenant',
    authoredBy: 'concept_synthesizer',
    linkedPageCount: linked.length,
    personIds: entityIds,
    lastSynthesizedAt: new Date().toISOString(),
  };

  const existing = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId: mdUser, pageType: 'topic', title: name },
    select: { id: true },
  }).catch(() => null);

  let pageId: string;
  if (existing) {
    await prisma.wikiPage.update({
      where: { id: existing.id },
      data: { bodyMarkdown: body, metadata, lastUpdatedAt: new Date(), lastUpdatedBy: 'concept_synthesizer', status: 'active' },
    });
    pageId = existing.id;
  } else {
    const created = await prisma.wikiPage.create({
      data: {
        clientNumber, userId: mdUser,
        pageType: 'topic', title: name,
        bodyMarkdown: body, metadata,
        storage: 'postgres', status: 'active',
        sourceCount: linked.length,
        lastUpdatedBy: 'concept_synthesizer',
      },
    });
    pageId = created.id;
  }

  // Link topic → each source page AND topic ↔ each entity_person page
  await linkTopicGraph(clientNumber, mdUser, pageId, linked, entityIds);

  void (async () => {
    try {
      const { embedWikiPage } = await import('./wikiEmbeddingService');
      await embedWikiPage(pageId);
    } catch { /* best effort */ }
  })();

  return pageId;
}

function renderTopicPage(p: {
  name: string;
  summary: string;
  people: Array<{ id: string; name: string | null; email: string | null; company: string | null }>;
  linked: any[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${p.name}`);
  lines.push('');
  lines.push(`**Type:** topic / initiative`);
  lines.push(`**Linked sources:** ${p.linked.length}`);
  lines.push(`**People involved:** ${p.people.length}`);
  lines.push('');

  if (p.summary) {
    lines.push('## Summary');
    lines.push(p.summary);
    lines.push('');
  }

  if (p.people.length > 0) {
    lines.push('## People involved');
    for (const person of p.people.slice(0, 25)) {
      lines.push(`- ${person.name}${person.email ? ` <${person.email}>` : ''}${person.company ? ` @ ${person.company}` : ''}  \`${person.id}\``);
    }
    lines.push('');
  }

  lines.push('## Recent mentions');
  for (const page of p.linked.slice(0, 20)) {
    const date = page.lastUpdatedAt ? new Date(page.lastUpdatedAt).toISOString().slice(0, 10) : '';
    lines.push(`- ${date} · [${page.pageType}] ${String(page.title).slice(0, 90)}`);
  }
  lines.push('');

  lines.push(`_Auto-synthesized from ${p.linked.length} source pages. Cross-linked to each person's entity_person page via wiki_page_links._`);
  return lines.join('\n');
}

async function linkTopicGraph(
  clientNumber: string,
  userId: number,
  topicPageId: string,
  sources: Array<{ id: string }>,
  entityIds: string[],
): Promise<void> {
  // topic → each source
  for (const s of sources) {
    await prisma.wikiPageLink.upsert({
      where: { fromPageId_toPageId_linkType: { fromPageId: topicPageId, toPageId: s.id, linkType: 'related' } } as any,
      update: {},
      create: {
        clientNumber, userId,
        fromPageId: topicPageId, toPageId: s.id, linkType: 'related',
      },
    }).catch(() => {});
  }

  // topic ↔ each entity_person page (many-to-many, both directions)
  if (entityIds.length > 0) {
    // Prisma's Json filter doesn't support `in` — use raw SQL.
    const personPages = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM wiki_pages
        WHERE client_number = $1
          AND page_type = 'entity_person'
          AND metadata->>'entityId' = ANY($2::text[])`,
      clientNumber, entityIds,
    ).catch(() => [] as any[]);
    for (const pp of personPages) {
      await prisma.wikiPageLink.upsert({
        where: { fromPageId_toPageId_linkType: { fromPageId: topicPageId, toPageId: pp.id, linkType: 'related' } } as any,
        update: {},
        create: { clientNumber, userId, fromPageId: topicPageId, toPageId: pp.id, linkType: 'related' },
      }).catch(() => {});
      await prisma.wikiPageLink.upsert({
        where: { fromPageId_toPageId_linkType: { fromPageId: pp.id, toPageId: topicPageId, linkType: 'related' } } as any,
        update: {},
        create: { clientNumber, userId, fromPageId: pp.id, toPageId: topicPageId, linkType: 'related' },
      }).catch(() => {});
    }
  }
}

// ─── internals ───────────────────────────────────────────────────

async function classifyPersonScope(
  clientNumber: string,
  email: string | null | undefined,
  phone: string | null | undefined,
): Promise<'internal' | 'external' | 'unknown'> {
  // Internal if the email domain matches the tenant domain OR a users row exists.
  if (email) {
    const emailNorm = email.toLowerCase();
    const domain = emailNorm.split('@')[1] ?? '';
    const tenant = await prisma.tenant.findUnique({
      where: { clientNumber },
      select: { domain: true },
    }).catch(() => null);
    if (tenant?.domain && domain && domain.includes(tenant.domain.toLowerCase())) return 'internal';
    const user = await prisma.user.findFirst({
      where: { clientNumber, email: { equals: emailNorm, mode: 'insensitive' } } as any,
      select: { id: true },
    }).catch(() => null);
    if (user) return 'internal';
    if (domain) return 'external';
  }
  if (phone && !email) return 'external';  // WhatsApp contacts default to external absent other signals
  return 'unknown';
}

/** Pick the user ID to scope tenant-shared concept pages under. */
async function pickTenantScope(clientNumber: string): Promise<number | null> {
  // Prefer a super-admin if we have one; else the first active user.
  // Tenant-shared page types are cross-user-readable anyway (see
  // TENANT_SHARED_PAGE_TYPES in tenantIndexService), so this is just
  // bookkeeping — the chosen user "owns" the row for FK purposes.
  const u = await prisma.user.findFirst({
    where: { clientNumber, isActive: true } as any,
    orderBy: { id: 'asc' },
    select: { id: true },
  }).catch(() => null);
  return u?.id ?? null;
}

function extractTopicFromSenderTopic(snippet: string): string | null {
  // sender_topic pages have "topic: <label>" in their body; grab it if present.
  const m = String(snippet ?? '').match(/topic:\s*([^\n]+)/i);
  return m?.[1]?.slice(0, 80) ?? null;
}
