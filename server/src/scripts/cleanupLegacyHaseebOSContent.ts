/**
 * Cleanup legacy HaseebOS self-mails / auto-generated artefacts from Brain's
 * knowledge base. These are emails authored by the pre-rebrand version of
 * this very product (subjects like "HaseebOS Morning Briefing", "HaseebOS
 * Open Items", etc.) that MD never wrote and that pollute Brain Chat
 * retrieval with stale system noise.
 *
 * Dry-run by default. Pass --apply to actually delete.
 *
 *   npx ts-node src/scripts/cleanupLegacyHaseebOSContent.ts          # counts only
 *   npx ts-node src/scripts/cleanupLegacyHaseebOSContent.ts --apply  # actually delete
 *
 * Matches anything where 'HaseebOS' appears (case-insensitive) in either
 * the title/subject or the metadata.senderName. Restricted to:
 *   - wiki_pages.page_type = 'email_message'
 *   - feed_events.source_type = 'gmail'
 *
 * We deliberately do NOT touch sender pages or topic pages — only the
 * email-message rows themselves. If a sender's persistent wiki page
 * accumulated facts from these emails those facts will rot naturally on
 * the next scribe pass without us blowing away the whole page.
 */
import prisma from '../db/prisma';

async function main() {
  const apply = process.argv.includes('--apply');
  const pattern = '%HaseebOS%';

  const wikiCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count
       FROM wiki_pages
      WHERE page_type = 'email_message'
        AND status != 'deleted'
        AND (
          title ILIKE $1
          OR metadata->>'senderName' ILIKE $1
          OR metadata->>'senderEmail' ILIKE $1
        )`,
    pattern,
  );
  const feedCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count
       FROM feed_events
      WHERE source_type = 'gmail'
        AND (
          (raw_payload->>'subject') ILIKE $1
          OR sender_name ILIKE $1
          OR sender_email ILIKE $1
        )`,
    pattern,
  );

  const wikiN = Number(wikiCount[0]?.count ?? 0n);
  const feedN = Number(feedCount[0]?.count ?? 0n);
  console.log(`wiki_pages email_message matching HaseebOS: ${wikiN}`);
  console.log(`feed_events gmail matching HaseebOS:       ${feedN}`);

  if (!apply) {
    const sample = await prisma.$queryRawUnsafe<Array<{ id: string; title: string | null }>>(
      `SELECT id, title FROM wiki_pages
        WHERE page_type = 'email_message' AND status != 'deleted'
          AND title ILIKE $1
        ORDER BY created_at DESC
        LIMIT 10`,
      pattern,
    );
    if (sample.length > 0) {
      console.log('\nSample titles (most recent 10):');
      for (const s of sample) console.log(`  - ${s.title}`);
    }
    console.log('\nDry run — pass --apply to delete.');
    return;
  }

  console.log('\nApplying deletes…');
  const wikiDel = await prisma.$executeRawUnsafe(
    `DELETE FROM wiki_pages
      WHERE page_type = 'email_message'
        AND status != 'deleted'
        AND (
          title ILIKE $1
          OR metadata->>'senderName' ILIKE $1
          OR metadata->>'senderEmail' ILIKE $1
        )`,
    pattern,
  );
  const feedDel = await prisma.$executeRawUnsafe(
    `DELETE FROM feed_events
      WHERE source_type = 'gmail'
        AND (
          (raw_payload->>'subject') ILIKE $1
          OR sender_name ILIKE $1
          OR sender_email ILIKE $1
        )`,
    pattern,
  );
  console.log(`Deleted wiki_pages:  ${wikiDel}`);
  console.log(`Deleted feed_events: ${feedDel}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
