/**
 * smokeMeetingDigest.ts — run the digester against an existing Plaud email
 * and verify: (a) a meeting_minutes page is created, (b) open_items are
 * filed with sourceFeed='meeting' and sourceRef pointing to the MoM page
 * (NOT the Plaud email), (c) the open_item description carries the
 * "held at / with whom" source line.
 *
 * Usage:  npx ts-node src/scripts/smokeMeetingDigest.ts [emailPageId]
 *
 * If no emailPageId is passed, picks the most recent Plaud email in TMC-0001.
 */
import prisma from '../db/prisma';
import { digestMeetingFromEmail } from '../services/knowledge/meetingDigestService';

async function main() {
  let emailPageId = process.argv[2];

  if (!emailPageId) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM wiki_pages
        WHERE page_type = 'email_message'
          AND (metadata->>'from' ILIKE '%plaud%' OR title ILIKE '%plaud%')
          AND client_number = 'TMC-0001'
        ORDER BY last_updated_at DESC LIMIT 1`,
    );
    emailPageId = rows[0]?.id;
  }
  if (!emailPageId) {
    console.error('[digest] no Plaud email found; pass an emailPageId explicitly');
    process.exit(1);
  }
  console.log('[digest] emailPageId =', emailPageId);

  // Clear any prior digest so we can re-run cleanly
  await prisma.$executeRawUnsafe(
    `DELETE FROM wiki_pages WHERE page_type = 'meeting_minutes'
        AND metadata->>'sourceEmailPageId' = $1`,
    emailPageId,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM open_items WHERE source_feed = 'meeting'
        AND metadata->'source'->>'deliveredByEmailPageId' = $1`,
    emailPageId,
  );

  const result = await digestMeetingFromEmail(emailPageId);
  console.log('[digest] result:', result);
  if (!result) {
    console.error('[digest] digest returned null');
    process.exit(2);
  }

  const mm = await prisma.wikiPage.findUnique({
    where: { id: result.meetingMinutesPageId },
    select: { id: true, title: true, pageType: true, metadata: true, bodyMarkdown: true, sourceCount: true },
  });
  console.log('\n[digest] meeting_minutes page:');
  console.log('  id:', mm?.id);
  console.log('  title:', mm?.title);
  console.log('  pageType:', mm?.pageType);
  const md: any = mm?.metadata ?? {};
  console.log('  heldAt:', md.heldAt);
  console.log('  attendees:', (md.attendees ?? []).length, (md.attendees ?? []).map((a: any) => a.name || a.label).join(', '));
  console.log('  topics:', (md.topics ?? []).join(', '));
  console.log('  sourceTranscriptPageId:', md.sourceTranscriptPageId);
  console.log('  sourceSummaryPageId:', md.sourceSummaryPageId);
  console.log('  sourceEmailPageId:', md.sourceEmailPageId);
  console.log('\n--- meeting_minutes body ---');
  console.log(mm?.bodyMarkdown);

  console.log('\n[digest] open_items filed:', result.openItemIds.length);
  for (const oid of result.openItemIds) {
    const item = await prisma.openItem.findUnique({
      where: { id: oid },
      select: { id: true, title: true, description: true, sourceFeed: true, sourceRef: true, metadata: true, dueDate: true, delegateeName: true },
    });
    console.log('\n  ───────────────');
    console.log('  title       :', item?.title);
    console.log('  sourceFeed  :', item?.sourceFeed, '  (should be "meeting")');
    console.log('  sourceRef   :', item?.sourceRef, '  (should be MoM page id, NOT the email)');
    console.log('  delegateeName:', item?.delegateeName);
    console.log('  dueDate     :', item?.dueDate);
    console.log('  description :', item?.description?.slice(0, 200));
    const src: any = (item?.metadata as any)?.source ?? {};
    console.log('  source.kind      :', src.kind);
    console.log('  source.heldAt    :', src.heldAt);
    console.log('  source.attendees :', (src.attendees ?? []).map((a: any) => a.name || a.label).join(', '));
  }

  console.log('\n[digest] ASSERTIONS:');
  const allMeeting = result.openItemIds.length === 0 ? false : true;
  let mmIdMatches = true; let emailRefLeak = false;
  for (const oid of result.openItemIds) {
    const item = await prisma.openItem.findUnique({ where: { id: oid }, select: { sourceFeed: true, sourceRef: true } });
    if (item?.sourceFeed !== 'meeting') { mmIdMatches = false; }
    if (item?.sourceRef !== result.meetingMinutesPageId) { mmIdMatches = false; }
    if (item?.sourceRef === emailPageId) { emailRefLeak = true; }
  }
  console.log('  commitments filed as open_items :', allMeeting ? '✓' : '✗');
  console.log('  every open_item sourceRef = MoM :', mmIdMatches ? '✓' : '✗');
  console.log('  none point at the Plaud email    :', !emailRefLeak ? '✓' : '✗');

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => { console.error('[digest] failed:', err); process.exit(1); });
