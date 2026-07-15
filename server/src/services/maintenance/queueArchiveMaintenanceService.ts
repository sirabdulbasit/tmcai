/**
 * Queue/archive maintenance — shared service.
 *
 * Two operations called from both:
 *   - scripts/scribeBackfillEmails.ts and scripts/feedEventsPruner.ts
 *     (manual one-off runs from the CLI)
 *   - server.ts schedulers (nightly backfill + pruner across all users)
 *
 * Operations:
 *
 *   backfillUserScribe(clientNumber, userId)
 *     Walks every Gmail feed_event for the user; writes a wiki_pages
 *     email_message row for any that's missing one. Idempotent — safe
 *     to run repeatedly. Uses raw_payload directly so it works even
 *     when the user's Gmail OAuth is invalid_grant.
 *
 *   pruneUserFeedEvents(clientNumber, userId, { apply })
 *     Removes feed_events that are EITHER older than 30 days OR have
 *     a terminal decision_log row. Safety: only deletes if a scribe
 *     sibling exists. Default apply=false (dry-run).
 *
 * Both are scoped to a single (clientNumber, userId) so the caller can
 * iterate users in parallel or sequentially. Scripts pass one user;
 * the cron passes every active user.
 *
 * No assumptions about which user — works identically for any user
 * with any Gmail history (existing, new, ones we haven't met yet).
 */
import prisma from '../../db/prisma';
import { BRAIN_SCHEMA_VERSION } from '../knowledge/brainSchema';

export interface BackfillStats {
  scanned: number;
  alreadyScribed: number;
  created: number;
  errors: number;
}

export interface PruneStats {
  scanned: number;
  eligibleByAge: number;
  eligibleByDecision: number;
  blockedNoScribe: number;
  deleted: number;
}

const TERMINAL_DECISIONS = ['approved', 'delegated', 'snoozed', 'dismissed', 'overrode'];

/**
 * Ensure every Gmail feed_event for this user has a matching
 * wiki_pages email_message. Pages through feed_events 200 at a time
 * to keep memory bounded on tenants with long histories.
 */
export async function backfillUserScribe(
  clientNumber: string,
  userId: number,
  opts: { onProgress?: (s: BackfillStats) => void } = {},
): Promise<BackfillStats> {
  const stats: BackfillStats = { scanned: 0, alreadyScribed: 0, created: 0, errors: 0 };

  const PAGE = 200;
  let offset = 0;
  while (true) {
    const events = await prisma.feedEvent.findMany({
      where: { clientNumber, userId, sourceType: 'gmail' } as any,
      select: {
        id: true, sourceId: true, senderEmail: true, senderName: true,
        rawPayload: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: PAGE,
    });
    if (events.length === 0) break;

    for (const ev of events) {
      stats.scanned += 1;
      const p: any = ev.rawPayload ?? {};
      const gmailMessageId = String(p.id ?? p.messageId ?? ev.sourceId ?? '').trim();
      if (!gmailMessageId) continue;

      // Existence by gmailMessageId in metadata
      const exists = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM wiki_pages
          WHERE client_number = $1 AND user_id = $2
            AND page_type = 'email_message'
            AND metadata->>'gmailMessageId' = $3
          LIMIT 1`,
        clientNumber, userId, gmailMessageId,
      ).catch(() => [] as Array<{ id: string }>);
      if (exists.length > 0) {
        stats.alreadyScribed += 1;
        continue;
      }

      try {
        const subject = String(p.subject ?? p.summary ?? p.title ?? p.eventName ?? '(no subject)').slice(0, 220);
        const bodyText = String(p.body ?? p.snippet ?? p.description ?? '').slice(0, 40000);
        const date = String(p.date ?? p.headers?.Date ?? ev.createdAt.toISOString());
        const from = String(p.from ?? p.headers?.From ?? `${ev.senderName ?? ''} <${ev.senderEmail ?? ''}>`.trim());
        const to = String(p.to ?? p.headers?.To ?? '');
        const cc = String(p.cc ?? p.headers?.Cc ?? '');
        const threadId = p.threadId ?? null;
        const messageIdHeader = p.headers?.['Message-ID'] ?? p.headers?.['Message-Id'] ?? null;
        const inReplyTo = p.headers?.['In-Reply-To'] ?? null;
        const references = p.headers?.References ?? null;

        const dateIso = ev.createdAt.toISOString().slice(0, 10);
        const idSuffix = gmailMessageId.slice(-8);
        const title = `${dateIso} · ${subject} · ${idSuffix}`.slice(0, 300);

        // Defensive: title collision (different ingest path wrote it
        // already). Skip if so — never throw on the unique constraint.
        const titleClash = await prisma.wikiPage.findFirst({
          where: { clientNumber, userId, pageType: 'email_message', title } as any,
          select: { id: true },
        }).catch(() => null);
        if (titleClash) {
          stats.alreadyScribed += 1;
          continue;
        }

        const body = [
          `# ${subject}`, '',
          `**From:** ${from || ev.senderEmail || '(unknown)'}`,
          ...(to ? [`**To:** ${to}`] : []),
          ...(cc ? [`**Cc:** ${cc}`] : []),
          `**Date:** ${date}`,
          `**Gmail message ID:** \`${gmailMessageId}\``,
          `**Backfilled from feed_events:** \`${ev.id}\``,
          '', '## Body',
          bodyText || '(body not captured at ingest — backfilled from snippet only)',
        ].join('\n');

        const metadata = {
          schemaVersion: BRAIN_SCHEMA_VERSION,
          scope: 'user',
          authoredBy: 'scribe_backfill',
          gmailMessageId, threadId, messageIdHeader, inReplyTo, references,
          feedEventId: ev.id,
          senderEmail: ev.senderEmail, senderName: ev.senderName,
          subject, from, to, cc, date,
          bodyChars: bodyText.length,
          backfilled: true,
        };

        await prisma.wikiPage.create({
          data: {
            clientNumber, userId,
            pageType: 'email_message', title,
            bodyMarkdown: body, metadata,
            storage: 'postgres', status: 'active', sourceCount: 1,
            lastUpdatedBy: 'scribe_backfill',
            lastUpdatedAt: ev.createdAt,
          },
        });
        stats.created += 1;
      } catch {
        stats.errors += 1;
      }
    }

    opts.onProgress?.(stats);
    offset += events.length;
    if (events.length < PAGE) break;
  }
  return stats;
}

