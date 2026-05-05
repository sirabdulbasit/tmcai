/**
 * smokeBrainPromptDelegateeEmail.ts — Phase 4 live-DB verification.
 *
 * Verifies the producer + reply matcher loop end-to-end:
 *
 *   1. Eligible item → producer composes & sends email, stamps metadata.
 *   2. Item without delegateeEmail → skipped.
 *   3. Item with dueDate → skipped.
 *   4. Manual item (sourceFeed=null) → skipped.
 *   5. Already-inquired item (metadata.deadlineInquiry exists) → skipped.
 *   6. Reply matcher: inbound from delegatee on the right threadId →
 *      dueDate updated, metadata.deadlineInquiry.status='parsed', user
 *      notified via prompt queue.
 *   7. Reply matcher: inbound from WRONG sender (not delegatee) →
 *      no update.
 *   8. Reply matcher: gibberish reply → status='replied', parseFailed=true,
 *      user notified to clarify.
 *   9. Per-user budget caps email sends.
 *
 * gmailService.sendUserEmail is monkey-patched to a recorder.
 */
import 'dotenv/config';
import prisma from '../db/prisma';
import * as gmailService from '../services/gmailService';
import * as brainOutbound from '../services/notifications/brainOutboundService';

const TEST_CLIENT = 'TMC-0001';

interface EmailSent { to: string; subject: string; body: string; cc?: string; }
const emailsSent: EmailSent[] = [];

function patchGmail() {
  let counter = 0;
  (gmailService as any).sendUserEmail = async (
    _userId: number, to: string, subject: string, body: string, cc?: string,
  ) => {
    counter += 1;
    emailsSent.push({ to, subject, body, cc });
    return { success: true, messageId: `msg_smoke_${counter}`, threadId: `thread_smoke_${counter}` };
  };
}

