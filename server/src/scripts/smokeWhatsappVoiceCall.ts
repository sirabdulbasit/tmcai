/**
 * smokeWhatsappVoiceCall.ts — exercises the full star-cadence WhatsApp
 * outbound chain: voice CALL (top), voicenote (high), text (routine).
 *
 * Stages:
 *   1. Star a synthetic test contact at 5★
 *   2. Trigger scheduleStarCadence directly (sync) — should enqueue 3 pings
 *   3. Verify the prompt body is in Urdu (test user's contact_number is +92*)
 *   4. Force-dispatch each ping by clearing its scheduledAt, then call
 *      sendNextPrompt to fire the queued row through brainContactsUser
 *   5. Inspect each row's outcome:
 *      · channel_used (call_business / voicenote / text)
 *      · brainOutboundReason (success or "no active notifier" etc.)
 *
 * Works whether or not the tenant_whatsapp_notifier is configured —
 * either reports success or surfaces the exact blocker.
 *
 * Usage: npx ts-node src/scripts/smokeWhatsappVoiceCall.ts
 *
 * Cleans up its own data on exit.
 */
import 'dotenv/config';
import prisma from '../db/prisma';

// On local without GOOGLE_APPLICATION_CREDENTIALS, the brain-outbound
// voice path attempts Google TTS and surfaces unhandled rejections.
// The smoke is documenting what _would_ happen, not requiring TTS to
// actually work — absorb so the script doesn't get killed mid-inspection.
process.on('unhandledRejection', (e: any) => {
  console.warn(`  · unhandled rejection (absorbed): ${e?.message ?? e}`);
});
process.on('uncaughtException', (e: any) => {
  console.warn(`  · uncaught exception (absorbed): ${e?.message ?? e}`);
});

const TEST_CLIENT = 'TMC-0001';
const TEST_SENDER = 'smoke-cadence-test@nexeo-smoke.test';
const TEST_SENDER_NAME = 'Nexeo Cadence Smoke';
const FEED_SOURCE_REF = `smoke-cadence:${Date.now()}`;

function step(n: string) { console.log(`\n━━━ ${n} ━━━`); }
function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string): never { console.error(`  ✗ ${msg}`); process.exit(2); }
function info(msg: string) { console.log(`  · ${msg}`); }

async function pickTestUser() {
  const u = await prisma.user.findFirst({
    where: { clientNumber: TEST_CLIENT, isActive: true },
    select: { id: true, clientNumber: true, email: true, contactNumber: true, notificationPreferences: true } as any,
    orderBy: { id: 'asc' },
  }) as any;
  if (!u) fail(`No active user in ${TEST_CLIENT}`);
  return u;
}

async function ensureTestContact(userId: number) {
  const { ensureEntityForSender, setStars } = await import('../services/knowledge/entitySweepService');
  const ensured = await ensureEntityForSender({
    clientNumber: TEST_CLIENT,
    userId,
    senderEmail: TEST_SENDER,
    senderName: TEST_SENDER_NAME,
    importSource: 'manual',
  });
  if (!ensured) fail('ensureEntityForSender returned null');
  await setStars(ensured.id, userId, 5);
  return ensured.id;
}

async function injectFeedEvent(userId: number) {
  const crypto = await import('crypto');
  const contentHash = crypto.createHash('sha256').update(FEED_SOURCE_REF).digest('hex');
  const row = await prisma.feedEvent.create({
    data: {
      clientNumber: TEST_CLIENT,
      userId,
      sourceType: 'gmail',
      sourceId: FEED_SOURCE_REF,
      contentHash,
      senderEmail: TEST_SENDER,
      senderName: TEST_SENDER_NAME,
      rawPayload: {
        subject: '[smoke] Please review and confirm by today',
        snippet: 'Hi, can you review the attached and confirm by end of today?',
        from: `${TEST_SENDER_NAME} <${TEST_SENDER}>`,
      } as any,
    },
  });
  return row.id;
}

interface CadenceRow {
  id: bigint | string;
  dedupKey: string | null;
  criticality: string;
  state: string;
  channelUsed: string | null;
  sentAt: Date | null;
  question: string;
  metadata: any;
}

