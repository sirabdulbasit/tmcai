/**
 * smokeInstructions.ts — end-to-end check of the Instructions layer
 * across both scopes (client-wide + per-user).
 *
 *   1. Admin creates a client-scope rule.
 *   2. User A creates a user-scope rule.
 *   3. User B (different user in same tenant) lists instructions and
 *      must see the client-scope rule but NOT user A's rule.
 *   4. Render the instruction block as the composer would and verify
 *      the block shows both "Client rules" and "User rules" sections.
 *
 * Usage:  npx ts-node src/scripts/smokeInstructions.ts <clientNumber> <adminUserId> <userAId> <userBId>
 */
import prisma from '../db/prisma';
import {
  createInstructionFromText,
  getActiveInstructions,
  renderInstructionsBlock,
} from '../services/knowledge/instructionService';

async function main() {
  const clientNumber = process.argv[2] ?? 'TMC-0001';
  const adminUserId = Number(process.argv[3] ?? 1);
  const userAId = Number(process.argv[4] ?? adminUserId);
  const userBId = Number(process.argv[5] ?? userAId);

  const clientSample = process.argv[6] ?? 'All client emails must be acknowledged within 4 hours';
  const userSample = process.argv[7] ?? "Always delegate Raazia's emails to Asad";

  console.log(`[smoke] tenant=${clientNumber}  admin=${adminUserId}  userA=${userAId}  userB=${userBId}`);

  console.log(`\n[smoke] admin creating CLIENT-scope rule: "${clientSample}"`);
  const c = await createInstructionFromText(clientNumber, adminUserId, clientSample, 'client');
  console.log('[smoke] client rule id =', c?.id, ' scope =', c?.scope, ' kind =', c?.structured.kind);

  console.log(`\n[smoke] userA creating USER-scope rule: "${userSample}"`);
  const u = await createInstructionFromText(clientNumber, userAId, userSample, 'user');
  console.log('[smoke] user rule id =', u?.id, ' scope =', u?.scope, ' kind =', u?.structured.kind);

  console.log('\n[smoke] listing for userA (author of user rule) — expect BOTH:');
  const activeA = await getActiveInstructions(clientNumber, userAId, 30);
  for (const a of activeA) console.log(`  [${a.scope}] [${a.kind}] ${a.title}`);

  console.log('\n[smoke] listing for userB (different user) — expect CLIENT only:');
  const activeB = await getActiveInstructions(clientNumber, userBId, 30);
  for (const a of activeB) console.log(`  [${a.scope}] [${a.kind}] ${a.title}`);

  const userAHasBoth = activeA.some((a) => a.scope === 'client') && activeA.some((a) => a.scope !== 'client');
  const userBHasClient = activeB.some((a) => a.scope === 'client');
  const userBHasUserA = activeB.some((a) => a.id === u?.id);
  console.log('\n[smoke] ASSERTIONS:');
  console.log('  userA sees both scopes     :', userAHasBoth);
  console.log('  userB sees the client rule :', userBHasClient);
  console.log('  userB LEAKS userA\'s rule   :', userBHasUserA, userBHasUserA ? 'FAIL' : 'OK');

  console.log('\n[smoke] rendered composer block for userB (no personal rule):\n');
  console.log(renderInstructionsBlock(activeB) || '(empty)');

  console.log('\n[smoke] rendered composer block for userA (both sections):\n');
  console.log(renderInstructionsBlock(activeA) || '(empty)');

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] failed:', err);
  process.exit(1);
});