/**
 * Trim feed_events down to the active queue: anything older than 30
 * days OR terminally decided is deleted, but ONLY if a scribe sibling
 * exists (so no data is lost). Default dry-run — pass apply=true to
 * actually delete.
 */
export async function pruneUserFeedEvents(
  clientNumber: string,
  userId: number,
  opts: { apply?: boolean; onProgress?: (s: PruneStats) => void } = {},
): Promise<PruneStats> {
  const apply = !!opts.apply;
  const stats: PruneStats = {
    scanned: 0, eligibleByAge: 0, eligibleByDecision: 0,
    blockedNoScribe: 0, deleted: 0,
  };

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const decided = await prisma.decisionLog.findMany({
    where: {
      clientNumber, userId,
      userDecision: { in: TERMINAL_DECISIONS } as any,
      entityId: { not: null } as any,
    } as any,
    select: { entityId: true },
  }).catch(() => [] as Array<{ entityId: string | null }>);
  const decidedSet = new Set(decided.map((d) => d.entityId).filter(Boolean) as string[]);

  const PAGE = 200;
  let offset = 0;
  while (true) {
    const events = await prisma.feedEvent.findMany({
      where: { clientNumber, userId, sourceType: 'gmail' } as any,
      select: { id: true, sourceId: true, rawPayload: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      skip: offset,
      take: PAGE,
    });
    if (events.length === 0) break;

    for (const ev of events) {
      stats.scanned += 1;
      const olderThan30d = ev.createdAt < cutoff;
      const isDecided = decidedSet.has(ev.id);
      if (!olderThan30d && !isDecided) continue;
      if (olderThan30d) stats.eligibleByAge += 1;
      if (isDecided) stats.eligibleByDecision += 1;

      const p: any = ev.rawPayload ?? {};
      const gmailMessageId = String(p.id ?? p.messageId ?? ev.sourceId ?? '').trim();
      if (!gmailMessageId) {
        stats.blockedNoScribe += 1;
        continue;
      }
      const scribed = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM wiki_pages
          WHERE client_number = $1 AND user_id = $2
            AND page_type = 'email_message'
            AND metadata->>'gmailMessageId' = $3
          LIMIT 1`,
        clientNumber, userId, gmailMessageId,
      ).catch(() => [] as Array<{ id: string }>);
      if (scribed.length === 0) {
        stats.blockedNoScribe += 1;
        continue;
      }

      if (apply) {
        await prisma.feedEvent.delete({ where: { id: ev.id } }).catch(() => null);
      }
      stats.deleted += 1;
    }

    opts.onProgress?.(stats);
    offset += events.length;
    if (events.length < PAGE) break;
  }
  return stats;
}

/**
 * Iterate every active user and run a per-user job in sequence.
 * Used by the nightly schedulers in server.ts. Sequential (not
 * parallel) on purpose — these are background jobs and we'd rather
 * be slow than DoS our own DB.
 */
export async function forEachActiveUser<T>(
  fn: (clientNumber: string, userId: number, email: string) => Promise<T>,
): Promise<Array<{ userId: number; email: string; clientNumber: string; result: T | null; error?: string }>> {
  const users = await prisma.user.findMany({
    where: { isActive: true } as any,
    select: { id: true, email: true, clientNumber: true },
  }) as Array<{ id: number; email: string; clientNumber: string }>;

  const out: Array<{ userId: number; email: string; clientNumber: string; result: T | null; error?: string }> = [];
  for (const u of users) {
    try {
      const result = await fn(u.clientNumber, u.id, u.email);
      out.push({ userId: u.id, email: u.email, clientNumber: u.clientNumber, result });
    } catch (err: any) {
      out.push({ userId: u.id, email: u.email, clientNumber: u.clientNumber, result: null, error: err?.message ?? String(err) });
    }
  }
  return out;
}
