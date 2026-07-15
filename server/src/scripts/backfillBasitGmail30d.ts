/**
 * One-off: pull the last 30 days of Gmail for Basit (userId=1) and
 * re-run triage + sender wiki scribing so his wiki actually reflects his
 * mailbox. Uses the direct gmailService to bypass the circuit breaker's
 * 15s cap (we may fetch up to 500 messages).
 */
import prisma from '../db/prisma';
import { getInbox } from '../services/gmailService';
import { ingest } from '../services/feed/feedIngestionService';

const BASIT_USER_ID = 1;
const MAX = 500;

function ymdDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  const u = await prisma.user.findUnique({
    where: { id: BASIT_USER_ID },
    select: { id: true, email: true, clientNumber: true, integrationStatus: true, integrationProvider: true },
  });
  if (!u) { console.error('Basit user not found'); process.exit(1); }
  if (u.integrationProvider !== 'google' || u.integrationStatus !== 'active') {
    console.error(`Basit Google integration not active (provider=${u.integrationProvider}, status=${u.integrationStatus})`);
    process.exit(1);
  }

  const q = `after:${ymdDaysAgo(30)} in:inbox`;
  console.log(`Query: "${q}"  For user=${u.email} (userId=${u.id})`);

  const { emails, error } = await getInbox(u.id, MAX, q);
  if (error) { console.error('getInbox error:', error); process.exit(1); }
  console.log(`Fetched ${emails.length} messages from Gmail`);

  let ingested = 0, dup = 0, err = 0;
  const fahim: string[] = [];
  for (const e of emails) {
    if (/fahim|warraich/i.test(`${e.from ?? ''} ${e.subject ?? ''} ${e.snippet ?? ''}`)) {
      fahim.push(`  ${e.date} · ${e.from} · ${e.subject}`);
    }
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
    } catch { err++; }
  }
  console.log(`ingest: new=${ingested} dup=${dup} err=${err}`);
  if (fahim.length) {
    console.log(`\nFahim matches in fetched Gmail (${fahim.length}):`);
    console.log(fahim.join('\n'));
  } else {
    console.log('\nNo Fahim matches in the last 30 days of Basit\'s Gmail.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(0), 2000).unref());