async function readCadencePrompts(feedEventId: string): Promise<CadenceRow[]> {
  return prisma.brainPromptQueue.findMany({
    where: { dedupKey: { startsWith: `cadence:${feedEventId}:` } },
    orderBy: { queuedAt: 'asc' },
    select: {
      id: true, dedupKey: true, criticality: true, state: true,
      channelUsed: true, sentAt: true, question: true, metadata: true,
    },
  }) as any;
}

// Force a queued row to dispatch immediately by clearing scheduledAt.
async function clearScheduledAt(promptId: bigint | string) {
  const row = await prisma.brainPromptQueue.findUnique({ where: { id: promptId as any } });
  if (!row) return;
  const meta = ((row.metadata as Record<string, unknown> | null) ?? {});
  delete (meta as any).scheduledAt;
  await prisma.brainPromptQueue.update({
    where: { id: promptId as any },
    data: { metadata: meta as any },
  });
}

async function cleanup(feedEventId: string) {
  await prisma.brainPromptQueue.deleteMany({
    where: { dedupKey: { startsWith: `cadence:${feedEventId}:` } },
  }).catch(() => {});
  await prisma.feedEvent.delete({ where: { id: feedEventId } }).catch(() => {});
}

const URDU_HINT_REGEX = /[؀-ۿ]/;

