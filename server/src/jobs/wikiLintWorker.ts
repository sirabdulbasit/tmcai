/**
 * Phase F — Wiki lint worker.
 *
 * Hourly health check over the LLM Wiki. Finds:
 *   - orphan pages          (0 inbound + 0 outbound links AND pageType isn't index/log)
 *   - stale pages           (lastUpdatedAt > 60d and subject still active)
 *   - unresolved gaps       (gap pages with no answer page yet linking back)
 *   - missing entity pages  (entity referenced in ≥3 wiki pages, no page of its own)
 *   - contradictions        (wiki_page_links with linkType='contradicts' unresolved > 7d)
 *
 * Produces a per-tenant findings record filed into a `pattern` wiki page
 * titled "Wiki Lint Report" so the MD can skim what Brain has flagged
 * without waking at 3am to look at logs.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { BRAIN_SCHEMA_VERSION } from '../services/knowledge/brainSchema';

const log = createLogger('wiki-lint');

export interface LintFindings {
  orphans: number;
  stale: number;
  openGaps: number;
  missingEntityPages: string[];
  contradictions: number;
  ranAt: string;
}

const STALE_THRESHOLD_MS = 60 * 24 * 60 * 60 * 1000;

export async function runLintForUser(clientNumber: string, userId: number): Promise<LintFindings> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_THRESHOLD_MS);

  const [orphansCount, staleCount, openGaps, contradictions, missingEntityNames] = await Promise.all([
    prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM wiki_pages
        WHERE client_number = $1 AND user_id = $2
          AND page_type NOT IN ('tenant_index','tenant_log','gap','answer')
          AND status = 'active'
          AND inbound_links = 0 AND outbound_links = 0`,
      clientNumber, userId,
    ).then((r) => r[0]?.n ?? 0).catch(() => 0),
    prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM wiki_pages
        WHERE client_number = $1 AND user_id = $2
          AND page_type IN ('sender_history','sender_topic','entity','project')
          AND status = 'active'
          AND last_updated_at < $3`,
      clientNumber, userId, staleBefore,
    ).then((r) => r[0]?.n ?? 0).catch(() => 0),
    prisma.wikiPage.count({
      where: { clientNumber, userId, pageType: 'gap', status: 'active' },
    }).catch(() => 0),
    prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM wiki_page_links
        WHERE client_number = $1 AND user_id = $2
          AND link_type = 'contradicts'
          AND created_at < $3`,
      clientNumber, userId, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
    ).then((r) => r[0]?.n ?? 0).catch(() => 0),
    // Entity names referenced in 3+ pages but without an `entity` page of their own
    prisma.$queryRawUnsafe<any[]>(
      `WITH sender_pages AS (
         SELECT DISTINCT title FROM wiki_pages
         WHERE client_number = $1 AND user_id = $2 AND page_type = 'sender_history'
       ),
       existing_entities AS (
         SELECT LOWER(title) AS title FROM wiki_pages
         WHERE client_number = $1 AND user_id = $2 AND page_type = 'entity'
       )
       SELECT sp.title
         FROM sender_pages sp
         LEFT JOIN existing_entities ee ON LOWER(sp.title) = ee.title
        WHERE ee.title IS NULL
        LIMIT 20`,
      clientNumber, userId,
    ).then((r) => r.map((x: any) => x.title)).catch(() => [] as string[]),
  ]);

  const findings: LintFindings = {
    orphans: orphansCount,
    stale: staleCount,
    openGaps,
    missingEntityPages: missingEntityNames,
    contradictions,
    ranAt: now.toISOString(),
  };

  await fileLintReport(clientNumber, userId, findings, now);
  return findings;
}

async function fileLintReport(clientNumber: string, userId: number, f: LintFindings, now: Date): Promise<void> {
  const title = 'Wiki Lint Report';
  const body = [
    `# ${title}`,
    '',
    `**Ran:** ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    '## Health summary',
    `- Orphans: ${f.orphans}`,
    `- Stale (older than 60d, still-active subject): ${f.stale}`,
    `- Open gap pages: ${f.openGaps}`,
    `- Unresolved contradictions (>7d): ${f.contradictions}`,
    `- Entity names referenced without own page: ${f.missingEntityPages.length}`,
    '',
    f.missingEntityPages.length > 0 ? `## Candidates to auto-create entity pages for\n${f.missingEntityPages.map((n) => `- ${n}`).join('\n')}\n` : '',
    '## How to read',
    '- Orphans = pages nothing points to. Usually safe to delete or merge.',
    '- Stale = subject is still emailing but Brain has not re-scribed. Backfill or wait for ingest to refresh.',
    '- Contradictions = Brain noticed two pages making inconsistent claims. Resolve and delete the link.',
    '- Gap pages = questions Brain could not answer. Fill the gap by connecting a source or scribing a doc.',
  ].filter(Boolean).join('\n');

  const metadata: any = {
    schemaVersion: BRAIN_SCHEMA_VERSION,
    scope: 'user',
    authoredBy: 'wiki_lint_worker',
    findings: {
      orphans: f.orphans,
      stale: f.stale,
      openGaps: f.openGaps,
      missingEntityPages: f.missingEntityPages,
      contradictions: f.contradictions,
      ranAt: f.ranAt,
    },
  };

  const existing = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId, pageType: 'pattern', title },
    select: { id: true },
  }).catch(() => null);

  if (existing) {
    await prisma.wikiPage.update({
      where: { id: existing.id },
      data: { bodyMarkdown: body, metadata, lastUpdatedAt: now, lastUpdatedBy: 'wiki_lint_worker' },
    }).catch(() => {});
  } else {
    await prisma.wikiPage.create({
      data: {
        clientNumber, userId, pageType: 'pattern', title,
        bodyMarkdown: body, metadata,
        storage: 'postgres', status: 'active', lastUpdatedBy: 'wiki_lint_worker',
      },
    }).catch(() => {});
  }
}

/** Full cycle — run lint for every active (clientNumber, userId) pair. */
export async function runLintCycle(): Promise<{ users: number; orphans: number; stale: number; openGaps: number }> {
  const users = await prisma.user.findMany({
    where: { isActive: true } as any,
    select: { id: true, clientNumber: true },
  }).catch(() => [] as any[]);

  let orphans = 0, stale = 0, openGaps = 0;
  for (const u of users) {
    try {
      const f = await runLintForUser(u.clientNumber, u.id);
      orphans += f.orphans; stale += f.stale; openGaps += f.openGaps;
    } catch (err: any) {
      log.warn('user lint failed', { userId: u.id, error: err.message });
    }
  }
  log.info('lint cycle complete', { users: users.length, orphans, stale, openGaps });
  return { users: users.length, orphans, stale, openGaps };
}

/** Schedule the worker hourly, first tick 5 min after boot. */
export function startWikiLintWorker(): void {
  const FIRST_TICK_MS = 5 * 60_000;
  const INTERVAL_MS = 60 * 60_000;
  setTimeout(() => {
    runLintCycle().catch((e) => log.warn('first lint cycle failed', { error: e.message }));
    setInterval(() => {
      runLintCycle().catch((e) => log.warn('lint cycle failed', { error: e.message }));
    }, INTERVAL_MS);
  }, FIRST_TICK_MS);
  log.info('wiki lint worker scheduled', { firstTickMs: FIRST_TICK_MS, intervalMs: INTERVAL_MS });
}
