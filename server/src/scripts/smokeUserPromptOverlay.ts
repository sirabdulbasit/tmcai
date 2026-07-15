/**
 * smokeUserPromptOverlay.ts — Phase B end-to-end against the live DB.
 *
 *   1. createManual / listAll / updateRule (text + active) / deleteRule
 *      / resetAll round-trip.
 *   2. listActiveForPrompt only returns ACTIVE rules, capped at 12,
 *      ordered by recency.
 *   3. renderOverlayBlock produces the expected markdown when there
 *      are rules, empty string when there are none.
 *   4. maybePromote does NOT promote on the first occurrence of a
 *      category; DOES promote on the second.
 *   5. Promote is dedup'd: same diagnosis_id can't create two rules.
 *   6. Promote is dedup'd: same category already-active blocks
 *      a fresh rule (don't pile up duplicates).
 *   7. Confidence below floor (0.7) does not promote.
 *   8. Non-promotable categories (e.g. "unclear") never promote.
 */
import 'dotenv/config';
import prisma from '../db/prisma';

const TEST_CLIENT = 'TMC-0001';

async function pickTestUser() {
  const u = await prisma.user.findFirst({
    where: { clientNumber: TEST_CLIENT, isActive: true },
    select: { id: true, clientNumber: true },
    orderBy: { id: 'asc' },
  });
  if (!u) throw new Error(`No active user in ${TEST_CLIENT}`);
  return u;
}

async function cleanup(userId: number) {
  await prisma.userPromptOverlay.deleteMany({ where: { userId } }).catch(() => {});
  await prisma.wikiPage.deleteMany({
    where: {
      userId, pageType: 'feedback_diagnosis',
      title: { contains: 'smoke' } as any,
    },
  }).catch(() => {});
}

let diagCounter = 0;
async function makeDiagnosisPage(userId: number, clientNumber: string, category: string): Promise<string> {
  diagCounter += 1;
  const created = await prisma.wikiPage.create({
    data: {
      clientNumber, userId,
      pageType: 'feedback_diagnosis',
      title: `[smoke] diagnosis ${diagCounter} — ${category}`,
      bodyMarkdown: 'smoke',
      storage: 'postgres', status: 'active',
      lastUpdatedBy: 'smoke',
      metadata: { category, smoke: true } as any,
    },
    select: { id: true },
  });
  return created.id;
}

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exit(2);
  }
  console.log(`✓ ${msg}`);
}

