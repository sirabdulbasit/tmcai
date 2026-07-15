/**
 * smokeBrainPromptQueue.ts — end-to-end test of the Brain prompt queue
 * against the live local DB. Verifies the full Phase 1 surface:
 *
 *   1. Enqueue a routine prompt → it lands in awaiting_reply
 *   2. Enqueue a second routine prompt → it stays queued
 *   3. Enqueue a high-criticality prompt with the slot full → still queued
 *   4. Enqueue a top-criticality prompt → bypasses queue, recorded as answered
 *   5. Dedup_key prevents duplicates
 *   6. recordAnswer + sendNextPrompt advances the conversation
 *   7. expireStalePrompts auto-skips past-TTL prompts and dispatches next
 *   8. Partial unique index prevents two awaiting_reply rows per user
 *
 * brainContactsUser is monkey-patched to a no-op recorder so we don't fire
 * real WhatsApp messages from the smoke. The DB writes are real.
 *
 * Usage:  npx ts-node src/scripts/smokeBrainPromptQueue.ts
 */
import 'dotenv/config';
import prisma from '../db/prisma';
import * as brainOutbound from '../services/notifications/brainOutboundService';
import { enqueueBrainPrompt, sendNextPrompt, expireStalePrompts, recordAnswer, getAwaitingPrompt } from '../services/brainPrompts/brainPromptQueueService';

const TEST_CLIENT = 'TMC-0001';

interface OutboundCall { kind: string; channel?: string; urgency?: string; body: string; }
const outboundCalls: OutboundCall[] = [];

function patchOutbound() {
  (brainOutbound as any).brainContactsUser = async (req: any) => {
    outboundCalls.push({ kind: req.kind, channel: req.channel, urgency: req.urgency, body: req.body });
    return {
      sent: true,
      channelsUsed: [req.channel === 'auto' ? 'text' : req.channel ?? 'text'],
      waMessageIds: [`wa_smoke_${outboundCalls.length}`],
    };
  };
}

async function pickTestUser(): Promise<{ id: number; clientNumber: string }> {
  const u = await prisma.user.findFirst({
    where: { clientNumber: TEST_CLIENT, isActive: true },
    select: { id: true, clientNumber: true },
    orderBy: { id: 'asc' },
  });
  if (!u) throw new Error(`No active user found in ${TEST_CLIENT}`);
  return u;
}