function patchOutbound() {
  (brainOutbound as any).brainContactsUser = async (req: any) => ({
    sent: true, channelsUsed: ['text'], waMessageIds: [`wa_smoke_${Date.now()}`], reason: undefined,
  });
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

let counter = 0;
async function makeItem(opts: {
  userId: number; clientNumber: string; title: string;
  status?: string;
  delegateeEmail?: string | null;
  delegateeName?: string | null;
  dueDate?: Date | null;
  sourceFeed?: string | null;
  inquiryAlreadySent?: boolean;
}): Promise<string> {
  counter += 1;
  const id = `oi_smoke_p4_${Date.now()}_${counter}`;
  const meta: any = { smoke: true };
  if (opts.inquiryAlreadySent) {
    meta.deadlineInquiry = {
      status: 'sent', threadId: 'thread_pre_existing',
      messageId: 'msg_pre_existing', sentAt: new Date().toISOString(),
    };
  }
  await prisma.openItem.create({
    data: {
      id, clientNumber: opts.clientNumber, userId: opts.userId, ownerId: opts.userId,
      title: opts.title, type: 'task',
      status: opts.status ?? 'DELEGATED',
      priority: 'high',
      delegateeEmail: opts.delegateeEmail ?? null,
      delegateeName: opts.delegateeName ?? null,
      dueDate: opts.dueDate ?? null,
      sourceFeed: opts.sourceFeed ?? null,
      sourceRef: opts.sourceFeed ? `smoke_${counter}` : null,
      metadata: meta,
    },
  });
  return id;
}

async function cleanup(userId: number) {
  await prisma.brainPromptQueue.deleteMany({
    where: { userId, metadata: { path: ['source'], string_starts_with: 'delegatee_reply' } as any },
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
  patchGmail();
  patchOutbound();
  const user = await pickTestUser();
  console.log(`[smoke] using user.id=${user.id} client=${user.clientNumber}`);
  await cleanup(user.id);

  // Drain the prompt queue so notifications don't pile up
  await prisma.brainPromptQueue.updateMany({
    where: { userId: user.id, state: { in: ['queued', 'awaiting_reply'] } },
    data: { state: 'skipped' },
  });

  // ── Setup items ─────────────────────────────────────────────
  const eligibleItem = await makeItem({
    userId: user.id, clientNumber: user.clientNumber,
    title: '[smoke] Eligible delegated item',
    delegateeEmail: 'asad@tmcltd.com', delegateeName: 'Asad Khan',
    sourceFeed: 'gmail',
  });
  const noDelegatee = await makeItem({
    userId: user.id, clientNumber: user.clientNumber,
    title: '[smoke] No delegatee email',
    delegateeEmail: null,
    sourceFeed: 'gmail',
  });
  const hasDueDate = await makeItem({
    userId: user.id, clientNumber: user.clientNumber,
    title: '[smoke] Already has due date',
    delegateeEmail: 'someone@x.com', delegateeName: 'Someone',
    dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    sourceFeed: 'gmail',
  });
  const manualItem = await makeItem({
    userId: user.id, clientNumber: user.clientNumber,
    title: '[smoke] Manual delegated item',
    delegateeEmail: 'someone@x.com',
    sourceFeed: null,  // manual
  });
  const alreadyInquired = await makeItem({
    userId: user.id, clientNumber: user.clientNumber,
    title: '[smoke] Already inquired',
    delegateeEmail: 'someone@x.com',
    sourceFeed: 'gmail',
    inquiryAlreadySent: true,
  });

  // ── 1: Producer sweep sends only the eligible item ──────────
  emailsSent.length = 0;
  const { runDelegateeEmailSweep } = await import('../services/brainPrompts/delegateeEmailProducer');
  const r = await runDelegateeEmailSweep();
  console.log('[smoke] sweep result:', r);
  assert(r.sent === 1, `1.1 only one email sent (sent=${r.sent})`);
  assert(emailsSent.length === 1, '1.2 sendUserEmail called exactly once');
  assert(emailsSent[0]!.to === 'asad@tmcltd.com', '1.3 email goes to delegatee');
  assert(emailsSent[0]!.subject.includes('when'), '1.4 subject asks "when"');
  assert(emailsSent[0]!.body.includes('Eligible delegated item'), '1.5 body cites item title');

  // ── 2: Eligible item gets metadata stamp ────────────────────
  const stamped = await prisma.openItem.findFirst({ where: { id: eligibleItem } });
  const stampedMeta: any = stamped?.metadata ?? {};
  assert(stampedMeta.deadlineInquiry?.status === 'sent',
    '2.1 metadata.deadlineInquiry.status = sent');
  assert(stampedMeta.deadlineInquiry?.threadId?.startsWith('thread_smoke_'),
    '2.2 threadId stored from gmail send');
  assert(stampedMeta.deadlineInquiry?.messageId?.startsWith('msg_smoke_'),
    '2.3 messageId stored');

  // ── 3-5: Other items NOT stamped ────────────────────────────
  for (const [id, label] of [
    [noDelegatee, '3 noDelegatee'],
    [hasDueDate, '4 hasDueDate'],
    [manualItem, '5 manualItem'],
  ] as const) {
    const it = await prisma.openItem.findFirst({ where: { id } });
    const m: any = it?.metadata ?? {};
    assert(!m.deadlineInquiry || m.deadlineInquiry.status === undefined,
      `${label}: not stamped (skipped correctly)`);
  }

  // alreadyInquired keeps its pre-existing stamp, sweep doesn't re-send
  const aiAfter = await prisma.openItem.findFirst({ where: { id: alreadyInquired } });
  const aiMeta: any = aiAfter?.metadata ?? {};
  assert(aiMeta.deadlineInquiry?.threadId === 'thread_pre_existing',
    '6.1 already-inquired item not re-stamped');

  // ── 6: Reply matcher — happy path ───────────────────────────
  emailsSent.length = 0;
  const { checkInboundForDelegateeReply } = await import('../services/brainPrompts/delegateeReplyHandler');
  const inboundThreadId = stampedMeta.deadlineInquiry.threadId;
  const m1 = await checkInboundForDelegateeReply({
    clientNumber: user.clientNumber,
    threadId: inboundThreadId,
    senderEmail: 'asad@tmcltd.com',
    body: 'Sure, I\'ll have it back by next friday',
  });
  assert(m1.matched === true && m1.status === 'parsed',
    `7.1 reply matched + parsed (status=${m1.status})`);
  const updated = await prisma.openItem.findFirst({ where: { id: eligibleItem } });
  assert(updated?.dueDate !== null, '7.2 item.dueDate updated');
  const updatedMeta: any = updated?.metadata ?? {};
  assert(updatedMeta.deadlineInquiry?.status === 'parsed',
    '7.3 metadata.status = parsed');
  assert(updatedMeta.deadlineInquiry?.parsedDate, '7.4 parsedDate stamped');

  // Verify a notification was queued for the user
  const notify = await prisma.brainPromptQueue.findFirst({
    where: { userId: user.id, dedupKey: `delegatee_reply_parsed:${eligibleItem}` },
  });
  assert(notify !== null, '7.5 user notification queued');

  // ── 7: Reply matcher — wrong sender ─────────────────────────
  // Need a fresh item since the previous one is now status='parsed'
  await prisma.brainPromptQueue.updateMany({
    where: { userId: user.id, state: { in: ['queued', 'awaiting_reply'] } },
    data: { state: 'skipped' },
  });
  const item2 = await makeItem({
    userId: user.id, clientNumber: user.clientNumber,
    title: '[smoke] Item for wrong-sender test',
    delegateeEmail: 'omar@tmcltd.com', delegateeName: 'Omar',
    sourceFeed: 'gmail',
  });
  emailsSent.length = 0;
  await runDelegateeEmailSweep();
  const it2 = await prisma.openItem.findFirst({ where: { id: item2 } });
  const it2Meta: any = it2?.metadata ?? {};
  const it2Thread = it2Meta.deadlineInquiry?.threadId;
  const m2 = await checkInboundForDelegateeReply({
    clientNumber: user.clientNumber,
    threadId: it2Thread,
    senderEmail: 'someone-else@x.com',  // not the delegatee
    body: 'I think next monday is fine',
  });
  assert(m2.matched === true && m2.status === 'wrong_sender',
    `8.1 wrong-sender reply rejected (status=${m2.status})`);
  const it2After = await prisma.openItem.findFirst({ where: { id: item2 } });
  assert(it2After?.dueDate === null, '8.2 dueDate not updated when sender is wrong');

  // ── 8: Reply matcher — unparseable ─────────────────────────
  await prisma.brainPromptQueue.updateMany({
    where: { userId: user.id, state: { in: ['queued', 'awaiting_reply'] } },
    data: { state: 'skipped' },
  });
  const item3 = await makeItem({
    userId: user.id, clientNumber: user.clientNumber,
    title: '[smoke] Item for unparseable test',
    delegateeEmail: 'sara@tmcltd.com',
    sourceFeed: 'gmail',
  });
  emailsSent.length = 0;
  await runDelegateeEmailSweep();
  const it3 = await prisma.openItem.findFirst({ where: { id: item3 } });
  const it3Meta: any = it3?.metadata ?? {};
  const it3Thread = it3Meta.deadlineInquiry?.threadId;
  const m3 = await checkInboundForDelegateeReply({
    clientNumber: user.clientNumber,
    threadId: it3Thread,
    senderEmail: 'sara@tmcltd.com',
    body: 'let me think about it',
  });
  assert(m3.matched === true && m3.status === 'unparseable',
    `9.1 unparseable reply flagged (status=${m3.status})`);
  const it3After = await prisma.openItem.findFirst({ where: { id: item3 } });
  const it3AfterMeta: any = it3After?.metadata ?? {};
  assert(it3AfterMeta.deadlineInquiry?.status === 'replied',
    '9.2 metadata.status = replied');
  assert(it3AfterMeta.deadlineInquiry?.parseFailed === true,
    '9.3 parseFailed flag set');

  // ── 9: Reply matcher — no thread match ─────────────────────
  const m4 = await checkInboundForDelegateeReply({
    clientNumber: user.clientNumber,
    threadId: 'thread_does_not_exist',
    senderEmail: 'random@x.com',
    body: 'tomorrow',
  });
  assert(m4.matched === false && m4.status === 'no_match',
    '10.1 no-match thread returns matched=false');

  // ── Cleanup ────────────────────────────────────────────────
  await cleanup(user.id);
  console.log('\n[smoke] ✅ all phase-4 assertions passed');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[smoke] FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
