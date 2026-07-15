/**
 * smokeCommitments.ts — verify that an outbound message containing a
 * promise gets converted into open_items via the commitmentExtractor.
 */
import prisma from '../db/prisma';
import { runWithoutTenant } from '../db/tenantContext';
import { extractAndFileCommitments } from '../services/knowledge/commitmentExtractor';

async function main() {
  await runWithoutTenant(async () => {
    const clientNumber = 'TMC-0001';
    const userId = 5;
    const sourceRef = `smoke:${Date.now()}`;

    const body = `Hi Sarah, thanks for the call earlier.

I'll send the revised proposal by Monday EOD with the updated pricing and the legal redlines we discussed. We'll also loop in Fahim on the integration questions before Wednesday.

Let me know if you'd like me to set up a follow-up call.

Best,
Abdul`;

    console.log('[commit] body:', body.slice(0, 100), '…');
    const r = await extractAndFileCommitments({
      clientNumber, userId, channel: 'email', sourceRef,
      recipient: 'sarah@acme.example', subject: 'Re: Acme proposal',
      body, sentAt: new Date(),
    });
    console.log('[commit] result:', r);

    if (r.openItemIds.length === 0) {
      console.log('[commit] ✗ no open_items filed');
    } else {
      console.log('\n[commit] open_items filed:');
      for (const oid of r.openItemIds) {
        const item = await prisma.openItem.findUnique({
          where: { id: oid },
          select: { title: true, dueDate: true, priority: true, sourceFeed: true, sourceRef: true, description: true },
        });
        console.log('\n  ─────');
        console.log('  title       :', item?.title);
        console.log('  priority    :', item?.priority);
        console.log('  dueDate     :', item?.dueDate?.toISOString());
        console.log('  sourceFeed  :', item?.sourceFeed);
        console.log('  sourceRef   :', item?.sourceRef);
        console.log('  description :', item?.description?.slice(0, 200));
      }
    }

    // Idempotency check
    console.log('\n[commit] re-running same input (should detect duplicate)...');
    const r2 = await extractAndFileCommitments({
      clientNumber, userId, channel: 'email', sourceRef,
      recipient: 'sarah@acme.example', subject: 'Re: Acme proposal', body, sentAt: new Date(),
    });
    console.log('[commit] second run:', r2);
    console.log('  PASS expected: skipped=already_processed →', r2.skipped === 'already_processed' ? '✓' : '✗');

    // Negative — message with no commitment
    console.log('\n[commit] negative test (acknowledgment only) ...');
    const r3 = await extractAndFileCommitments({
      clientNumber, userId, channel: 'email', sourceRef: `smoke:neg:${Date.now()}`,
      recipient: 'noone@x', subject: 'Re: x', body: 'Sounds good, thanks!', sentAt: new Date(),
    });
    console.log('[commit] negative:', r3);
    console.log('  PASS expected: skipped=no_hint →', r3.skipped === 'no_hint' ? '✓' : '✗');
  });

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
