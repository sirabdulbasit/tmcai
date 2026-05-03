/**
 * MyOS — Organization Knowledge.
 *
 * Rolls the user's tenant state into a single compact snapshot that the
 * triage layer can read before suggesting anything. Cached 60s per tenant
 * because every attention-card render would otherwise re-query.
 *
 * The snapshot is intentionally small and LLM-friendly — flat strings,
 * counts, and top-5 lists. This is the context-window efficient version
 * of "what's going on at TallyMarks right now?".
 */
import prisma from '../../db/prisma';

export interface OrgSnapshot {
  clientNumber: string;
  activeAccounts: Array<{ name: string; company: string | null; relationshipStrength: number | null }>;
  activeProjects: Array<{ name: string; company: string | null }>;
  criticalContacts: Array<{ name: string; company: string | null; role: string | null }>;
  /** High-priority open items currently in flight across all sources */
  hotOpenItems: Array<{ id: string; title: string; priority: string; type: string; updatedAt: Date }>;
  /** Active shadow_rules — patterns MD has crystallized into automation */
  activeRules: Array<{ id: string; name: string; action: string; agreement: number | null }>;
  /** What Brain autonomously handled in the last 24h */
  recentAutonomy: Array<{ actionType: string; createdAt: Date }>;
  /** Curated org docs from the tenant's FACL folder (Gdrive/OneDrive).
   *  Scribed on connector configure + daily; read by triage so Brain can
   *  reference SOPs, playbooks, and policies the MD has filed there. */
  faclDocs: Array<{ title: string; summary: string; updatedAt: Date }>;
  stats: {
    totalOpenItems: number;
    criticalOpenItems: number;
    delegatedOpenItems: number;
    blockedOpenItems: number;
    activeRuleCount: number;
    wikiEntityCount: number;
    faclDocCount: number;
  };
  fetchedAt: number;
}

// Short cache. Snapshot pulls from entities, open_items, shadow_rules, FACL.
// A single Day Brief refresh can hit this 30+ times (once per attention
// card) — without a cache that's 30× 10 indexed-column queries + 30×
// wiki_pages scan. 30s TTL stays fresh enough for real-world use
// (FACL scribe is daily, entity updates are seconds) while eliminating
// the per-card fan-out. Invalidate hook below for explicit fresh reads.
const snapshotCache = new Map<string, { snapshot: OrgSnapshot; fetchedAt: number }>();
const SNAPSHOT_TTL_MS = 30_000;

