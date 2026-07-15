/**
 * One-off: walk every Gmail feed_event and scribe the full body into
 * an email_message wiki page. Idempotent — the ingest service upserts
 * by (clientNumber, userId, 'email_message', title).
 */
import prisma from '../db/prisma';
import { ingestEmailBody } from '../services/knowledge/emailBodyIngestService';

const BATCH_DELAY_MS = 250;

async function main() {
  const userId = Number(process.argv[2] ?? 1);
  const days = Number(process.argv[3] ?? 90);
  const since = new Date(Date.now() - days * 86_400_000);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { clientNumber: true, email: true },
  });
  if (!user) { console.error('user not found'); process.exit(1); }

  const events = await prisma.feedEvent.findMany({
    where: {
      clientNumber: user.clientNumber,
      userId,
      sourceType: 'gmail',
      createdAt: { gte: since },
      senderEmail: { not: null },
    },
    select: { id: true, sourceId: true, rawPayload: true, senderEmail: true, senderName: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`Walking ${events.length} Gmail feed_events for ${user.email} (last ${days}d).`);

  let ok = 0, skipped = 0, err = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const p: any = ev.rawPayload ?? {};
    const messageId = p.messageId ?? p.gmailMessageId ?? ev.sourceId;
    if (!messageId) { skipped++; continue; }
    try {
      const pageId = await ingestEmailBody({
        clientNumber: user.clientNumber,
        userId,
        gmailMessageId: messageId,
        feedEventId: ev.id,
        senderEmail: ev.senderEmail ?? null,
        senderName: ev.senderName ?? null,
        subject: p.subject ?? null,
        receivedAt: ev.createdAt,
      });
      if (pageId) ok++; else skipped++;
    } catch { err++; }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${events.length}  ok=${ok} skipped=${skipped} err=${err}`);
    if (BATCH_DELAY_MS) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  console.log(`\nDone. Scribed ${ok} email bodies, skipped ${skipped}, errored ${err}.`);
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(0), 2000).unref());
