/**
 * purgeNonMessageWaEvents — archive feed_events that aren't real WhatsApp
 * messages. Type whitelist mirrors the one we just added at ingest
 * (UserWebjsProvider + WebjsProvider).
 *
 * What gets purged:
 *   - rawPayload.type in {e2e_notification, ciphertext, call_log, gp2,
 *     broadcast_notification, e2e_notification_unread, group_notification,
 *     notification_template, ...} — anything NOT in REAL_MESSAGE_TYPES.
 *   - rawPayload.body shaped exactly like "<digits>@lid" or "<digits>@c.us"
 *     (chat-id-as-body fallback that happened before the type filter
 *     shipped — catches any old leak that doesn't have a clean type
 *     classifier).
 *
 * Idempotent. Marks status='processed' rather than DELETE so the audit
 * trail survives.
 *
 * Usage:
 *   cd /var/www/tmcai/server
 *   node dist/scripts/purgeNonMessageWaEvents.js [--dry-run]
 *                                                 [--client-number=XXXX]
 */
import prisma from '../db/prisma';

interface Args {
  clientNumber?: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args: Args = { dryRun: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--client-number=')) args.clientNumber = a.split('=', 2)[1];
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

const REAL_MESSAGE_TYPES = new Set([
  'chat', 'ptt', 'audio', 'image', 'video', 'document',
  'sticker', 'location', 'vcard', 'multi_vcard', 'list',
  'list_response', 'buttons_response', 'order', 'payment',
  'product', 'revoked',
]);

const CHAT_ID_BODY_RE = /^\d{6,}@(lid|c\.us|s\.whatsapp\.net)$/;

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`Scanning whatsapp feed_events for non-message events. dryRun=${args.dryRun}`);

  // Pull recent WA rows. Cap big so a one-shot cleanup isn't truncated.
  const rows = await prisma.feedEvent.findMany({
    where: {
      sourceType: 'whatsapp',
      ...(args.clientNumber ? { clientNumber: args.clientNumber } : {}),
    },
    select: { id: true, rawPayload: true, senderName: true, createdAt: true, clientNumber: true },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });

  let candidates = 0;
  let purged = 0;
  const samples: Array<{ id: string; reason: string; sender: string; preview: string }> = [];

  for (const r of rows) {
    const p = r.rawPayload as any;
    const type = String(p?.type ?? 'chat').toLowerCase();
    const body = String(p?.body ?? '');
    let reason: string | null = null;
    if (!REAL_MESSAGE_TYPES.has(type)) reason = `type=${type}`;
    else if (CHAT_ID_BODY_RE.test(body.trim())) reason = `body-is-chatid`;
    if (!reason) continue;
    candidates += 1;
    if (samples.length < 10) {
      samples.push({
        id: r.id,
        reason,
        sender: r.senderName ?? '',
        preview: body.slice(0, 60),
      });
    }
    if (args.dryRun) continue;
    try {
      await prisma.feedEvent.update({
        where: { id: r.id },
        data: { status: 'processed', processedAt: new Date() } as any,
      });
      purged += 1;
    } catch (e: any) {
      console.warn(`  failed to purge ${r.id}: ${e.message}`);
    }
  }

  if (samples.length > 0) {
    console.log('\nSample candidates:');
    for (const s of samples) {
      console.log(`  [${s.reason.padEnd(20)}] sender="${s.sender}" body="${s.preview}"`);
    }
  }

  console.log(`\nDone. candidates=${candidates} purged=${purged} ${args.dryRun ? '(DRY RUN — no writes)' : ''}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