export async function getOrgSnapshot(clientNumber: string, userId: number): Promise<OrgSnapshot> {
  const key = `${clientNumber}:${userId}`;
  const cached = snapshotCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SNAPSHOT_TTL_MS) return cached.snapshot;

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    accounts,
    projects,
    criticalPeople,
    hotItems,
    activeRules,
    autonomy,
    allOpen,
    criticalOpen,
    delegatedOpen,
    blockedOpen,
    wikiCount,
  ] = await Promise.all([
    prisma.entity.findMany({
      where: { clientNumber, entityType: 'account' } as any,
      select: { name: true, company: true, relationshipStrength: true },
      orderBy: { relationshipStrength: 'desc' as any },
      take: 10,
    }).catch(() => [] as any[]),
    prisma.entity.findMany({
      where: { clientNumber, entityType: 'project' } as any,
      select: { name: true, company: true },
      orderBy: { lastInteraction: 'desc' as any },
      take: 10,
    }).catch(() => [] as any[]),
    prisma.entity.findMany({
      where: { clientNumber, entityType: 'contact', relationshipStrength: { gte: 5 } } as any,
      select: { name: true, company: true, role: true },
      orderBy: { relationshipStrength: 'desc' as any },
      take: 10,
    }).catch(() => [] as any[]),
    prisma.openItem.findMany({
      where: {
        clientNumber, userId,
        status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'WAITING_INFO'] as any },
        priority: { in: ['critical', 'high'] as any },
      } as any,
      select: { id: true, title: true, priority: true, type: true, updatedAt: true },
      orderBy: [{ priority: 'asc' as any }, { updatedAt: 'desc' as any }],
      take: 10,
    }).catch(() => [] as any[]),
    prisma.shadowRule.findMany({
      where: { clientNumber, userId, mode: 'ACTIVE' } as any,
      select: { id: true, name: true, action: true, agreement: true },
      orderBy: { agreement: 'desc' as any },
      take: 10,
    }).catch(() => [] as any[]),
    prisma.agentAction.findMany({
      where: {
        clientNumber, userId,
        executedByAgent: { in: ['rule_miner_auto', 'delegation_tracker', 'delegation_followup'] } as any,
        createdAt: { gte: since24h },
      } as any,
      select: { actionType: true, createdAt: true },
      orderBy: { createdAt: 'desc' as any },
      take: 10,
    }).catch(() => [] as any[]),
    prisma.openItem.count({ where: { clientNumber, userId, status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'WAITING_INFO', 'DELEGATED'] as any } } as any }).catch(() => 0),
    prisma.openItem.count({ where: { clientNumber, userId, status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS'] as any }, priority: 'critical' } as any }).catch(() => 0),
    prisma.openItem.count({ where: { clientNumber, userId, status: 'DELEGATED' } as any }).catch(() => 0),
    prisma.openItem.count({ where: { clientNumber, userId, status: 'WAITING_INFO' } as any }).catch(() => 0),
    prisma.entity.count({ where: { clientNumber } as any }).catch(() => 0),
  ]);

  // Pull FACL doc summaries (max 10, newest first). These are TENANT-
  // scoped (scribed once for the whole tenant, readable by every user)
  // so we deliberately drop userId from the filter.
  const faclDocs = await prisma.wikiPage.findMany({
    where: { clientNumber, pageType: 'org_doc', status: 'active' } as any,
    select: { title: true, bodyMarkdown: true, lastUpdatedAt: true, metadata: true },
    orderBy: { lastUpdatedAt: 'desc' },
    take: 10,
  }).catch(() => [] as any[]);

  const snapshot: OrgSnapshot = {
    clientNumber,
    activeAccounts: accounts as any,
    activeProjects: projects as any,
    criticalContacts: criticalPeople as any,
    hotOpenItems: hotItems as any,
    activeRules: activeRules as any,
    recentAutonomy: autonomy as any,
    faclDocs: faclDocs.map((d: any) => ({
      title: d.title,
      summary: String(d.bodyMarkdown ?? '').slice(0, 400),
      updatedAt: d.lastUpdatedAt,
    })),
    stats: {
      totalOpenItems: allOpen,
      criticalOpenItems: criticalOpen,
      delegatedOpenItems: delegatedOpen,
      blockedOpenItems: blockedOpen,
      activeRuleCount: activeRules.length,
      wikiEntityCount: wikiCount,
      faclDocCount: faclDocs.length,
    },
    fetchedAt: Date.now(),
  };
  snapshotCache.set(key, { snapshot, fetchedAt: Date.now() });
  return snapshot;
}

/**
 * LLM-friendly one-paragraph summary of the org snapshot. ~100 tokens.
 * Dropped into any prompt where Brain needs ambient awareness without
 * pulling the full snapshot.
 */
export function summariseOrgSnapshot(s: OrgSnapshot): string {
  const lines: string[] = [];
  if (s.activeAccounts.length > 0) {
    lines.push(`Active accounts: ${s.activeAccounts.slice(0, 5).map((a) => a.name).join(', ')}`);
  }
  if (s.activeProjects.length > 0) {
    lines.push(`Active projects: ${s.activeProjects.slice(0, 5).map((p) => p.name).join(', ')}`);
  }
  if (s.criticalContacts.length > 0) {
    lines.push(`Key people: ${s.criticalContacts.slice(0, 5).map((c) => `${c.name}${c.role ? ` (${c.role})` : ''}`).join(', ')}`);
  }
  lines.push(
    `Open work: ${s.stats.totalOpenItems} total, ${s.stats.criticalOpenItems} critical, ${s.stats.delegatedOpenItems} delegated, ${s.stats.blockedOpenItems} waiting.`,
  );
  if (s.stats.activeRuleCount > 0) {
    lines.push(`${s.stats.activeRuleCount} automation rules active.`);
  }
  if (s.recentAutonomy.length > 0) {
    lines.push(`Brain handled ${s.recentAutonomy.length} items autonomously in last 24h.`);
  }
  if (s.faclDocs.length > 0) {
    lines.push(`FACL knowledge base: ${s.faclDocs.slice(0, 5).map((d) => d.title).join(', ')}${s.faclDocs.length > 5 ? ` + ${s.faclDocs.length - 5} more` : ''}.`);
  }
  return lines.join(' ');
}

/** Clear the cached snapshot for one tenant+user (call after writes that should be reflected immediately). */
export function invalidateOrgSnapshot(clientNumber: string, userId: number): void {
  snapshotCache.delete(`${clientNumber}:${userId}`);
}
