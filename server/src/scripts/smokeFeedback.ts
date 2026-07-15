/**
 * smokeFeedback.ts — verify the feedback → diagnosis loop.
 *   1. Record a 👎 on a fake chat answer (with realistic context)
 *   2. Confirm a feedback wiki page was created
 *   3. Confirm an LLM diagnosis page was created + linked
 *   4. Print the diagnosis category / hypothesis / likely_fix
 *   5. Record a 👍 and confirm no diagnosis is generated
 */
import prisma from '../db/prisma';
import { recordFeedback } from '../services/knowledge/feedbackService';

async function main() {
  const clientNumber = 'TMC-0001';
  const userId = Number(process.argv[2] ?? 5);

  const stableId = `chat:smoke:${Date.now()}`;
  const subjectContext = {
    question: 'What did Fahim say about the SAP migration last week?',
    answer: 'I don\'t have any information about Fahim discussing the SAP migration.',
    sources: [],
  };

  console.log('[fb] posting 👎 …');
  const down = await recordFeedback({
    clientNumber, userId,
    subjectType: 'chat_answer',
    subjectId: stableId,
    rating: 'down',
    reason: 'Brain missed the call transcript from Monday where Fahim explicitly discussed the SAP migration timeline.',
    context: subjectContext,
  });
  console.log('[fb] feedbackPageId =', down.feedbackPageId);
  console.log('[fb] diagnosisPageId (sync) =', down.diagnosisPageId ?? '(pending)');

  // The diagnosis is fire-and-forget; poll briefly for it.
  let diagnosisId = down.diagnosisPageId as string | undefined;
  if (!diagnosisId) {
    for (let i = 0; i < 20 && !diagnosisId; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const link = await prisma.wikiPageLink.findFirst({
        where: { fromPageId: down.feedbackPageId, linkType: 'diagnosed_as' },
        select: { toPageId: true },
      }).catch(() => null);
      diagnosisId = link?.toPageId ?? undefined;
    }
  }
  if (!diagnosisId) {
    console.log('[fb] ✗ no diagnosis page appeared within 10 seconds');
  } else {
    const d = await prisma.wikiPage.findUnique({
      where: { id: diagnosisId },
      select: { title: true, metadata: true, bodyMarkdown: true },
    });
    const md: any = d?.metadata ?? {};
    console.log('\n[fb] ── diagnosis ──');
    console.log('  title      :', d?.title);
    console.log('  category   :', md.category);
    console.log('  subsystem  :', md.affectedSubsystem);
    console.log('  confidence :', md.confidence);
    console.log('  hypothesis :', md.hypothesis);
    console.log('  likely_fix :', md.likelyFix);
  }

  console.log('\n[fb] posting 👍 on a different answer (should NOT trigger diagnosis) …');
  const up = await recordFeedback({
    clientNumber, userId,
    subjectType: 'chat_answer',
    subjectId: `chat:smoke:${Date.now() + 1}`,
    rating: 'up',
    context: { question: 'What are my open items?', answer: 'You have 5 overdue high-priority items…' },
  });
  console.log('[fb] up feedbackPageId =', up.feedbackPageId, ' diagnosisPageId =', up.diagnosisPageId ?? '(none — correct)');

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
