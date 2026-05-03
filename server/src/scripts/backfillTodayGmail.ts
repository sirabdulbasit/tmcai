/**
 * One-off backfill — pull all of today's Gmail for every connected user
 * so the Day Brief volume count matches the user's actual inbox.
 *
 * Uses the Gmail query `after:YYYY/MM/DD` to scope to today, then pages up
 * to 500 messages. Each feed_event is stamped with userId so per-user
 * scoping in morningBriefService works.
 */
import prisma from '../db/prisma';
// Bypass the circuit-breaker-wrapped adapter — it has a 15s timeout that
// doesn't fit large one-off fetches. Call the service directly.
import { getInbox } from '../services/gmailService';
import { ingest } from '../services/feed/feedIngestionService';

const MAX = 100;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      integrationProvider: 'google',
      integrationStatus: 'active',
    },
    select: { id: true, email: true, clientNumber: true },
  });

  const q = `after:${today()} in:inbox`;
  console.log(`Query: "${q}"  Users with active Google: ${users.length}`);

  for (const u of users) {
    const { emails, error } = await getInbox(u.id, MAX, q);
    if (error) { console.warn(`  user=${u.email}  ERROR: ${error}`); continue; }
    let ingested = 0, dup = 0, err = 0;
    for (const e of emails) {
      try {
        const r = await ingest({
          clientNumber: u.clientNumber,
          userId: u.id,
          sourceType: 'gmail',
          sourceId: e.id,
          sender: { email: e.from },
          payload: { userId: u.id, threadId: e.threadId, subject: e.subject, from: e.from, snippet: e.snippet, date: e.date },
        });
        if (r.status === 'new') ingested++;
        else if (r.status === 'duplicate') dup++;
        else err++;
      } catch (e: any) { err++; }
    }
    console.log(`  user=${u.email}  fetched=${emails.length}  ingested=${ingested}  dup=${dup}  err=${err}`);
  }

  // Report per-user totals for today
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const rows = await prisma.feedEvent.groupBy({
    by: ['userId'],
    where: { clientNumber: 'TMC-0001', sourceType: 'gmail', createdAt: { gte: today0 } } as any,
    _count: true,
  });
  console.log('Today feed_events by user:', rows);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
