/**
 * tenant_index — a single wiki page per (clientNumber, userId) that lists
 * every other wiki page in that user's knowledge base. Rebuilt on demand
 * (debounced 30s per tenant). Brain reads this FIRST on every query so it
 * knows what it has to work with before touching any actual page body.
 *
 * Format: markdown, grouped by pageType. Each entry:
 *   - [title](wiki:<pageId>) — one-line summary · <n> sources · updated <date>
 */
import prisma from '../../db/prisma';
import { BRAIN_SCHEMA_VERSION } from './brainSchema';

const INDEX_TITLE = 'Tenant Index';
const INDEX_PAGE_TYPE = 'tenant_index';
const REBUILD_COOLDOWN_MS = 30_000;

const lastRebuild = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

export interface IndexEntry {
  id: string;
  title: string;
  pageType: string;
  bodyMarkdown: string | null;
  sourceCount: number;
  lastUpdatedAt: Date;
}

/**
 * Page types that belong to the tenant, not to a single user. A FACL doc
 * scribed once (usually by the admin) should be visible to every user's
 * Brain. Sender history and entity pages stay user-scoped — Basit's
 * conversations with X aren't the same as Abdul's conversations with X.
 */
export const TENANT_SHARED_PAGE_TYPES = ['org_doc', 'policy', 'project', 'decision', 'pattern', 'entity_person', 'topic'] as const;

/**
 * Planner-optimized view of the index. Keeps the full index for UI/debug,
 * but for LLM prompts we want to surface high-signal pages (org_doc,
 * project, policy, decision, pattern, entity with relationshipStrength
 * >=3, answer, gap). Sender_history / sender_topic are summarized as a
 * count with a note that they can be searched by email/name term.
 */
export async function getCompactIndexForPlanner(clientNumber: string, userId: number): Promise<string> {
  // Single query, scope-aware visibility:
  //   - tenant-scoped pages: visible to every user in the tenant
  //   - user-scoped pages: visible only to the owning user_id
  // The wiki_pages.scope column is set by writes (defaultScopeForPageType)
  // and was backfilled in the 20260504_wiki_pages_scope migration.
  const allPages = await prisma.wikiPage.findMany({
    where: {
      clientNumber,
      pageType: { notIn: [INDEX_PAGE_TYPE, 'tenant_log'] },
      status: { notIn: ['superseded', 'deleted'] },
      OR: [
        { scope: 'tenant' },
        { scope: 'user', userId },
      ],
    } as any,
    select: {
      id: true, title: true, pageType: true, bodyMarkdown: true,
      sourceCount: true, lastUpdatedAt: true, scope: true,
    },
  }).catch(() => [] as any[]);

  // Dedupe by (pageType, title): if a tenant copy and a user copy share
  // the same logical identity, prefer the tenant copy (more authoritative).
  const byKey = new Map<string, any>();
  for (const p of allPages) {
    const key = `${p.pageType}::${p.title}`;
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, p);
    else if (p.scope === 'tenant' && prev.scope !== 'tenant') byKey.set(key, p);
  }
  const pages = Array.from(byKey.values());

  const byType = new Map<string, typeof pages>();
  for (const p of pages) {
    if (!byType.has(p.pageType)) byType.set(p.pageType, []);
    byType.get(p.pageType)!.push(p);
  }

  // Concept-layer pages (entity_person, topic) sit at the top because
  // they pre-synthesize what Brain would otherwise assemble on every
  // turn. Source pages follow.
  // Concept + awareness pages first; source + lineage after.
  const HIGH_SIGNAL = ['mind_state', 'observation', 'entity_person', 'topic', 'project', 'policy', 'decision', 'pattern', 'org_doc', 'attachment_doc', 'answer', 'gap'];
  const out: string[] = [];
  out.push('# Tenant Index (planner view)');
  out.push('');
  out.push(`Total pages in wiki: ${pages.length}`);
  out.push('');

  for (const t of HIGH_SIGNAL) {
    const list = byType.get(t) ?? [];
    if (list.length === 0) continue;
    out.push(`## ${t} (${list.length})`);
    for (const p of list) {
      out.push(`- \`${p.id}\` **${p.title}** — ${firstLine(p as any)}`);
    }
    out.push('');
  }

  // Entity pages — keep up to 40 strongest plus any with a project/domain hint.
  const entities = byType.get('entity') ?? [];
  if (entities.length > 0) {
    out.push(`## entity (${entities.length}) — top 40 by interactions`);
    const ranked = [...entities].sort((a, b) => (b.sourceCount ?? 0) - (a.sourceCount ?? 0)).slice(0, 40);
    for (const p of ranked) {
      out.push(`- \`${p.id}\` **${p.title}** — ${firstLine(p as any)}${p.sourceCount ? ` · ${p.sourceCount} sources` : ''}`);
    }
    out.push('');
  }

  const senderH = byType.get('sender_history')?.length ?? 0;
  const senderT = byType.get('sender_topic')?.length ?? 0;
  if (senderH || senderT) {
    out.push(`## sender pages (not listed individually)`);
    out.push(`There are ${senderH} sender_history pages and ${senderT} sender_topic pages for this user. Do NOT list these in the index inline — too long. If the question names an email, person, or topic, add that term to \`entityTerms\` and the composer will pull matching sender_* pages by fuzzy search.`);
    out.push('');
  }

  return out.join('\n');
}

