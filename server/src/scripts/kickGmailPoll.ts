import prisma from '../db/prisma';
import { pollAllActiveUsers } from '../jobs/gmailFeedPoller';
import { pollAllTenants } from '../jobs/genericFeedPoller';

async function main() {
  console.log('=== legacy pollAllActiveUsers (integration_* path) ===');
  const r1 = await pollAllActiveUsers();
  console.log(JSON.stringify(r1, null, 2));

  console.log('\n=== generic pollAllTenants (adapter path) ===');
  const r2 = await pollAllTenants();
  console.log(JSON.stringify(r2, null, 2));

  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const haseebGmailToday = await prisma.feedEvent.count({
    where: { clientNumber: 'TMC-0001', userId: 5, sourceType: 'gmail', createdAt: { gte: today0 } } as any,
  });
  console.log(`\nHaseeb gmail feed_events today (user_id=5): ${haseebGmailToday}`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
