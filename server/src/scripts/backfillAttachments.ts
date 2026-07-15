/**
 * One-off: walk recent Gmail feed_events for a user and create
 * attachment_doc wiki pages for every attachment. Idempotent — rerunning
 * just overwrites existing pages with fresh extracted text.
 *
 * Usage:
 *   npx ts-node src/scripts/backfillAttachments.ts [userId=1] [days=30]
 */
import prisma from '../db/prisma';
import { ingestMessageAttachments } from '../services/knowledge/attachmentWikiService';

async function main() {
  const userId = Number(process.argv[2] ?? 1);
  const days = Number(process.argv[3] ?? 30);
  const since = new Date(Date.now() - days * 86_400_000);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, clientNumber: true },
  });
  if (!user) { console.error('user not found'); process.exit(1); }

  const events = await prisma.feedEvent.findMany({
    where: {
      clientNumber: user.clientNumber, userId: user.id,
      sourceType: 'gmail',
      createdAt: { gte: since },
    },
    select: { id: true, sourceId: true, rawPayload: true, senderEmail: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`Walking ${events.length} Gmail feed_events for user=${user.email} (last ${days}d)`);

  let totalAttachments = 0, totalProcessed = 0, totalSkipped = 0, messagesWithAttachments = 0;
  for (const [i, ev] of events.entries()) {
    const p: any = ev.rawPayload ?? {};
    const messageId = p.messageId ?? p.gmailMessageId ?? ev.sourceId;
    if (!messageId) continue;
    const r = await ingestMessageAttachments({
      clientNumber: user.clientNumber,
      userId: user.id,
      senderEmail: ev.senderEmail ?? null,
      gmailMessageId: messageId,
      feedEventId: ev.id,
      subject: p.subject ?? null,
      receivedAt: ev.createdAt,
    });
    if (r.total > 0) {
      messagesWithAttachments++;
      totalAttachments += r.total;
      totalProcessed += r.processed;
      totalSkipped += r.skipped;
      console.log(`  [${i + 1}/${events.length}] msg=${messageId.slice(0, 10)} from=${ev.senderEmail} attachments=${r.total} processed=${r.processed} skipped=${r.skipped}`);
    }
  }

  console.log(`\nDone. ${messagesWithAttachments} messages had attachments · total=${totalAttachments} processed=${totalProcessed} skipped=${totalSkipped}`);
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(0), 2000).unref());