export async function getTenantIndexPageId(clientNumber: string, userId: number): Promise<string | null> {
  const page = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId, pageType: INDEX_PAGE_TYPE, title: INDEX_TITLE },
    select: { id: true },
  }).catch(() => null);
  return page?.id ?? null;
}

/** Return the tenant_index body. Rebuilds if stale or missing. */
export async function getTenantIndexBody(clientNumber: string, userId: number): Promise<string> {
  const page = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId, pageType: INDEX_PAGE_TYPE, title: INDEX_TITLE },
    select: { bodyMarkdown: true, lastUpdatedAt: true },
  }).catch(() => null);

  // Auto-build if missing or stale beyond cooldown
  const stale = !page || Date.now() - page.lastUpdatedAt.getTime() > REBUILD_COOLDOWN_MS;
  if (stale) {
    await rebuildTenantIndex(clientNumber, userId);
    const refreshed = await prisma.wikiPage.findFirst({
      where: { clientNumber, userId, pageType: INDEX_PAGE_TYPE, title: INDEX_TITLE },
      select: { bodyMarkdown: true },
    }).catch(() => null);
    return refreshed?.bodyMarkdown ?? '(index not yet built)';
  }
  return page.bodyMarkdown ?? '(index empty)';
}

/** Force-rebuild the index. Idempotent; debounced 30s per tenant. */
export async function rebuildTenantIndex(clientNumber: string, userId: number): Promise<void> {
  const key = `${clientNumber}:${userId}`;
  const last = lastRebuild.get(key) ?? 0;
  if (Date.now() - last < REBUILD_COOLDOWN_MS) {
    const pending = inFlight.get(key);
    if (pending) return pending;
    return;
  }
  lastRebuild.set(key, Date.now());

  const task = (async () => {
    const pages = await prisma.wikiPage.findMany({
      where: {
        clientNumber, userId,
        pageType: { notIn: [INDEX_PAGE_TYPE, 'tenant_log'] },
        status: { notIn: ['superseded', 'deleted'] },
      },
      select: {
        id: true, title: true, pageType: true, bodyMarkdown: true,
        sourceCount: true, lastUpdatedAt: true,
      },
      orderBy: [{ pageType: 'asc' }, { lastUpdatedAt: 'desc' }],
    }).catch(() => [] as any[]);

    const body = renderIndex(pages as IndexEntry[]);
    await upsertIndex(clientNumber, userId, body);
  })();

  inFlight.set(key, task);
  try { await task; } finally { inFlight.delete(key); }
}

function renderIndex(pages: IndexEntry[]): string {
  const byType = new Map<string, IndexEntry[]>();
  for (const p of pages) {
    if (!byType.has(p.pageType)) byType.set(p.pageType, []);
    byType.get(p.pageType)!.push(p);
  }

  const out: string[] = [];
  out.push(`# Tenant Index`);
  out.push('');
  out.push(`_Auto-maintained. Read this first to know what's available, then open specific pages by id._`);
  out.push('');
  out.push(`**Total pages:** ${pages.length}`);
  out.push('');

  // Stable display order for page types
  const typeOrder = [
    'entity', 'project', 'org_doc', 'policy', 'decision', 'pattern',
    'sender_history', 'sender_topic', 'answer', 'gap',
  ];
  const seen = new Set<string>();
  for (const t of typeOrder) {
    if (!byType.has(t)) continue;
    seen.add(t);
    out.push(`## ${t} (${byType.get(t)!.length})`);
    for (const p of byType.get(t)!) {
      out.push(`- \`${p.id}\` **${p.title}** — ${firstLine(p)}${p.sourceCount ? ` · ${p.sourceCount} sources` : ''}`);
    }
    out.push('');
  }
  // Any type we didn't list explicitly
  for (const [t, list] of byType) {
    if (seen.has(t)) continue;
    out.push(`## ${t} (${list.length})`);
    for (const p of list) {
      out.push(`- \`${p.id}\` **${p.title}** — ${firstLine(p)}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function firstLine(p: { bodyMarkdown: string | null; title: string }): string {
  const body = String(p.bodyMarkdown ?? '');
  const lines = body.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('**Source'));
  const first = (lines[0] ?? '').replace(/\s+/g, ' ').trim();
  if (!first) return '(no summary)';
  return first.slice(0, 140);
}

async function upsertIndex(clientNumber: string, userId: number, body: string): Promise<void> {
  const existing = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId, pageType: INDEX_PAGE_TYPE, title: INDEX_TITLE },
    select: { id: true },
  }).catch(() => null);

  const metadata = {
    schemaVersion: BRAIN_SCHEMA_VERSION,
    scope: 'user',
    authoredBy: 'tenant_indexer',
    generatedAt: new Date().toISOString(),
  };

  if (existing) {
    await prisma.wikiPage.update({
      where: { id: existing.id },
      data: { bodyMarkdown: body, metadata, lastUpdatedAt: new Date(), lastUpdatedBy: 'tenant_indexer', status: 'active' },
    }).catch(() => {});
  } else {
    await prisma.wikiPage.create({
      data: {
        clientNumber, userId,
        pageType: INDEX_PAGE_TYPE,
        title: INDEX_TITLE,
        bodyMarkdown: body,
        metadata,
        storage: 'postgres',
        status: 'active',
        lastUpdatedBy: 'tenant_indexer',
      },
    }).catch(() => {});
  }
}