async function main() {
  const user = await pickTestUser();
  console.log(`[smoke] using user.id=${user.id} client=${user.clientNumber}`);
  await cleanup(user.id);

  const svc = await import('../services/knowledge/userPromptOverlayService');

  // ── 1. CRUD round-trip ─────────────────────────────────────
  const id1 = await svc.createManual({
    clientNumber: user.clientNumber, userId: user.id,
    ruleText: 'Keep answers tight — 2-3 sentences for casual.',
    category: 'too_verbose',
  });
  assert(id1, '1.1 createManual returns an id');

  const all = await svc.listAll(user.clientNumber, user.id);
  assert(all.length === 1, '1.2 listAll returns the new rule');
  assert(all[0]!.active === true && all[0]!.source === 'manual', '1.3 manual rule defaults active=true source=manual');

  await svc.updateRule({ id: id1, userId: user.id, active: false });
  const all2 = await svc.listAll(user.clientNumber, user.id);
  assert(all2[0]!.active === false, '1.4 updateRule disables the rule');

  await svc.updateRule({ id: id1, userId: user.id, ruleText: 'EDITED — keep answers tight.' });
  const all3 = await svc.listAll(user.clientNumber, user.id);
  assert(all3[0]!.ruleText.startsWith('EDITED'), '1.5 updateRule rewrites text');

  await svc.deleteRule({ id: id1, userId: user.id });
  const all4 = await svc.listAll(user.clientNumber, user.id);
  assert(all4.length === 0, '1.6 deleteRule removes the row');

  // ── 2. listActiveForPrompt — only active, ordered by recency ──
  const idA = await svc.createManual({ clientNumber: user.clientNumber, userId: user.id, ruleText: 'rule A — older', category: 'custom' });
  await new Promise((r) => setTimeout(r, 20));
  const idB = await svc.createManual({ clientNumber: user.clientNumber, userId: user.id, ruleText: 'rule B — newer', category: 'custom' });
  await svc.updateRule({ id: idA, userId: user.id, active: false });
  const active = await svc.listActiveForPrompt(user.clientNumber, user.id);
  assert(active.length === 1, '2.1 listActiveForPrompt returns only active');
  assert(active[0]!.ruleText === 'rule B — newer', '2.2 newer first');

  // ── 3. renderOverlayBlock ─────────────────────────────────
  const block = svc.renderOverlayBlock(active);
  assert(block.includes('# Personal preferences'), '3.1 block has heading');
  assert(block.includes('rule B'), '3.2 block contains rule text');
  const empty = svc.renderOverlayBlock([]);
  assert(empty === '', '3.3 empty rules → empty block');

  await cleanup(user.id);

  // ── 4. maybePromote — does NOT promote on first ───────────
  const d1 = await makeDiagnosisPage(user.id, user.clientNumber, 'wrong_tone');
  const r1 = await svc.maybePromote({
    clientNumber: user.clientNumber, userId: user.id,
    diagnosisId: d1, category: 'wrong_tone',
    confidence: 0.85, hypothesis: 'too formal', likelyFix: 'soften tone',
  });
  assert(r1 === null, '4.1 first occurrence does not promote');
  const after4 = await svc.listAll(user.clientNumber, user.id);
  assert(after4.length === 0, '4.2 no rule created on first occurrence');

  // ── 4b. Second occurrence → promote ──────────────────────
  const d2 = await makeDiagnosisPage(user.id, user.clientNumber, 'wrong_tone');
  const r2 = await svc.maybePromote({
    clientNumber: user.clientNumber, userId: user.id,
    diagnosisId: d2, category: 'wrong_tone',
    confidence: 0.85, hypothesis: 'too formal again', likelyFix: 'soften tone',
  });
  assert(r2, '4.3 second occurrence promotes (rule id returned)');
  const after4b = await svc.listAll(user.clientNumber, user.id);
  assert(after4b.length === 1, '4.4 exactly one rule created');
  assert(after4b[0]!.category === 'wrong_tone', '4.5 rule category=wrong_tone');
  assert(after4b[0]!.source === 'feedback_diagnosis', '4.6 source=feedback_diagnosis');
  assert(after4b[0]!.sourceDiagnosisId === d2, '4.7 sourceDiagnosisId set to d2');

  // ── 5. Same diagnosis_id is dedup'd ────────────────────────
  const r3 = await svc.maybePromote({
    clientNumber: user.clientNumber, userId: user.id,
    diagnosisId: d2, category: 'wrong_tone',
    confidence: 0.85, hypothesis: 'still', likelyFix: 'still',
  });
  assert(r3 === null, '5.1 re-promote on same diagnosisId returns null');
  const after5 = await svc.listAll(user.clientNumber, user.id);
  assert(after5.length === 1, '5.2 still one rule');

  // ── 6. Same category already active blocks fresh promote ──
  const d3 = await makeDiagnosisPage(user.id, user.clientNumber, 'wrong_tone');
  const r4 = await svc.maybePromote({
    clientNumber: user.clientNumber, userId: user.id,
    diagnosisId: d3, category: 'wrong_tone',
    confidence: 0.9, hypothesis: 'yet again', likelyFix: 'soften',
  });
  assert(r4 === null, '6.1 fresh diagnosis with already-covered category does not promote');
  const after6 = await svc.listAll(user.clientNumber, user.id);
  assert(after6.length === 1, '6.2 still one rule (no duplicates of category)');

  // ── 7. Low confidence does not promote ───────────────────
  await cleanup(user.id);
  const d4 = await makeDiagnosisPage(user.id, user.clientNumber, 'too_verbose');
  await makeDiagnosisPage(user.id, user.clientNumber, 'too_verbose'); // make recurrence
  const r5 = await svc.maybePromote({
    clientNumber: user.clientNumber, userId: user.id,
    diagnosisId: d4, category: 'too_verbose',
    confidence: 0.5, hypothesis: 'low conf', likelyFix: 'tighten',
  });
  assert(r5 === null, '7.1 confidence < 0.7 does not promote');

  // ── 8. Non-promotable category never promotes ────────────
  await cleanup(user.id);
  const d5 = await makeDiagnosisPage(user.id, user.clientNumber, 'unclear');
  await makeDiagnosisPage(user.id, user.clientNumber, 'unclear');
  const r6 = await svc.maybePromote({
    clientNumber: user.clientNumber, userId: user.id,
    diagnosisId: d5, category: 'unclear',
    confidence: 0.95, hypothesis: 'whatever', likelyFix: 'whatever',
  });
  assert(r6 === null, '8.1 unclear category never promotes');

  await cleanup(user.id);
  console.log('\n[smoke] ✅ all phase-B assertions passed');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[smoke] FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
