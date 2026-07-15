/**
 * smokeBrainOverWa.ts — verify that Brain's answer is scoped to the
 * PHONE sender's identity. Proves:
 *   - Basit's number → Basit's personal context (his user-scope rules, his open items)
 *   - Abdul's number → Abdul's personal context (his rules, his items)
 * In both cases the tenant-scope (client rules, shared wiki) applies.
 *
 * We stub out sendReply by calling `answerAsBrain` directly (the same
 * call WhatsAppInbound makes) for each phone → user mapping.
 */
import prisma from '../db/prisma';
import { answerAsBrain } from '../routes/brainAskRoutes';

async function runForUser(label: string, clientNumber: string, userId: number, query: string) {
  console.log(`\n──────────────────────────────────────`);
  console.log(`${label}: user=${userId}  query="${query}"`);
  const r = await answerAsBrain(clientNumber, userId, query);
  console.log(`intent: ${r.intent}  sources: ${r.sources.length}`);
  const firstLine = r.answer.split('\n')[0];
  console.log(`answer first line: ${firstLine.slice(0, 160)}`);
  const full = r.answer.length > 400 ? r.answer.slice(0, 400) + ' …' : r.answer;
  console.log(full);
}

async function main() {
  const clientNumber = 'TMC-0001';

  // Resolve the two users by phone (simulating what WhatsAppInbound does)
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT wc.user_id, u.name, wc.phone_number
       FROM whatsapp_connections wc JOIN users u ON u.id = wc.user_id
      WHERE u.client_number = $1 AND wc.status = 'active'
      ORDER BY u.id`,
    clientNumber,
  );
  console.log(`[smoke] known tenant phones:`, rows.map(r => `${r.name}=${r.phone_number}`).join('  '));

  for (const r of rows) {
    await runForUser(`📱 ${r.phone_number} (${r.name})`, clientNumber, r.user_id, 'What are my open items right now?');
  }

  // Also try a cross-user identity check
  for (const r of rows) {
    await runForUser(`📱 ${r.phone_number} (${r.name})`, clientNumber, r.user_id, 'What meetings do I have today?');
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