async function cleanupForUser(userId: number) {
  // Remove only test rows so we don't clobber real prompts. Test rows are
  // tagged with metadata.smoke = true.
  await prisma.brainPromptQueue.deleteMany({
    where: { userId, metadata: { path: ['smoke'], equals: true } as any },
  });
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
  await cleanupForUser(user.id);

  // ── 1. Routine prompt → sent immediately ─────────────────────
  outboundCalls.length = 0;
  const r1 = await enqueueBrainPrompt({
    userId: user.id, clientNumber: user.clientNumber,
    question: '[smoke] Q1 — routine: by when do you want X?',
    criticality: 'routine',
    metadata: { smoke: true },
  });
  assert(r1.status === 'sent_now', '1.1 routine prompt with empty queue dispatches immediately');
  assert(outboundCalls.length === 1 && outboundCalls[0].channel === 'text',
    '1.2 routine prompt routes through text channel');
  assert(outboundCalls[0].urgency === 'normal', '1.3 routine prompt urgency=normal');

  const inFlight1 = await prisma.brainPromptQueue.findFirst({
    where: { userId: user.id, state: 'awaiting_reply' },
  });
  assert(inFlight1?.question.includes('Q1'), '1.4 Q1 is awaiting_reply in DB');

  // ── 2. Second routine prompt → stays queued ──────────────────
  outboundCalls.length = 0;
  const r2 = await enqueueBrainPrompt({
    userId: user.id, clientNumber: user.clientNumber,
    question: '[smoke] Q2 — routine: who owns Y?',
    criticality: 'routine',
    metadata: { smoke: true },
  });
  assert(r2.status === 'queued', '2.1 second routine prompt is queued, not sent');
  assert(outboundCalls.length === 0, '2.2 no outbound call when slot is full');

  // ── 3. High-criticality enqueued behind awaiting_reply → queued, not sent ──
  outboundCalls.length = 0;
  const r3 = await enqueueBrainPrompt({
    userId: user.id, clientNumber: user.clientNumber,
    question: '[smoke] Q3 — high: CFO needs answer today.',
    criticality: 'high',
    metadata: { smoke: true },
  });
  assert(r3.status === 'queued', '3.1 high prompt queues when slot is full');
  assert(outboundCalls.length === 0, '3.2 no outbound while slot busy');

  // ── 4. Top-criticality → bypasses queue, fires immediately ───
  outboundCalls.length = 0;
  const r4 = await enqueueBrainPrompt({
    userId: user.id, clientNumber: user.clientNumber,
    question: '[smoke] Q4 — top: production processor down, decision needed.',
    criticality: 'top',
    metadata: { smoke: true },
  });
  assert(r4.status === 'top_dispatched', '4.1 top prompt bypasses queue');
  assert(outboundCalls.length === 1 && outboundCalls[0].channel === 'call_business',
    '4.2 top prompt routes through call_business');
  assert(outboundCalls[0].urgency === 'emergency', '4.3 top prompt urgency=emergency');
  // Q1 should still be awaiting_reply — top did NOT take its slot.
  const stillInFlight = await prisma.brainPromptQueue.findFirst({
    where: { userId: user.id, state: 'awaiting_reply' },
  });
  assert(stillInFlight?.question.includes('Q1'),
    '4.4 routine conversation still in flight after top dispatch');

  // ── 5. Dedup ─────────────────────────────────────────────────
  outboundCalls.length = 0;
  const r5a = await enqueueBrainPrompt({
    userId: user.id, clientNumber: user.clientNumber,
    question: '[smoke] Q5 — dedup test',
    dedupKey: 'smoke:dedup:1',
    metadata: { smoke: true },
  });
  const r5b = await enqueueBrainPrompt({
    userId: user.id, clientNumber: user.clientNumber,
    question: '[smoke] Q5 — dedup test (duplicate)',
    dedupKey: 'smoke:dedup:1',
    metadata: { smoke: true },
  });
  assert(r5a.status === 'queued' || r5a.status === 'sent_now', '5.1 first dedup_key prompt accepted');
  assert(r5b.status === 'duplicate', '5.2 second dedup_key prompt is rejected as duplicate');

  // ── 6. Reply flow ────────────────────────────────────────────
  outboundCalls.length = 0;
  const awaiting = await getAwaitingPrompt(user.id);
  assert(awaiting?.question.includes('Q1'), '6.1 awaiting prompt is Q1');
  await recordAnswer(awaiting!.id, 'tomorrow');
  const after = await prisma.brainPromptQueue.findFirst({
    where: { id: awaiting!.id },
  });
  assert(after?.state === 'answered', '6.2 prompt marked answered');
  assert(after?.answerText === 'tomorrow', '6.3 answer_text persisted');

  const next = await sendNextPrompt(user.id);
  assert(next !== null, '6.4 next prompt dispatched after answer');
  assert(outboundCalls.length === 1, '6.5 outbound fired for next prompt');
  // Highest-criticality first: Q3 (high) should win over Q2/Q5 (routine).
  assert(outboundCalls[0].body.includes('Q3'),
    '6.6 high prompt picked over routine when both queued');

  // ── 7. Expiry sweep ──────────────────────────────────────────
  // Force the now-awaiting Q3 to have expired in the past.
  const expired = await prisma.brainPromptQueue.findFirst({
    where: { userId: user.id, state: 'awaiting_reply' },
  });
  await prisma.brainPromptQueue.update({
    where: { id: expired!.id },
    data: { expiresAt: new Date(Date.now() - 10_000) },
  });
  outboundCalls.length = 0;
  const sweep = await expireStalePrompts();
  assert(sweep.expired >= 1, '7.1 expired sweep counted at least 1');
  const expiredRow = await prisma.brainPromptQueue.findFirst({
    where: { id: expired!.id },
  });
  assert(expiredRow?.state === 'expired', '7.2 expired prompt state=expired');
  assert(outboundCalls.length >= 1, '7.3 next prompt dispatched after expiry');

  // ── 8. Partial unique index — DB-level guarantee ─────────────
  // Try to insert a second awaiting_reply row directly. PG must reject.
  let pgRejected = false;
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO brain_prompt_queue (client_number, user_id, question, state, metadata)
       VALUES ($1, $2, $3, 'awaiting_reply', '{"smoke": true}'::jsonb)`,
      user.clientNumber, user.id, '[smoke] direct insert attempt',
    );
  } catch (err: any) {
    // PG unique-violation surfaces as either the literal "unique" / SQLSTATE
    // 23505 / "already exists" depending on driver wrapping. Match all three.
    pgRejected = /unique/i.test(err.message)
      || /23505/.test(err.message)
      || /already exists/i.test(err.message);
  }
  assert(pgRejected, '8.1 partial unique index rejects second awaiting_reply per user');

  // ── Cleanup ─────────────────────────────────────────────────
  await cleanupForUser(user.id);
  console.log('\n[smoke] ✅ all phase-1 assertions passed');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[smoke] FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
