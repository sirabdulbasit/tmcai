/**
 * smokeCriticality.ts — exercise the criticality engine against this
 * tenant's current attention list. Prints:
 *   - raw count, critical count (post-cap), top scores + reasons
 *   - confirms WhatsApp bundle composition without actually sending
 */
import prisma from '../db/prisma';
import { buildAttentionList } from '../services/triage/triageSuggester';

async function main() {
  const clientNumber = process.argv[2] ?? 'TMC-0001';
  const userId = Number(process.argv[3] ?? 5);

  console.log(`[critical] tenant=${clientNumber} user=${userId}\n`);
  const started = Date.now();
  const items = await buildAttentionList(clientNumber, userId, 50);
  const elapsed = Date.now() - started;
  console.log(`[critical] buildAttentionList returned ${items.length} items in ${elapsed}ms`);

  const criticals = items.filter((i) => i.critical);
  console.log(`[critical] critical band: ${criticals.length} (capped at 5)`);
  const bandCounts = items.reduce<Record<string, number>>((acc, it) => {
    const b = it.criticality?.band ?? 'n/a';
    acc[b] = (acc[b] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[critical] band distribution: ${JSON.stringify(bandCounts)}`);

  console.log('\n── Top 10 by composite score ──');
  const sorted = [...items].sort((a, b) =>
    (b.criticality?.composite ?? 0) - (a.criticality?.composite ?? 0),
  );
  for (const it of sorted.slice(0, 10)) {
    const c = it.criticality;
    const mark = it.critical ? '🔴' : c?.band === 'high' ? '🟠' : c?.band === 'medium' ? '🟡' : '⚪️';
    console.log(`${mark} ${(c?.composite ?? 0).toFixed(2)}  ${c?.band ?? 'n/a'}  — ${it.from.slice(0, 40).padEnd(40)}  ${it.subject.slice(0, 60)}`);
    if (c?.reasons?.length) {
      for (const r of c.reasons.slice(0, 3)) console.log(`     · ${r.slice(0, 140)}`);
    }
    if (c?.dimensions) {
      const d = c.dimensions;
      console.log(`     dims: time=${d.timePressure.toFixed(2)} impact=${d.impact.toFixed(2)} rel=${d.relationshipRisk.toFixed(2)} casc=${d.cascade.toFixed(2)} anom=${d.patternAnomaly.toFixed(2)}`);
    }
  }

  console.log('\n── If WA bundle fired now ──');
  if (criticals.length === 0) {
    console.log('  no criticals → no WA push');
  } else {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, whatsappConnection: { select: { phoneNumber: true } } },
    });
    const first = (user?.name ?? 'there').split(' ')[0];
    console.log(`  🔴 Brain: ${criticals.length} critical item${criticals.length === 1 ? '' : 's'} need you, ${first}`);
    console.log('');
    for (const it of criticals.slice(0, 5)) {
      const sender = it.from.split('<')[0].trim() || it.fromEmail;
      const why = it.criticality?.reasons?.[0] ?? '';
      console.log(`  • ${sender} — ${it.subject.slice(0, 70)}${why ? ` (${why.slice(0, 70)})` : ''}`);
    }
    console.log(`\n  → would be sent to: ${user?.whatsappConnection?.phoneNumber ?? '(no WA number configured — push skipped)'}`);
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
