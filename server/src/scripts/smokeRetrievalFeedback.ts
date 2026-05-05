/**
 * smokeRetrievalFeedback.ts — Phase C end-to-end against the live DB.
 *
 *   1. recordPositiveSignal upserts: first call inserts, second
 *      increments positive_uses.
 *   2. recordNegativeSignal upserts independently of positive.
 *   3. computeBoost: zero with no signal, smoothed positive with strong
 *      positive, smoothed negative with strong negative, capped at ±0.4.
 *   4. getBoosts returns one Map keyed by pageId; pages with no row
 *      are omitted.
 *   5. End-to-end via recordFeedback({rating:'up', context.sources}):
 *      cited wiki pages get a positive_use; cited entities are skipped
 *      (only wiki_page sources count).
 *   6. End-to-end via recordFeedback({rating:'down'}) with diagnosis
 *      category 'wrong_source': cited wiki pages get a negative_use.
 *      Other categories (e.g. 'wrong_tone') do NOT penalise retrieval.
 *   7. getTopAndBottom returns sorted top/bottom pages.
 */
import 'dotenv/config';
import prisma from '../db/prisma';
import * as llmRouter from '../services/llmRouter';

const TEST_CLIENT = 'TMC-0001';

// LLM mock so the diagnosis path runs without a real API call.
function patchLLM(category: string) {
  (llmRouter as any).callLLM = async (sys: string, _user: string, _opts: any) => {
    if (sys.includes('self-diagnostic') || sys.includes("Brain's self-diagnostic")) {
      return {
        text: JSON.stringify({
          category, hypothesis: 'mocked', likely_fix: 'mocked',
          confidence: 0.85, affected_subsystem: 'retrieval',
        }),
      };
    }
    return { text: '{"answer":"mocked","cites":[],"gaps":[]}' };
  };
}

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
  await prisma.retrievalFeedback.deleteMany({ where: { userId } }).catch(() => {});
  await prisma.wikiPage.deleteMany({
    where: {
      userId, pageType: { in: ['feedback', 'feedback_diagnosis'] },
      title: { contains: 'smoke-rf' } as any,
    },
  }).catch(() => {});
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

  const svc = await import('../services/knowledge/retrievalFeedbackService');

  // ── 1. recordPositiveSignal upsert ─────────────────────────
  const PAGE_A = 'page_smoke_a';
  const PAGE_B = 'page_smoke_b';
  await svc.recordPositiveSignal(user.clientNumber, user.id, [PAGE_A]);
  let row = await prisma.retrievalFeedback.findFirst({ where: { userId: user.id, pageId: PAGE_A } });
  assert(row?.positiveUses === 1, '1.1 first call sets positive_uses=1');
  assert(row?.lastPositiveAt instanceof Date, '1.2 lastPositiveAt set');
  await svc.recordPositiveSignal(user.clientNumber, user.id, [PAGE_A]);
  row = await prisma.retrievalFeedback.findFirst({ where: { userId: user.id, pageId: PAGE_A } });
  assert(row?.positiveUses === 2, '1.3 second call increments to 2');

  // ── 2. recordNegativeSignal upsert ─────────────────────────
  await svc.recordNegativeSignal(user.clientNumber, user.id, [PAGE_B]);
  row = await prisma.retrievalFeedback.findFirst({ where: { userId: user.id, pageId: PAGE_B } });
  assert(row?.negativeUses === 1 && row?.positiveUses === 0, '2.1 negative-only row');
  await svc.recordNegativeSignal(user.clientNumber, user.id, [PAGE_A]);
  row = await prisma.retrievalFeedback.findFirst({ where: { userId: user.id, pageId: PAGE_A } });
  assert(row?.positiveUses === 2 && row?.negativeUses === 1, '2.2 mixed signal preserved');

  // ── 3. computeBoost shape ─────────────────────────────────
  assert(svc.computeBoost(0, 0) === 0, '3.1 zero signal → 0');
  // Strong positive: 10 pos, 0 neg → 10/(10+0+5) = 0.667 → capped at 0.4
  assert(svc.computeBoost(10, 0) === 0.4, `3.2 strong positive caps at +0.4`);
  // Strong negative
  assert(svc.computeBoost(0, 10) === -0.4, '3.3 strong negative caps at -0.4');
  // Mid-range — smooth: 2 pos, 0 neg → 2/(2+0+5) = 0.286 → 0.286 (rounded)
  const midPos = svc.computeBoost(2, 0);
  assert(midPos > 0.2 && midPos < 0.35, `3.4 mid positive smoothed (was ${midPos})`);
  // Balanced equally → 0
  assert(Math.abs(svc.computeBoost(5, 5)) < 0.001, '3.5 equal pos/neg → ~0');

  // ── 4. getBoosts batch ────────────────────────────────────
  await cleanup(user.id);
  await svc.recordPositiveSignal(user.clientNumber, user.id, [PAGE_A, PAGE_A, PAGE_A, PAGE_A]);
  await svc.recordNegativeSignal(user.clientNumber, user.id, [PAGE_B]);
  const boosts = await svc.getBoosts(user.id, [PAGE_A, PAGE_B, 'page_no_signal']);
  assert(boosts.size === 2, `4.1 only pages with signal returned (was ${boosts.size})`);
  assert((boosts.get(PAGE_A) ?? 0) > 0, '4.2 page A has positive boost');
  assert((boosts.get(PAGE_B) ?? 0) < 0, '4.3 page B has negative boost');
  assert(!boosts.has('page_no_signal'), '4.4 unknown page absent from map');

  // ── 5. End-to-end via recordFeedback rating='up' ──────────
  await cleanup(user.id);
  patchLLM('wrong_tone');  // not used for 👍 path but harmless
  const { recordFeedback } = await import('../services/knowledge/feedbackService');
  await recordFeedback({
    clientNumber: user.clientNumber,
    userId: user.id,
    subjectType: 'chat_answer',
    subjectId: `smoke-rf-${Date.now()}`,
    rating: 'up',
    context: {
      question: 'who is asad?',
      answer: '...',
      sources: [
        { type: 'wiki_page', id: 'wiki_a' },
        { type: 'wiki_page', id: 'wiki_b' },
        { type: 'entity', id: 'ent_x' }, // should be skipped
      ],
    },
  });
  // Async upsert — wait briefly for it to land.
  await new Promise((r) => setTimeout(r, 200));
  const upRows = await prisma.retrievalFeedback.findMany({
    where: { userId: user.id, pageId: { in: ['wiki_a', 'wiki_b', 'ent_x'] } },
  });
  const ids5 = upRows.map((r) => r.pageId).sort();
  assert(ids5.length === 2, `5.1 two wiki_page sources got positive signal (was ${ids5.length})`);
  assert(ids5[0] === 'wiki_a' && ids5[1] === 'wiki_b', '5.2 entity source skipped');

  // ── 6. 👎 with diagnosis category 'wrong_source' → negative ─
  await cleanup(user.id);
  patchLLM('wrong_source');
  await recordFeedback({
    clientNumber: user.clientNumber,
    userId: user.id,
    subjectType: 'chat_answer',
    subjectId: `smoke-rf-down-${Date.now()}`,
    rating: 'down',
    context: { question: 'q', answer: 'a', sources: [{ type: 'wiki_page', id: 'wiki_c' }] },
    awaitDiagnosis: true,
  });
  await new Promise((r) => setTimeout(r, 200));
  const downRow = await prisma.retrievalFeedback.findFirst({
    where: { userId: user.id, pageId: 'wiki_c' },
  });
  assert(downRow?.negativeUses === 1, '6.1 wrong_source 👎 records negative signal');

  // ── 6b. 👎 with diagnosis 'wrong_tone' → no retrieval penalty ─
  patchLLM('wrong_tone');
  await recordFeedback({
    clientNumber: user.clientNumber,
    userId: user.id,
    subjectType: 'chat_answer',
    subjectId: `smoke-rf-tone-${Date.now()}`,
    rating: 'down',
    context: { question: 'q', answer: 'a', sources: [{ type: 'wiki_page', id: 'wiki_d' }] },
    awaitDiagnosis: true,
  });
  await new Promise((r) => setTimeout(r, 200));
  const toneRow = await prisma.retrievalFeedback.findFirst({
    where: { userId: user.id, pageId: 'wiki_d' },
  });
  assert(toneRow === null, '6.2 wrong_tone 👎 does NOT penalise retrieval');

  // ── 7. getTopAndBottom ────────────────────────────────────
  await cleanup(user.id);
  await svc.recordPositiveSignal(user.clientNumber, user.id, ['p1', 'p1', 'p1', 'p1']);
  await svc.recordNegativeSignal(user.clientNumber, user.id, ['p2', 'p2', 'p2', 'p2']);
  await svc.recordPositiveSignal(user.clientNumber, user.id, ['p3']);
  const tb = await svc.getTopAndBottom(user.clientNumber, user.id, 5);
  assert(tb.top[0]?.pageId === 'p1', '7.1 best-boosted page first in top');
  assert(tb.bottom[0]?.pageId === 'p2', '7.2 worst-boosted page first in bottom');
  assert(tb.top.find((x) => x.pageId === 'p3'), '7.3 p3 with mild positive in top');

  await cleanup(user.id);
  console.log('\n[smoke] ✅ all phase-C assertions passed');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[smoke] FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
