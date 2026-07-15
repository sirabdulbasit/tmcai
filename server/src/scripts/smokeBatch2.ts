/**
 * Smoke tests for Phases C, D, E, F, G.
 * Runs as Basit (userId=1, TMC-0001). Prints a pass/fail line per phase.
 */
import prisma from '../db/prisma';

async function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  const CLIENT = 'TMC-0001';
  const USER = 1;

  console.log('\n━━━ Phase C — ingest propagation (project/policy extraction) ━━━');
  {
    const { propagateFeedEvent } = await import('../services/knowledge/propagationService');
    const testSubject = 'Satori: Phase 2 SOW & Pricing Proposal — next steps';
    const testSnippet = 'Hi Basit, following up on the Satori Phase 2 SOW. Please review the pricing proposal per the TMC Pricing Policy. Anas Wahab is aligned on commercials.';
    // Fake feed event ID for linking; we use a sentinel that won't collide.
    await propagateFeedEvent({
      clientNumber: CLIENT, userId: USER,
      feedEventId: 'smoke-phase-c',
      sourceType: 'gmail',
      subject: testSubject,
      snippet: testSnippet,
      senderEmail: 'fahim.varraich@datagraders.com',
      senderName: 'Fahim Ahmed Varraich',
      receivedAt: new Date(),
    });
    const project = await prisma.wikiPage.findFirst({
      where: { clientNumber: CLIENT, pageType: 'project', title: { contains: 'Satori', mode: 'insensitive' } as any },
      select: { id: true, title: true, sourceCount: true },
    });
    await check('project page extracted from email', !!project, project ? `title="${project.title}" sources=${project.sourceCount}` : 'no project page created');
    const policy = await prisma.wikiPage.findFirst({
      where: { clientNumber: CLIENT, pageType: 'policy', title: { contains: 'Pricing', mode: 'insensitive' } as any },
      select: { id: true, title: true },
    });
    await check('policy page extracted from email', !!policy, policy?.title);
  }

  console.log('\n━━━ Phase D — file chat answer back as wiki page ━━━');
  {
    const { answerAsBrain } = await import('../routes/brainAskRoutes');
    const q = 'who handles sales at TMC?';
    const r = await answerAsBrain(CLIENT, USER, q);
    await check('brain answered', !!r.answer && r.answer.length > 20, `answer=${r.answer.slice(0, 80)}…`);
    // Wait briefly for the fire-and-forget file
    await new Promise((res) => setTimeout(res, 1500));
    const filed = await prisma.wikiPage.findFirst({
      where: { clientNumber: CLIENT, userId: USER, pageType: 'answer', title: { contains: 'sales', mode: 'insensitive' } as any },
      select: { id: true, title: true, bodyMarkdown: true },
    });
    await check('answer page filed back', !!filed, filed?.title);
  }

  console.log('\n━━━ Phase E — preference signal recording ━━━');
  {
    const { recordSignal, getLearnedPreferences } = await import('../services/knowledge/preferenceLearnerService');
    await recordSignal(CLIENT, USER, {
      kind: 'accept_draft',
      archetype: 'reply_needed',
      tone: 'formal',
      senderDomain: 'datagraders.com',
    });
    await recordSignal(CLIENT, USER, {
      kind: 'delegate',
      archetype: 'reply_needed',
      delegateeEmail: 'asad.ahmed@tmcltd.com',
      senderDomain: 'datagraders.com',
    });
    const prefs = await getLearnedPreferences(CLIENT, USER);
    await check('signals recorded and readable', prefs.totalSignals >= 2, `total=${prefs.totalSignals} delegatees=${prefs.preferredDelegatees.length}`);
    await check('preferred delegatee aggregated', prefs.preferredDelegatees.some((d) => d.email === 'asad.ahmed@tmcltd.com'), JSON.stringify(prefs.preferredDelegatees));
  }

  console.log('\n━━━ Phase F — wiki lint ━━━');
  {
    const { runLintForUser } = await import('../jobs/wikiLintWorker');
    const f = await runLintForUser(CLIENT, USER);
    await check('lint produced findings', typeof f.orphans === 'number', JSON.stringify({ orphans: f.orphans, stale: f.stale, openGaps: f.openGaps, missing: f.missingEntityPages.length }));
    const report = await prisma.wikiPage.findFirst({
      where: { clientNumber: CLIENT, userId: USER, pageType: 'pattern', title: 'Wiki Lint Report' },
      select: { id: true, bodyMarkdown: true },
    });
    await check('lint report filed as wiki page', !!report, report ? `body=${String(report.bodyMarkdown).split('\n')[0]}` : 'no report');
  }

  console.log('\n━━━ Phase G — CLI ─ in-process ━━━');
  {
    // Exercise the CLI's core call path without spawning a child proc.
    const u = await prisma.user.findUnique({ where: { id: USER }, select: { email: true, clientNumber: true } });
    const { answerAsBrain } = await import('../routes/brainAskRoutes');
    const r = await answerAsBrain(u!.clientNumber, USER, 'tell me about the Satori project');
    await check('CLI answer path works', !!r.answer && r.answer.length > 20, `intent=${(r as any).intent}`);
  }

  console.log('\n━━━ smoke tests complete ━━━');
  await new Promise((res) => setTimeout(res, 500));
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(0), 1000).unref());
