/**
 * smokeNextSession.ts — verify the three new systems shipped this turn:
 *   1. action-rule evaluator now fires inside autonomousExecutor
 *   2. learning rollup endpoint composes correctly
 *   3. memory consolidation dry-run reports archive candidates
 */
import prisma from '../db/prisma';
import { runWithoutTenant } from '../db/tenantContext';

async function main() {
  // Boot handler registry — our scripts run outside the server.
  const { registerAllHandlers } = await import('../services/actions/handlers');
  registerAllHandlers();

  await runWithoutTenant(async () => {
    const clientNumber = 'TMC-0001';
    const userId = 5;

    // ── 1. Action rule evaluator inside autonomousExecutor ──
    console.log('\n=== 1. Action Rule Evaluator (autonomousExecutor) ===');

    // Create a SUGGEST-mode rule for "raazia"-mentioning emails
    const { createRule, setRuleMode, deleteRule } = await import('../services/userActionRuleService');
    const rule = await createRule({
      clientNumber, userId,
      name: 'Smoke: Raazia → forward to Asad',
      nlOriginal: 'when emails from raazia, forward to asad',
      triggerKind: 'inbound_email',
      triggerCondition: { sender: 'raazia' },
      actionType: 'forward_email',
      actionPayload: { delegatee: 'Asad' },
    });
    console.log('rule created:', rule.id, 'mode=', rule.mode);

    // Promote to SUGGEST
    await setRuleMode(clientNumber, userId, rule.id, 'SUGGEST');
    console.log('promoted to SUGGEST');

    // Simulate a feed event — push directly into executeIfMatched.
    const { executeIfMatched } = await import('../services/triage/autonomousExecutor');
    const fakeEvent = {
      id: `fake_event_${Date.now()}`,
      clientNumber,
      userId,
      sourceType: 'gmail',
      senderEmail: 'raazia@partner.com',
      senderName: 'Raazia Khan',
      rawPayload: {
        subject: 'Contract renewal terms',
        snippet: 'Looking at extending the partnership next quarter.',
        from: 'Raazia Khan <raazia@partner.com>',
      },
      createdAt: new Date(),
    };
    const r = await executeIfMatched(fakeEvent as any);
    console.log('autoexec result:', r);

    // Verify a tenant-log entry was filed for the SUGGEST match
    const tlPage = await prisma.$queryRawUnsafe<any[]>(
      `SELECT body_markdown FROM wiki_pages
        WHERE client_number=$1 AND user_id=$2 AND page_type='tenant_log' LIMIT 1`,
      clientNumber, userId,
    );
    const matched = (tlPage[0]?.body_markdown ?? '').includes(rule.id);
    console.log('  tenant_log carries ruleId:', matched ? '✓' : '✗');

    // Cleanup
    await deleteRule(clientNumber, userId, rule.id);

    // ── 2. Learning rollup endpoint ───────────────────────────
    console.log('\n=== 2. Learning Rollup ===');
    const { getLearningRollup } = await import('../services/knowledge/feedbackService');
    const rollup = await getLearningRollup(clientNumber, userId, 7);
    console.log('feedback (last 7d):', rollup.feedback);
    console.log('diagnosesByCategory:', rollup.diagnosesByCategory.map((c) => `${c.category}=${c.n}`).join(', ') || '(none)');
    console.log('recent diagnoses:', rollup.recentDiagnoses.length);
    console.log('calibration sample count:', rollup.calibration.sampleCount);
    console.log('critical threshold:', rollup.calibration.criticalThreshold.toFixed(3));
    console.log('brain self-suggests:');
    for (const s of rollup.brainSuggests) console.log('  ·', s);

    // ── 3. Memory consolidation dry-run ─────────────────────
    console.log('\n=== 3. Memory Consolidation (dry-run) ===');
    const { runConsolidationForTenant } = await import('../services/knowledge/memoryConsolidationService');
    const dry = await runConsolidationForTenant(clientNumber, { dryRun: true });
    console.log('would archive:', dry.totalArchived, 'pages across types:', dry.byType);

    // ── ASSERTIONS ────────────────────────────────────────
    console.log('\n=== ASSERTIONS ===');
    const asserts = [
      ['action rule created in DRAFT', rule.mode === 'DRAFT'],
      ['SUGGEST evaluator fired into tenant_log', matched],
      ['rollup composes without crash', !!rollup.calibration],
      ['rollup has sane critical threshold', rollup.calibration.criticalThreshold >= 0.5 && rollup.calibration.criticalThreshold <= 0.95],
      ['memory consolidation dry-run returns counts', typeof dry.totalArchived === 'number'],
    ];
    for (const [name, ok] of asserts) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  });

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
