/**
 * smokeBrainPromptReplyFlow.ts — end-to-end Phase-2 test against live DB.
 *
 * Verifies the full reply-and-advance loop:
 *
 *   1. Enqueue a routine prompt with side_effect=set_due_date pointing
 *      at a real open item.
 *   2. Simulate the user replying "tomorrow" via the prompt reply handler.
 *      Verify: prompt → answered, item.dueDate → tomorrow, ack composed.
 *   3. Enqueue a second prompt with side_effect=assign_owner.
 *   4. Reply "Asad Khan <asad@tmcltd.com>". Verify: item.delegateeName +
 *      delegateeEmail set, status = DELEGATED.
 *   5. Enqueue a free_form_note prompt. Reply with arbitrary text.
 *      Verify: notes array on item appended.
 *   6. Followup integration: simulate a stale DELEGATED item, run
 *      followupWorker.runFollowupSweep(dryRun=false), verify a queue
 *      row was created via enqueueBrainPrompt (NOT a direct
 *      brainContactsUser send).
 *   7. Unparseable date phrase flags item with metadata.dueDateNeedsClarification.
 *
 * brainContactsUser is monkey-patched to a recorder.
 *
 * Usage:  npx ts-node src/scripts/smokeBrainPromptReplyFlow.ts
 */
import 'dotenv/config';
import prisma from '../db/prisma';
import * as brainOutbound from '../services/notifications/brainOutboundService';
import { enqueueBrainPrompt } from '../services/brainPrompts/brainPromptQueueService';
import { handlePromptReply } from '../services/brainPrompts/promptReplyHandler';

const TEST_CLIENT = 'TMC-0001';
interface OutboundCall { kind: string; channel?: string; body: string; }
const outboundCalls: OutboundCall[] = [];

