/**
 * scripts/scribeBackfillEmails.ts
 *
 * Phase 2 of the queue/archive split. Before the pruner can safely
 * trim feed_events, every Gmail feed_event must have a corresponding
 * wiki_pages email_message row in scribe. This script enforces that
 * invariant: it walks feed_events for a tenant (or the whole DB) and
 * creates scribe rows for any that are missing one.
 *
 * Why we don't just call ingestEmailBody (which fetches from Gmail):
 *   - Gmail auth may be invalid_grant for the user (token revoked /
 *     consent screen in Testing mode + 7-day rotation)
 *   - We don't want a backfill to be blocked by upstream OAuth state
 *
 * So we build the scribe row from feed_events.rawPayload directly:
 *   - Subject from payload.subject (Gmail) / payload.summary / payload.title
 *   - Body from payload.body / payload.snippet (whatever the poller
 *     captured at ingest time)
 *   - Headers (from/to/cc/date) from payload if present
 *
 * This means scribe rows backfilled this way may have shorter bodies
 * than ones written by ingestEmailBody (which fetches format=full from
 * Gmail). That's an acceptable trade — we'd rather have a shorter
 * archive row than no archive row at all.
 *
 * Usage:
 *   # Backfill one tenant + user
 *   npx tsx src/scripts/scribeBackfillEmails.ts <userEmail>
 *
 *   # Backfill all users (CAREFUL on prod — runs against everyone)
 *   npx tsx src/scripts/scribeBackfillEmails.ts --all
 *
 * Prints per-user counters: scanned, alreadyScribed, created, errors.
 */
import prisma from '../db/prisma';
import { BRAIN_SCHEMA_VERSION } from '../services/knowledge/brainSchema';

interface BackfillStats {
  scanned: number;
  alreadyScribed: number;
  created: number;
  errors: number;
}

async function backfillForUser(clientNumber: string, userId: number, userEmail: string): Promise<BackfillStats> {
  const stats: BackfillStats = { scanned: 0, alreadyScribed: 0, created: 0, errors: 0 };

  // Pull every Gmail feed_event for this user. Page through to avoid
  // OOM on tenants with very long history.
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
      // Gmail message id lives in payload.id or payload.messageId (varies
      // by adapter version). sourceId is the canonical fallback.
      const gmailMessageId = String(p.id ?? p.messageId ?? ev.sourceId ?? '').trim();
      if (!gmailMessageId) {
        // Without a message id we can't dedupe across runs — skip.
        continue;
      }

      // Existence check: any wiki_page (clientNumber + pageType +
      // metadata.gmailMessageId) marks this email as already scribed.
      // We use $queryRawUnsafe because metadata is jsonb and Prisma's
      // findFirst lacks a clean path operator for it.
      const exists = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM wiki_pages
          WHERE client_number = $1
            AND user_id = $2
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
        const title = `${dateIso} · ${subject}`.slice(0, 300);

        const bodyParts: string[] = [];
        bodyParts.push(`# ${subject}`);
        bodyParts.push('');
        bodyParts.push(`**From:** ${from || ev.senderEmail || '(unknown)'}`);
        if (to) bodyParts.push(`**To:** ${to}`);
        if (cc) bodyParts.push(`**Cc:** ${cc}`);
        bodyParts.push(`**Date:** ${date}`);
        bodyParts.push(`**Gmail message ID:** \`${gmailMessageId}\``);
        bodyParts.push(`**Backfilled from feed_events:** \`${ev.id}\``);
        bodyParts.push('');
        bodyParts.push('## Body');
        bodyParts.push(bodyText || '(body not captured at ingest — backfilled from snippet only)');
        const body = bodyParts.join('\n');

        const metadata = {
          schemaVersion: BRAIN_SCHEMA_VERSION,
          scope: 'user',
          authoredBy: 'scribe_backfill',
          gmailMessageId,
          threadId,
          messageIdHeader,
          inReplyTo,
          references,
          feedEventId: ev.id,
          senderEmail: ev.senderEmail,
          senderName: ev.senderName,
          subject,
          from, to, cc, date,
          bodyChars: bodyText.length,
          backfilled: true,
        };

        await prisma.wikiPage.create({
          data: {
            clientNumber, userId,
            pageType: 'email_message', title,
            bodyMarkdown: body,
            metadata,
            storage: 'postgres', status: 'active', sourceCount: 1,
            lastUpdatedBy: 'scribe_backfill',
            lastUpdatedAt: ev.createdAt,
          },
        });
        stats.created += 1;
      } catch (err: any) {
        stats.errors += 1;
        if (stats.errors <= 5) {
          console.error(`  [error] feedEvent=${ev.id}: ${err.message}`);
        }
      }
    }

    process.stdout.write(`  ${userEmail}: scanned=${stats.scanned} created=${stats.created} alreadyScribed=${stats.alreadyScribed} errors=${stats.errors}\r`);
    offset += events.length;
    if (events.length < PAGE) break;
  }
  process.stdout.write('\n');
  return stats;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: npx tsx src/scripts/scribeBackfillEmails.ts <userEmail | --all>');
    process.exit(1);
  }

  let users: Array<{ id: number; email: string; clientNumber: string }>;
  if (arg === '--all') {
    users = await prisma.user.findMany({
      where: { isActive: true } as any,
      select: { id: true, email: true, clientNumber: true },
    }) as any[];
    console.log(`Backfilling ${users.length} users...`);
  } else {
    const u = await prisma.user.findFirst({
      where: { email: arg } as any,
      select: { id: true, email: true, clientNumber: true },
    }) as any;
    if (!u) {
      console.error(`No user with email=${arg}`);
      process.exit(1);
    }
    users = [u];
  }

  const totals: BackfillStats = { scanned: 0, alreadyScribed: 0, created: 0, errors: 0 };
  for (const u of users) {
    console.log(`\n${u.email} (id=${u.id}, client=${u.clientNumber})`);
    const stats = await backfillForUser(u.clientNumber, u.id, u.email);
    totals.scanned += stats.scanned;
    totals.alreadyScribed += stats.alreadyScribed;
    totals.created += stats.created;
    totals.errors += stats.errors;
  }

  console.log(`\n--- Total ---`);
  console.log(`scanned         = ${totals.scanned}`);
  console.log(`alreadyScribed  = ${totals.alreadyScribed}`);
  console.log(`created         = ${totals.created}`);
  console.log(`errors          = ${totals.errors}`);

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
