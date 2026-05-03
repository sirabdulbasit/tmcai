/**
 * smokeInstructionVeto.ts — end-to-end test of the instruction veto gate.
 *
 * Scenario:
 *   1. Pick a real feed event (or synthesize one) for user A.
 *   2. Ensure no ACTIVE shadow rule matches it yet (or insert one).
 *   3. Create a user-scope standing_rule with a veto phrase action.
 *      e.g. "Ask me first before delegating Raazia's emails"
 *   4. Call findVetoForEvent — expect a veto.
 *   5. Also test: a non-vetoing instruction (plain routing) returns null.
 *   6. Also test: a global rule with no subject still vetoes.
 */
import prisma from '../db/prisma';
import {
  createInstructionFromText,
  updateInstructionStatus,
} from '../services/knowledge/instructionService';
import { findVetoForEvent, matchInstructionsForEvent } from '../services/knowledge/instructionMatcher';

async function clearTestRules(clientNumber: string, userId: number) {
  // Hard-delete any prior instructions from earlier smoke runs so the
  // title unique constraint doesn't collide. The unique key is
  // (client_number, user_id, page_type, title) and doesn't care about
  // status — archived rows still block reinsertion with the same title.
  await prisma.$executeRawUnsafe(
    `DELETE FROM wiki_pages
       WHERE client_number = $1 AND user_id = $2 AND page_type = 'instruction'
         AND (body_markdown ILIKE '%raazia%' OR body_markdown ILIKE '%exim%'
              OR body_markdown ILIKE '%never auto%' OR body_markdown ILIKE '%ask me first%'
              OR body_markdown ILIKE '%ask before%' OR body_markdown ILIKE '%require approval%')`,
    clientNumber, userId,
  );
}

async function main() {
  const clientNumber = process.argv[2] ?? 'TMC-0001';
  const userId = Number(process.argv[3] ?? 5);

  // Clear prior test rules so we test from a clean slate.
  await clearTestRules(clientNumber, userId);

  const event = {
    senderEmail: 'raazia.khan@partner.com',
    senderName: 'Raazia Khan',
    subject: 'Contract renewal terms',
    snippet: 'Following up on the updated pricing for next quarter.',
  };

  console.log('[veto] event:', event);

  // ── Case 1: non-vetoing subject-specific routing rule ──────────
  console.log('\n[veto] CASE 1 — non-vetoing routing rule "delegate Raazia\'s emails to Asad"');
  const routing = await createInstructionFromText(
    clientNumber, userId,
    "Always delegate Raazia's emails to Asad",
    'user',
  );
  const noVeto = await findVetoForEvent(clientNumber, userId, event);
  const routedMatches = await matchInstructionsForEvent(clientNumber, userId, event);
  console.log('  veto         :', noVeto ? `YES (${noVeto.reason})` : 'none');
  console.log('  routed match :', routedMatches.length, 'match(es)');
  console.log('  PASS expected: veto=none, routed=>0 →', noVeto === null && routedMatches.length > 0 ? '✓' : '✗');
  if (routing) await updateInstructionStatus(clientNumber, userId, routing.id, 'archived', { isAdmin: true });

  // ── Case 2: subject-specific VETO ──────────────────────────────
  console.log('\n[veto] CASE 2 — subject veto "ask me first before delegating Raazia"');
  const subjectVeto = await createInstructionFromText(
    clientNumber, userId,
    "Ask me first before delegating Raazia's emails",
    'user',
  );
  const r2 = await findVetoForEvent(clientNumber, userId, event);
  console.log('  veto         :', r2 ? `YES (${r2.reason}) — instr "${r2.instruction.title}"` : 'none');
  console.log('  PASS expected: veto=subject_match →', r2?.reason === 'subject_match' ? '✓' : '✗');
  if (subjectVeto) await updateInstructionStatus(clientNumber, userId, subjectVeto.id, 'archived', { isAdmin: true });

  // ── Case 3: global VETO (no subject) ────────────────────────────
  console.log('\n[veto] CASE 3 — global "never auto-send without my approval"');
  const global = await createInstructionFromText(
    clientNumber, userId,
    'Never auto-send without my approval',
    'user',
  );
  const r3 = await findVetoForEvent(clientNumber, userId, event);
  console.log('  veto         :', r3 ? `YES (${r3.reason}) — instr "${r3.instruction.title}"` : 'none');
  // The parser may or may not populate a subject here. Accept global_rule OR subject_match as long as veto fires.
  console.log('  PASS expected: veto fires →', r3 !== null ? '✓' : '✗');
  if (global) await updateInstructionStatus(clientNumber, userId, global.id, 'archived', { isAdmin: true });

  // ── Case 4: watchpoint on EXIM + event mentions EXIM ────────────
  console.log('\n[veto] CASE 4 — watchpoint "Alert me if anyone mentions EXIM"');
  const watch = await createInstructionFromText(
    clientNumber, userId,
    'Alert me if anyone mentions EXIM',
    'user',
  );
  const eximEvent = { ...event, snippet: 'Please also coordinate with EXIM on the next shipment' };
  const r4 = await findVetoForEvent(clientNumber, userId, eximEvent);
  console.log('  veto         :', r4 ? `YES (${r4.reason}) — instr "${r4.instruction.title}"` : 'none');
  console.log('  PASS expected: veto=watchpoint_match →', r4?.reason === 'watchpoint_match' ? '✓' : '✗');
  if (watch) await updateInstructionStatus(clientNumber, userId, watch.id, 'archived', { isAdmin: true });

  // ── Case 5: no relevant instructions at all ─────────────────────
  console.log('\n[veto] CASE 5 — no active rules match');
  const r5 = await findVetoForEvent(clientNumber, userId, event);
  console.log('  veto         :', r5 ? `YES (${r5.reason})` : 'none');
  console.log('  PASS expected: veto=none →', r5 === null ? '✓' : '✗');

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('[veto] failed:', err);
  process.exit(1);
});