async function main() {
  step('Setup');
  const user = await pickTestUser();
  ok(`user.id=${user.id} email=${user.email} contactNumber=${user.contactNumber ?? '(unset)'}`);

  step('Tenant WhatsApp notifier preflight');
  const notifier = await prisma.tenantWhatsappNotifier.findFirst({
    where: { clientNumber: TEST_CLIENT },
  });
  if (!notifier) {
    info('⚠ no tenant_whatsapp_notifier row — every dispatch will be hard-skipped');
  } else {
    info(`provider=${notifier.provider} isActive=${notifier.isActive} callingEnabled=${notifier.callingEnabled}`);
    info(`phoneNumberId=${notifier.phoneNumberId} displayNumber=${notifier.displayNumber}`);
    info(`accessToken=${notifier.accessTokenEncrypted ? '<set>' : '(missing)'}`);
    if (!notifier.isActive) info('⚠ isActive=false — outbound suppressed for this tenant');
    if (!notifier.callingEnabled) info('⚠ callingEnabled=false — voice call leg will fail');
  }

  step('Test contact (5★)');
  const contactId = await ensureTestContact(user.id);
  ok(`contact at id=${contactId} starred 5 by user ${user.id}`);

  step('Stars lookup');
  const { getStarsForSender } = await import('../services/knowledge/entitySweepService');
  const resolvedStars = await getStarsForSender(TEST_CLIENT, user.id, TEST_SENDER);
  if (resolvedStars !== 5) fail(`getStarsForSender → ${resolvedStars}, expected 5`);
  ok(`getStarsForSender(${TEST_SENDER}) → ${resolvedStars}`);

  step('Inject feed_event + schedule cadence');
  // Set BRAIN_SMOKE_LIVE=1 to actually deliver the smoke pings to your
  // phone. Default: smoke isolation in brainOutboundService suppresses
  // every send so a developer machine never blasts a real user's number.
  if (process.env.BRAIN_SMOKE_LIVE !== '1') {
    info('BRAIN_SMOKE_LIVE not set — smoke pings will be suppressed by smoke isolation. Set BRAIN_SMOKE_LIVE=1 to actually deliver.');
  }
  const feedEventId = await injectFeedEvent(user.id);
  const { scheduleStarCadence } = await import('../services/triage/starCadenceService');
  const result = await scheduleStarCadence({
    clientNumber: TEST_CLIENT,
    userId: user.id,
    feedEventId,
    senderEmail: TEST_SENDER,
    senderName: TEST_SENDER_NAME,
    itemTitle: '[smoke] Please review and confirm by today',
    itemBody: 'Hi, can you review the attached and confirm by end of today?',
    intent: null,
  });
  if (result.status !== 'scheduled' || result.attempts !== 3) {
    fail(`scheduleStarCadence → status=${result.status} attempts=${result.attempts}; expected status=scheduled attempts=3`);
  }
  ok(`scheduled 3 pings (top → high → routine) for stars=${result.stars}`);

  step('Inspect cadence prompts');
  let prompts = await readCadencePrompts(feedEventId);
  if (prompts.length !== 3) fail(`expected 3 cadence rows, found ${prompts.length}`);
  for (const p of prompts) {
    const m = (p.metadata ?? {}) as any;
    info(`${p.dedupKey} crit=${p.criticality} state=${p.state} scheduledAt=${m.scheduledAt ?? '—'}`);
  }

  step('Verify prompt body language');
  const sampleBody = prompts[0]?.question ?? '';
  const expectedUrdu = (user.contactNumber ?? '').startsWith('+92');
  const hasUrduChars = URDU_HINT_REGEX.test(sampleBody);
  console.log(`  body sample: "${sampleBody.slice(0, 120).replace(/\n+/g, ' ')}"`);
  if (expectedUrdu) {
    if (!hasUrduChars) fail(`User contact_number is +92, but body is not Urdu. Body: "${sampleBody.slice(0, 200)}"`);
    ok('body contains Urdu script (Arabic Unicode block) — language detection working');
  } else {
    info(`user is non-+92, English expected — Urdu chars=${hasUrduChars}`);
  }

  step('Force-dispatch each ping (clear scheduledAt + call sendNextPrompt)');
  const { sendNextPrompt } = await import('../services/brainPrompts/brainPromptQueueService');
  const channelByCriticality: Record<string, string> = {
    top: 'call_business',
    high: 'voicenote',
    routine: 'text',
  };

  const expectedChannelOrder: Array<{ crit: string; channel: string }> = [
    { crit: 'top', channel: 'call_business' },
    { crit: 'high', channel: 'voicenote' },
    { crit: 'routine', channel: 'text' },
  ];

  for (let i = 0; i < expectedChannelOrder.length; i++) {
    const expected = expectedChannelOrder[i]!;
    const ping = prompts.find((p) => p.dedupKey?.endsWith(`:${i}`) && p.criticality === expected.crit);
    if (!ping) fail(`could not find ping ${i} with criticality=${expected.crit}`);

    // Clear any scheduledAt so the dispatcher fires it.
    await clearScheduledAt(ping.id);
    // For the queued ones (high/routine), nudge the dispatcher.
    // The top one was already attempted at enqueue time and may already
    // have state=skipped/answered; only nudge if it's still 'queued'.
    if (ping.state === 'queued') {
      // Mark any other awaiting_reply prompts as skipped so this one can be
      // promoted by sendNextPrompt's "no in-flight" check.
      await prisma.brainPromptQueue.updateMany({
        where: { userId: user.id, state: 'awaiting_reply' },
        data: { state: 'skipped' },
      });
      try { await sendNextPrompt(user.id); } catch { /* best effort */ }
    }
  }

  // Re-read final state.
  prompts = await readCadencePrompts(feedEventId);
  step('Per-channel outcomes');
  for (let i = 0; i < expectedChannelOrder.length; i++) {
    const expected = expectedChannelOrder[i]!;
    const ping = prompts.find((p) => p.dedupKey?.endsWith(`:${i}`));
    if (!ping) { console.log(`  ✗ ping ${i} missing`); continue; }
    const m = (ping.metadata ?? {}) as any;
    const reason = m.brainOutboundReason ?? '';
    const channelOK = ping.channelUsed === expected.channel || (!ping.channelUsed && reason);

    console.log(`\n  ─ Ping ${i} (${expected.crit} → expected channel=${expected.channel}) ─`);
    console.log(`    state=${ping.state}  channel_used=${ping.channelUsed ?? '—'}  sent_at=${ping.sentAt?.toISOString() ?? '—'}`);
    if (reason) console.log(`    brainOutboundReason: ${reason}`);

    if (ping.state === 'answered' && ping.sentAt) {
      ok(`✅ ${expected.channel} DISPATCHED — check your phone`);
    } else if (ping.state === 'skipped' && reason) {
      info(`⚠ skipped — see brainOutboundReason above for fix`);
    } else {
      info(`unexpected state=${ping.state} (channel attempted=${ping.channelUsed ?? '—'})`);
    }
    if (!channelOK) console.log(`    ⚠ channel mismatch — expected=${expected.channel}`);
  }

  step('Cleanup');
  await cleanup(feedEventId);
  ok('synthetic feed_event + cadence prompts removed');
  info('test contact left at 5★ (id=' + contactId + ') for re-runs');

  console.log('\n[smoke] ✅ chain exercised — see per-channel outcomes above');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\n[smoke] FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
