/**
 * scripts/diagnoseAttention.ts
 *
 * Debug helper for the "My Attention dropped from N to 0" failure mode.
 *
 * Usage:
 *   cd /var/www/tmcai/server
 *   npx tsx src/scripts/diagnoseAttention.ts <userEmail>
 *
 * Reproduces buildAttentionList()'s funnel step by step and prints
 * how many feed events were dropped at each stage. Tells you in one
 * pass whether the items moved to the BRIEF section (handledByRule),
 * got hidden via pattern_hidden, were terminally decided, or simply
 * fell out of the 7-day event-date window.
 */
import prisma from '../db/prisma';

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('usage: npx tsx src/scripts/diagnoseAttention.ts <userEmail>');
    process.exit(1);
  }

  const user = await prisma.user.findFirst({
    where: { email },
    select: { id: true, name: true, email: true, clientNumber: true },
  });
  if (!user) {
    console.error(`No user with email=${email}`);
    process.exit(1);
  }
  console.log(`User: ${user.name} <${user.email}> id=${user.id} client=${user.clientNumber}`);

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // 1. Raw feed event count in the 90-day SQL window
  const feedTotal = await prisma.feedEvent.count({
    where: {
      clientNumber: user.clientNumber,
      userId: user.id,
      sourceType: { in: ['gmail', 'whatsapp', 'gcal', 'gtasks'] as any },
      createdAt: { gte: ninetyDaysAgo },
    } as any,
  });
  console.log(`\n[1] Feed events (last 90d, gmail/whatsapp/gcal/gtasks): ${feedTotal}`);

  // 2. Within last 7 days by createdAt (rough)
  const feed7d = await prisma.feedEvent.count({
    where: {
      clientNumber: user.clientNumber,
      userId: user.id,
      sourceType: { in: ['gmail', 'whatsapp', 'gcal', 'gtasks'] as any },
      createdAt: { gte: sevenDaysAgo },
    } as any,
  });
  console.log(`[2] Feed events (last 7d by createdAt):                   ${feed7d}`);

  // 3. Terminal decisions in last 7d
  const TERMINAL = ['approved', 'delegated', 'snoozed', 'dismissed', 'overrode'];
  const decisions = await prisma.decisionLog.findMany({
    where: {
      clientNumber: user.clientNumber, userId: user.id,
      createdAt: { gte: sevenDaysAgo },
      entityId: { not: null } as any,
      userDecision: { in: TERMINAL } as any,
    } as any,
    select: { entityId: true, userDecision: true, createdAt: true },
  });
  const decidedSet = new Set(decisions.map((d) => d.entityId).filter(Boolean) as string[]);
  const decisionsByKind: Record<string, number> = {};
  for (const d of decisions) decisionsByKind[d.userDecision] = (decisionsByKind[d.userDecision] ?? 0) + 1;
  console.log(`[3] Terminal decisions in last 7d (would hide cards):     ${decisions.length}`);
  console.log(`    breakdown: ${JSON.stringify(decisionsByKind)}`);

  // 4. Hidden patterns
  const hidden = await prisma.patternHidden.findMany({
    where: { clientNumber: user.clientNumber, userId: user.id, source: 'decision' } as any,
    select: { dedupHash: true, hiddenAt: true, reason: true } as any,
  });
  console.log(`[4] pattern_hidden rows for this user:                    ${hidden.length}`);
  if (hidden.length > 0) {
    const recent = (hidden as any[]).slice(-5).map((h: any) => `${h.dedupHash.slice(0, 12)}@${new Date(h.hiddenAt).toISOString()} (${h.reason ?? '—'})`);
    console.log(`    most recent: ${recent.join(', ')}`);
  }

  // 5. Replay buildAttentionList's filter funnel (without the LLM call)
  const rows = await prisma.feedEvent.findMany({
    where: {
      clientNumber: user.clientNumber,
      userId: user.id,
      sourceType: { in: ['gmail', 'whatsapp', 'gcal', 'gtasks'] as any },
      createdAt: { gte: ninetyDaysAgo },
    } as any,
    select: { id: true, sourceType: true, senderEmail: true, rawPayload: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  // Same extractEventOccurredAt logic as triageSuggester (simplified)
  function extractEventOccurredAt(r: any): Date {
    const p = r.rawPayload ?? {};
    const cands = [
      p?.internalDate ? new Date(Number(p.internalDate)) : null,
      p?.date ? new Date(p.date) : null,
      p?.headers?.Date ? new Date(p.headers.Date) : null,
      p?.start?.dateTime ? new Date(p.start.dateTime) : null,
      p?.timestamp ? new Date(p.timestamp) : null,
    ];
    for (const c of cands) if (c && !isNaN(c.getTime())) return c;
    return r.createdAt;
  }

  let droppedDecided = 0;
  let droppedOldEvent = 0;
  let kept = 0;
  for (const r of rows) {
    if (decidedSet.has(r.id)) { droppedDecided++; continue; }
    const eventDate = extractEventOccurredAt(r);
    if (eventDate < sevenDaysAgo) { droppedOldEvent++; continue; }
    kept++;
  }
  console.log(`\n[5] Funnel on 500 newest rows (90d window):`);
  console.log(`    dropped: terminally decided           = ${droppedDecided}`);
  console.log(`    dropped: event-date older than 7d     = ${droppedOldEvent}`);
  console.log(`    kept (would be triaged for Attention) = ${kept}`);

  // 6. Anything in agent_actions in last 24h tagged with this user?
  // High count here means autonomous executor handled them (BRIEF section).
  const autonomous = await prisma.agentAction.count({
    where: {
      clientNumber: user.clientNumber, userId: user.id,
      status: 'done', requiresApproval: false,
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    } as any,
  });
  console.log(`\n[6] Autonomous actions in last 24h (BRIEF section):      ${autonomous}`);

  // 7. Run a SAMPLE through suggestForFeedEvent to see why they're being dropped
  console.log(`\n[7] Sampling 5 candidate rows through suggestForFeedEvent...`);
  const { suggestForFeedEvent } = await import('../services/triage/triageSuggester');
  const sample = rows.slice(0, 5);
  for (const r of sample) {
    try {
      const item = await suggestForFeedEvent({
        id: r.id,
        clientNumber: user.clientNumber,
        userId: user.id,
        sourceType: r.sourceType as any,
        senderEmail: r.senderEmail as any,
        senderName: null,
        rawPayload: r.rawPayload as any,
        createdAt: r.createdAt,
      } as any);
      if (!item) {
        console.log(`    ${r.id.slice(0,8)} → NULL (triage returned nothing)`);
      } else {
        console.log(`    ${r.id.slice(0,8)} → handledByRule=${(item as any).handledByRule} archetype=${(item as any).archetype} noise=${(item as any).noise} subj="${String((item as any).subject ?? '').slice(0, 50)}"`);
      }
    } catch (err: any) {
      console.log(`    ${r.id.slice(0,8)} → ERROR: ${err?.message ?? err}`);
    }
  }

  // 8. Direct call to buildAttentionList to see what it returns
  console.log(`\n[8] Calling buildAttentionList directly (this may take a few seconds)...`);
  try {
    const { buildAttentionList } = await import('../services/triage/triageSuggester');
    const list = await buildAttentionList(user.clientNumber, user.id, 50);
    console.log(`    buildAttentionList returned ${list.length} items.`);
    if (list.length > 0) {
      console.log('    First 3:');
      for (const it of list.slice(0, 3)) {
        console.log(`      ${(it as any).feedEventId?.slice(0,8)} archetype=${(it as any).archetype} noise=${(it as any).noise} crit=${(it as any).critical} subj="${String((it as any).subject ?? '').slice(0,60)}"`);
      }
    }
  } catch (err: any) {
    console.log(`    ERROR calling buildAttentionList: ${err?.message ?? err}`);
    console.log(err?.stack);
  }

  console.log('\n--- Diagnosis ---');
  if (kept === 0 && hidden.length > 50) {
    console.log('CAUSE: pattern_hidden is suppressing items. User clicked Hide pattern recently, fanning out.');
  } else if (kept === 0 && decisions.length > 30) {
    console.log('CAUSE: bulk terminal decisions (snooze/dismiss/etc.) cleared the list.');
  } else if (kept === 0 && feed7d === 0) {
    console.log('CAUSE: no recent inbox traffic — Gmail genuinely empty.');
  } else if (autonomous > 30) {
    console.log('CAUSE: autonomous executor handled everything — items moved to BRIEF section.');
  } else if (kept > 0) {
    console.log(`POSSIBLY: triage LLM is filtering all ${kept} candidates (handledByRule, low score, etc.).`);
    console.log('Run buildAttentionList directly to see how many survive triage:');
    console.log('  await (await import("./services/triage/triageSuggester")).buildAttentionList(...)');
  } else {
    console.log('UNCLEAR — manual investigation needed.');
  }

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
