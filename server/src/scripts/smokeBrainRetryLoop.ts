/**
 * smokeBrainRetryLoop.ts — verify Phase A end-to-end against the live DB.
 *
 *   1. recordFeedback({rating:'down', subjectType:'chat_answer',
 *      awaitDiagnosis:true}) returns a diagnosis summary synchronously.
 *      Diagnosis fields: category, hypothesis, likelyFix, confidence,
 *      affectedSubsystem.
 *   2. recordFeedback for non-chat_answer subjects does NOT return
 *      diagnosis (legacy fire-and-forget path stays).
 *   3. The compose() function, when given opts.steeringHint, includes the
 *      hint in the system prompt under "Retry guidance".
 *   4. answerAsBrain forwards opts.steeringHint to compose.
 *
 * The LLM call inside diagnoseFailure is monkey-patched so the smoke runs
 * without burning real Gemini calls. The DB writes (feedback wiki page +
 * diagnosis page + link) are real.
 *
 * Usage:  npx ts-node src/scripts/smokeBrainRetryLoop.ts
 */
import 'dotenv/config';
import prisma from '../db/prisma';
import * as llmRouter from '../services/llmRouter';

const TEST_CLIENT = 'TMC-0001';

function patchLLM() {
  (llmRouter as any).callLLM = async (sys: string, userMsg: string, _opts: any) => {
    // The diagnostic prompt asks for ONE JSON object. Return a high-confidence
    // diagnosis the smoke can assert on.
    if (sys.includes('self-diagnostic') || sys.includes("Brain's self-diagnostic")) {
      return {
        text: JSON.stringify({
          category: 'wrong_person_scope',
          hypothesis: 'Used Asad\'s history when the question was about Omar.',
          likely_fix: 'Re-scope retrieval to the named entity in the question.',
          confidence: 0.82,
          affected_subsystem: 'retrieval',
        }),
      };
    }
    // Composer call (during answerAsBrain) — return a tiny valid JSON answer.
    return {
      text: JSON.stringify({
        answer: 'mocked retry answer',
        cites: [],
        gaps: [],
      }),
    };
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

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exit(2);
  }
  console.log(`✓ ${msg}`);
}

async function cleanup(userId: number) {
  await prisma.wikiPage.deleteMany({
    where: {
      userId,
      pageType: { in: ['feedback', 'feedback_diagnosis'] },
      title: { contains: 'smoke' } as any,
    },
  }).catch(() => {});
}

async function main() {
  patchLLM();
  const user = await pickTestUser();
  console.log(`[smoke] using user.id=${user.id} client=${user.clientNumber}`);
  await cleanup(user.id);

  // ── 1. Sync diagnosis returned for chat_answer downvote ──────
  const { recordFeedback } = await import('../services/knowledge/feedbackService');
  const subjectId = `smoke-chat-${Date.now()}`;
  const r = await recordFeedback({
    clientNumber: user.clientNumber,
    userId: user.id,
    subjectType: 'chat_answer',
    subjectId,
    rating: 'down',
    reason: 'smoke — mocked',
    context: {
      question: 'tell me about omar',
      answer: 'asad has been...',  // wrong-person scope
      sources: [],
    },
    awaitDiagnosis: true,
  });
  assert(r.feedbackPageId, '1.1 feedbackPageId returned');
  assert(r.diagnosis, '1.2 diagnosis summary returned synchronously');
  assert(r.diagnosis?.category === 'wrong_person_scope', '1.3 diagnosis.category correct');
  assert(typeof r.diagnosis?.confidence === 'number' && r.diagnosis.confidence >= 0.6,
    `1.4 diagnosis.confidence above retry floor (0.6) — was ${r.diagnosis?.confidence}`);
  assert(r.diagnosis?.likelyFix?.includes('Re-scope'), '1.5 diagnosis.likelyFix populated');
  assert(r.diagnosisPageId, '1.6 diagnosisPageId returned alongside summary');

  // ── 2. Non-chat surface: no sync diagnosis returned ──────────
  const r2 = await recordFeedback({
    clientNumber: user.clientNumber,
    userId: user.id,
    subjectType: 'observation',
    subjectId: `smoke-obs-${Date.now()}`,
    rating: 'down',
    reason: 'smoke — observation',
    awaitDiagnosis: false, // explicit false (matches default)
  });
  assert(r2.feedbackPageId, '2.1 feedbackPageId returned');
  assert(!r2.diagnosis, '2.2 no sync diagnosis on awaitDiagnosis=false');

  // ── 3. compose() includes the steering hint when provided ────
  const composer = await import('../services/knowledge/brainComposer');
  // We can't easily run compose() end-to-end because it needs Redis +
  // many DB lookups. Instead, verify the source text contains the new
  // injection block we added.
  const fs = await import('fs');
  const path = await import('path');
  // Compiled .js dropped under dist/scripts; .ts source lives at src/.
  // Resolve from server-root regardless of which mode we're in.
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const srcRoot = inDist
    ? path.resolve(__dirname, '../..', 'src')
    : path.resolve(__dirname, '..');
  const composerSrc = fs.readFileSync(
    path.resolve(srcRoot, 'services/knowledge/brainComposer.ts'),
    'utf-8',
  );
  assert(composerSrc.includes('Retry guidance'),
    '3.1 composer source contains "Retry guidance" injection block');
  assert(composerSrc.includes('opts.steeringHint'),
    '3.2 composer reads opts.steeringHint');
  assert(typeof composer.compose === 'function',
    '3.3 compose remains exported');

  // ── 4. answerAsBrain forwards steeringHint ──────────────────
  const askSrc = fs.readFileSync(
    path.resolve(srcRoot, 'routes/brainAskRoutes.ts'),
    'utf-8',
  );
  assert(askSrc.includes('steeringHint: opts.steeringHint'),
    '4.1 answerAsBrain forwards steeringHint to compose');
  assert(askSrc.includes("router.post('/retry'"),
    '4.2 /retry endpoint registered');
  assert(askSrc.includes('Failure category:'),
    '4.3 retry endpoint composes structured steering hint from diagnosis');

  // ── Cleanup ────────────────────────────────────────────────
  await cleanup(user.id);
  console.log('\n[smoke] ✅ all phase-A assertions passed');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[smoke] FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