function patchOutbound() {
  (brainOutbound as any).brainContactsUser = async (req: any) => {
    outboundCalls.push({ kind: req.kind, channel: req.channel, body: req.body });
    return {
      sent: true,
      channelsUsed: [req.channel === 'auto' ? 'text' : req.channel ?? 'text'],
      waMessageIds: [`wa_smoke_${outboundCalls.length}`],
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

async function makeTestItem(userId: number, clientNumber: string, title: string) {
  const id = `oi_smoke_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  const it = await prisma.openItem.create({
    data: {
      id, clientNumber, userId, ownerId: userId,
      title, type: 'task', status: 'NEW', priority: 'medium',
      metadata: { smoke: true } as any,
    },
    select: { id: true },
  });
  return it.id;
}

async function cleanup(userId: number) {
  await prisma.brainPromptQueue.deleteMany({
    where: { userId, metadata: { path: ['smoke'], equals: true } as any },
  }).catch(() => {});
  await prisma.openItem.deleteMany({
    where: { userId, metadata: { path: ['smoke'], equals: true } as any },
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
  patchOutbound();
  const user = await pickTestUser();
  console.log(`[smoke] using user.id=${user.id} client=${user.clientNumber}`);
  await cleanup(user.id);

  // ── 1 + 2: set_due_date ──────────────────────────────────────
  outboundCalls.length = 0;
  const item1 = await makeTestItem(user.id, user.clientNumber, '[smoke] Item needing due date');
  const e1 = await enqueueBrainPrompt({
    userId: user.id, clientNumber: user.clientNumber,
    question: '[smoke] When is the deadline for the test item?',
    openItemId: item1,
    sideEffect: { kind: 'set_due_date', openItemId: item1 },
    metadata: { smoke: true },
  });
  assert(e1.status === 'sent_now', '1. enqueue dispatched immediately');

  const r1 = await handlePromptReply({ userId: user.id, text: 'tomorrow' });
  assert(r1.handled === true, '2.1 reply handled');
  assert(r1.sideEffectStatus === 'applied', '2.2 set_due_date applied');
  assert(r1.ackMessage?.includes('Got it'), '2.3 ack composed');

  const updated1 = await prisma.openItem.findFirst({ where: { id: item1 } });
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0,0,0,0);
  assert(updated1?.dueDate?.toDateString() === tomorrow.toDateString(),
    '2.4 open item dueDate set to tomorrow');

  // ── 3 + 4: assign_owner ──────────────────────────────────────
  outboundCalls.length = 0;
  const item2 = await makeTestItem(user.id, user.clientNumber, '[smoke] Item needing owner');
  await enqueueBrainPrompt({
    userId: user.id, clientNumber: user.clientNumber,
    question: '[smoke] Who owns the test item?',
    openItemId: item2,
    sideEffect: { kind: 'assign_owner', openItemId: item2 },
    metadata: { smoke: true },
  });
  const r2 = await handlePromptReply({ userId: user.id, text: 'Asad Khan <asad@tmcltd.com>' });
  assert(r2.handled === true, '3.1 reply handled');
  assert(r2.sideEffectStatus === 'applied', '3.2 assign_owner applied');
  const updated2 = await prisma.openItem.findFirst({ where: { id: item2 } });
  assert(updated2?.delegateeName === 'Asad Khan', '3.3 delegateeName set');
  assert(updated2?.delegateeEmail === 'asad@tmcltd.com', '3.4 delegateeEmail set');
  assert(updated2?.status === 'DELEGATED', '3.5 status moved to DELEGATED');

  // ── 5: free_form_note ────────────────────────────────────────
  outboundCalls.length = 0;
  const item3 = await makeTestItem(user.id, user.clientNumber, '[smoke] Item needing note');
  await enqueueBrainPrompt({
    userId: user.id, clientNumber: user.clientNumber,
    question: '[smoke] Any update on this?',
    openItemId: item3,
    sideEffect: { kind: 'free_form_note', openItemId: item3 },
    metadata: { smoke: true },
  });
  const r3 = await handlePromptReply({
    userId: user.id, text: 'spoke to vendor, they ship next week',
  });
  assert(r3.handled === true && r3.sideEffectStatus === 'applied', '4.1 free_form_note applied');
  const updated3 = await prisma.openItem.findFirst({ where: { id: item3 } });
  const notes3 = (updated3?.notes as any[]) ?? [];
  assert(notes3.some((n) => n.text?.includes('vendor')),
    '4.2 note appended to open item');

  // ── 6: followupWorker integration ────────────────────────────
  // Make a DELEGATED item that's silent past the 3-day threshold and
  // make sure the worker enqueues a queue row, not a direct outbound.
  outboundCalls.length = 0;
  const stale = await prisma.openItem.create({
    data: {
      id: `oi_smoke_stale_${Date.now()}`,
      clientNumber: user.clientNumber, userId: user.id, ownerId: user.id,
      title: '[smoke] Stale delegated item',
      type: 'task', status: 'DELEGATED', priority: 'medium',
      delegateeName: 'Test Person', delegateeEmail: 'test@example.com',
      metadata: { smoke: true } as any,
      updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    },
    select: { id: true },
  });
  // updatedAt is auto-managed; force it back via raw SQL.
  await prisma.$executeRawUnsafe(
    `UPDATE open_items SET updated_at = NOW() - INTERVAL '5 days' WHERE id = $1`,
    stale.id,
  );
  // Drain the queue so a fresh slot is available for the followup
  await prisma.brainPromptQueue.updateMany({
    where: { userId: user.id, state: { in: ['queued','awaiting_reply'] } },
    data: { state: 'skipped' },
  });
  outboundCalls.length = 0;
  const { runFollowupSweep } = await import('../services/openItems/followupWorker');
  const sweep = await runFollowupSweep({});
  assert(sweep.nudged >= 1, `5.1 followup sweep nudged at least 1 (was ${sweep.nudged})`);
  // Verify the nudge landed in brain_prompt_queue rather than going
  // straight through brainContactsUser as a 'followup_nudge' kind.
  const queueRow = await prisma.brainPromptQueue.findFirst({
    where: { userId: user.id, openItemId: stale.id },
  });
  assert(queueRow !== null, '5.2 followup nudge created a brain_prompt_queue row');
  assert(queueRow?.dedupKey?.startsWith('followup:'), '5.3 dedup_key formatted correctly');
  // Outbound was triggered by the queue dispatch — kind should be 'brain_prompt' (not 'followup_nudge')
  const followupOutbound = outboundCalls.find((c) => c.body.includes('Stale'));
  assert(followupOutbound?.kind === 'brain_prompt',
    '5.4 outbound went through queue dispatcher (kind=brain_prompt)');

  // ── 7: unparseable date flags item ────────────────────────────
  outboundCalls.length = 0;
  // Drain the queue first so the new prompt becomes awaiting_reply
  await prisma.brainPromptQueue.updateMany({
    where: { userId: user.id, state: { in: ['queued','awaiting_reply'] } },
    data: { state: 'skipped' },
  });
  const item4 = await makeTestItem(user.id, user.clientNumber, '[smoke] Item with vague answer');
  await enqueueBrainPrompt({
    userId: user.id, clientNumber: user.clientNumber,
    question: '[smoke] When?',
    openItemId: item4,
    sideEffect: { kind: 'set_due_date', openItemId: item4 },
    metadata: { smoke: true },
  });
  const r4 = await handlePromptReply({ userId: user.id, text: 'no idea, whenever' });
  assert(r4.handled === true, '6.1 unparseable reply still consumed');
  assert(r4.sideEffectStatus === 'failed', '6.2 side-effect marked failed');
  const updated4 = await prisma.openItem.findFirst({ where: { id: item4 } });
  const meta4 = (updated4?.metadata as any) ?? {};
  assert(meta4.dueDateNeedsClarification === true,
    '6.3 item flagged with dueDateNeedsClarification');

  // ── Cleanup ──────────────────────────────────────────────────
  await cleanup(user.id);
  await prisma.brainPromptQueue.deleteMany({ where: { userId: user.id, openItemId: stale.id } });
  await prisma.openItem.deleteMany({ where: { id: stale.id } });
  console.log('\n[smoke] ✅ all phase-2 assertions passed');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[smoke] FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
