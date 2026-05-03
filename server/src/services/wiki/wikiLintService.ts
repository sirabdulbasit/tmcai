/**
 * MyOS Wiki lint — per-user health check.
 *
 * Detects orphans, stale pages, contradictions, unsourced claims, and gap
 * questions. Runs nightly via the Phase 5 cron. Findings are posted to the
 * Steering Wheel inbox.
 *
 * This first-pass is deterministic (structural checks). A later iteration can
 * add a Gemini Pro reasoning pass for semantic contradiction detection across
 * page bodies.
 */
import prisma from '../../db/prisma';

const ORPHAN_CUTOFF_AGE_DAYS = 7;
const STALE_CUTOFF_AGE_DAYS = 90;

export interface LintFindings {
  clientNumber: string;
  userId: number;
  generatedAt: string;
  pageCount: number;
  orphans: Array<{ id: string; title: string; pageType: string; reason: string }>;
  stale: Array<{ id: string; title: string; lastUpdatedAt: string }>;
  contradicted: Array<{ id: string; title: string; pageType: string }>;
  unsourced: Array<{ id: string; title: string; pageType: string }>;
  brokenLinks: Array<{ fromId: string; toId: string; linkType: string | null }>;
  draftStuck: Array<{ id: string; title: string; ageDays: number }>;
  suggestions: string[];
}

export async function mineWikiHealth(clientNumber: string, userId: number): Promise<LintFindings> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - ORPHAN_CUTOFF_AGE_DAYS * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - STALE_CUTOFF_AGE_DAYS * 24 * 60 * 60 * 1000);

  const allPages = await prisma.wikiPage.findMany({
    where: { clientNumber, userId } as any,
    select: {
      id: true, title: true, pageType: true, status: true,
      inboundLinks: true, outboundLinks: true, sourceCount: true,
      lastUpdatedAt: true, createdAt: true, confidence: true,
    },
  });

  const orphans = allPages
    .filter((p) => p.inboundLinks === 0 && p.outboundLinks === 0 && p.createdAt < sevenDaysAgo)
    .map((p) => ({
      id: p.id, title: p.title, pageType: p.pageType,
      reason: p.sourceCount > 0 ? 'no links (has sources)' : 'no links and no sources',
    }));

  const stale = allPages
    .filter((p) => p.status !== 'stale' && p.lastUpdatedAt < ninetyDaysAgo)
    .map((p) => ({
      id: p.id, title: p.title,
      lastUpdatedAt: p.lastUpdatedAt.toISOString(),
    }));

  const contradicted = allPages
    .filter((p) => p.status === 'contradicted')
    .map((p) => ({ id: p.id, title: p.title, pageType: p.pageType }));

  const unsourced = allPages
    .filter((p) => p.sourceCount === 0 && p.pageType !== 'concept')
    .map((p) => ({ id: p.id, title: p.title, pageType: p.pageType }));

  const draftStuck = allPages
    .filter((p) => p.status === 'draft' && p.createdAt < sevenDaysAgo)
    .map((p) => ({
      id: p.id, title: p.title,
      ageDays: Math.round((now.getTime() - p.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
    }));

  // Broken links: rows where from/to page id no longer exists.
  const allIds = new Set(allPages.map((p) => p.id));
  const linkRows = await (prisma as any).wikiPageLink.findMany({
    where: { clientNumber, userId },
    select: { fromPageId: true, toPageId: true, linkType: true },
  });
  const brokenLinks = linkRows
    .filter((l: any) => !allIds.has(l.fromPageId) || !allIds.has(l.toPageId))
    .slice(0, 50)
    .map((l: any) => ({ fromId: l.fromPageId, toId: l.toPageId, linkType: l.linkType }));

  // Suggestions — cheap rule-based prompts for things worth investigating.
  const suggestions: string[] = [];
  if (orphans.length > 0) suggestions.push(`${orphans.length} orphan pages — consider merging, linking, or archiving.`);
  if (stale.length > 0) suggestions.push(`${stale.length} pages haven't been touched in >90d — mark stale or refresh.`);
  if (contradicted.length > 0) suggestions.push(`${contradicted.length} pages flagged as contradicted — resolve.`);
  if (unsourced.length > 0) suggestions.push(`${unsourced.length} entity/decision/pattern pages have no source citations — back-fill.`);
  if (draftStuck.length > 0) suggestions.push(`${draftStuck.length} draft pages older than 7d — approve or discard.`);
  if (brokenLinks.length > 0) suggestions.push(`${brokenLinks.length} broken links — clean up.`);

  return {
    clientNumber,
    userId,
    generatedAt: now.toISOString(),
    pageCount: allPages.length,
    orphans,
    stale,
    contradicted,
    unsourced,
    brokenLinks,
    draftStuck,
    suggestions,
  };
}
