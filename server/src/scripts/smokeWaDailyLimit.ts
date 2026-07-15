/**
 * smokeWaDailyLimit.ts — verifies the atomic-claim daily-limit fix.
 *
 * Tests the SQL race-prevention directly (no provider stub needed):
 *   1. Set daily_limit=3, messages_today=0
 *   2. Fire N parallel atomic claims (the same UPDATE the manager does)
 *   3. Confirm exactly daily_limit succeed, none overshoot
 *   4. Test the refund decrement
 */
import prisma from '../db/prisma';
import { runWithoutTenant } from '../db/tenantContext';

const CLAIM_SQL = `
  UPDATE whatsapp_config
     SET messages_today      = messages_today + 1,
         messages_this_month = messages_this_month + 1,
         last_message_at     = NOW(),
         updated_at          = NOW()
   WHERE client_number = $1
     AND messages_today < daily_limit
   RETURNING messages_today AS new_count
`;

const REFUND_SQL = `
  UPDATE whatsapp_config
     SET messages_today      = GREATEST(messages_today - 1, 0),
         messages_this_month = GREATEST(messages_this_month - 1, 0),
         updated_at          = NOW()
   WHERE client_number = $1
`;

async function tryClaim(clientNumber: string): Promise<boolean> {
  const r = await prisma.$queryRawUnsafe<any[]>(CLAIM_SQL, clientNumber);
  return r.length > 0;
}

async function main() {
  const clientNumber = 'TMC-0001';
  await runWithoutTenant(async () => {
    const before = (await prisma.$queryRawUnsafe<any[]>(
      `SELECT daily_limit, messages_today, messages_this_month, status FROM whatsapp_config WHERE client_number=$1`,
      clientNumber,
    ))[0];
    console.log('[smoke] before:', before);

    const STUB_LIMIT = 3;
    const PARALLEL = 12;

    // Set up: limit=3, counter=0
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_config SET daily_limit=$1, messages_today=0, messages_this_month=0 WHERE client_number=$2`,
      STUB_LIMIT, clientNumber,
    );

    console.log(`\n[claim] firing ${PARALLEL} parallel atomic-claim attempts (daily_limit=${STUB_LIMIT})…`);
    const claimResults = await Promise.all(
      Array.from({ length: PARALLEL }, () => tryClaim(clientNumber)),
    );
    const claimed = claimResults.filter(Boolean).length;
    const denied = claimResults.length - claimed;

    const afterClaim = (await prisma.$queryRawUnsafe<any[]>(
      `SELECT messages_today FROM whatsapp_config WHERE client_number=$1`, clientNumber,
    ))[0];

    console.log(`[claim] claimed=${claimed}  denied=${denied}  messages_today=${afterClaim.messages_today}`);

    // Refund test: claim 1, refund 1, confirm counter back to baseline.
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_config SET messages_today=0, messages_this_month=0 WHERE client_number=$1`,
      clientNumber,
    );
    const ok = await tryClaim(clientNumber);
    const midCount = (await prisma.$queryRawUnsafe<any[]>(
      `SELECT messages_today FROM whatsapp_config WHERE client_number=$1`, clientNumber,
    ))[0].messages_today;
    await prisma.$executeRawUnsafe(REFUND_SQL, clientNumber);
    const afterRefund = (await prisma.$queryRawUnsafe<any[]>(
      `SELECT messages_today FROM whatsapp_config WHERE client_number=$1`, clientNumber,
    ))[0].messages_today;
    console.log(`\n[refund] claim=${ok}  midCount=${midCount}  afterRefund=${afterRefund}`);

    // Refund floor — running refund 10x against count=0 must NOT go negative.
    for (let i = 0; i < 10; i++) await prisma.$executeRawUnsafe(REFUND_SQL, clientNumber);
    const floorCheck = (await prisma.$queryRawUnsafe<any[]>(
      `SELECT messages_today FROM whatsapp_config WHERE client_number=$1`, clientNumber,
    ))[0].messages_today;
    console.log(`[refund] after 10 over-refunds: messages_today=${floorCheck} (must be 0)`);

    console.log('\nASSERTIONS:');
    const a1 = claimed === STUB_LIMIT;
    const a2 = denied === PARALLEL - STUB_LIMIT;
    const a3 = afterClaim.messages_today === STUB_LIMIT;
    const a4 = ok && midCount === 1 && afterRefund === 0;
    const a5 = floorCheck === 0;
    console.log(`  ${a1 ? '✓' : '✗'} parallel claims: exactly daily_limit succeeded (${claimed}/${STUB_LIMIT})`);
    console.log(`  ${a2 ? '✓' : '✗'} parallel claims: excess attempts denied (${denied}/${PARALLEL - STUB_LIMIT})`);
    console.log(`  ${a3 ? '✓' : '✗'} no overshoot — messages_today = daily_limit (${afterClaim.messages_today})`);
    console.log(`  ${a4 ? '✓' : '✗'} refund decrements (claim=1 → refund → 0)`);
    console.log(`  ${a5 ? '✓' : '✗'} refund floor — never negative (${floorCheck})`);

    // Restore original
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_config SET daily_limit=$1, messages_today=$2, messages_this_month=$3 WHERE client_number=$4`,
      before.daily_limit, before.messages_today, before.messages_this_month, clientNumber,
    );
    console.log('\n[smoke] restored');
  });

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
