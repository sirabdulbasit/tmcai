/**
 * backfillDevanagariToUrdu — one-shot repair for voice transcripts
 * stored with Devanagari (Hindi) script before the 2026-05-14 voice
 * script fix.
 *
 * Why this exists: voiceService.transcribeWithGemini didn't forbid
 * Devanagari output until f34a738 (2026-05-13). Voice notes ingested
 * before that have Hindi text in feedEvent.rawPayload.body — e.g.
 * "🎤 Voice note in English (auto-transcribed)\n\nOriginal: सर इधर
 * से हम...". This script rewrites those rows so the Original line
 * is in Urdu script, and updates the language label from "English"
 * to "Urdu".
 *
 * Idempotent: re-running is safe; rows already in Urdu (no
 * Devanagari) are skipped.
 *
 * Run on Ubuntu:
 *   cd /var/www/tmcai/server
 *   node dist/scripts/backfillDevanagariToUrdu.js \
 *        [--client-number=XXXX] [--user-id=N] [--limit=500] [--dry-run]
 *
 * Defaults: scope to the whole tenant of the first active user, limit
 * 500, NOT dry-run. Use --dry-run first to see what would change.
 */
import prisma from '../db/prisma';
import { transliterateDevanagariToUrdu } from '../services/voiceService';

interface Args {
  clientNumber?: string;
  userId?: number;
  limit: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args: Args = { limit: 500, dryRun: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--client-number=')) args.clientNumber = a.split('=', 2)[1];
    else if (a.startsWith('--user-id=')) args.userId = parseInt(a.split('=', 2)[1], 10);
    else if (a.startsWith('--limit=')) args.limit = Math.max(1, parseInt(a.split('=', 2)[1], 10));
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

/** Rewrite a voice-note body so the Original line is in Urdu script
 *  and the language label says "Urdu" (not "English"). */
async function convertBody(body: string): Promise<string | null> {
  if (!body || !/[ऀ-ॿ]/.test(body)) return null;
  // Extract the "Original:" line and convert just that text. Leave
  // surrounding structure (header, English translation line) alone.
  // Format from UserWebjsProvider.ts:
  //   🎤 Voice note in <lang> (auto-transcribed)
  //
  //   Original: <text — possibly Devanagari>
  //
  //   English: <translation>
  const lines = body.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('Original:') && /[ऀ-ॿ]/.test(line)) {
      const hindi = line.slice('Original:'.length).trim();
      const urdu = await transliterateDevanagariToUrdu(hindi);
      if (urdu && !/[ऀ-ॿ]/.test(urdu)) {
        lines[i] = `Original: ${urdu}`;
        changed = true;
      }
    }
  }
  // Header label: "Voice note in English (auto-transcribed)" → "Voice
  // note in Urdu (auto-transcribed)" once the body is in Arabic script.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('🎤 Voice note in English') && changed) {
      lines[i] = lines[i].replace('Voice note in English', 'Voice note in Urdu');
    }
  }
  // Also handle any other Devanagari outside the Original line as a
  // safety net (rare — e.g. the English translation itself ended up
  // in Hindi for some old rows).
  for (let i = 0; i < lines.length; i++) {
    if (/[ऀ-ॿ]/.test(lines[i])) {
      const converted = await transliterateDevanagariToUrdu(lines[i]);
      if (converted && !/[ऀ-ॿ]/.test(converted)) {
        lines[i] = converted;
        changed = true;
      }
    }
  }
  return changed ? lines.join('\n') : null;
}

async function main(): Promise<void> {
  const args = parseArgs();
  let clientNumber = args.clientNumber;
  if (!clientNumber) {
    const user = await prisma.user.findFirst({
      where: args.userId ? { id: args.userId } : { isActive: true } as any,
      orderBy: { id: 'asc' },
      select: { id: true, clientNumber: true, email: true },
    });
    if (!user) {
      console.error('No active user found. Pass --user-id=N or --client-number=XXXX.');
      process.exit(1);
    }
    clientNumber = user.clientNumber;
    console.log(`Defaulting to tenant ${clientNumber} (user ${user.email}).`);
  }

  console.log(`Scanning feed_events for Devanagari in body. limit=${args.limit} dryRun=${args.dryRun}`);

  // Pull recent WA feed_events. We scan in-memory for Devanagari
  // because Prisma's JSONB filter can't do regex over jsonb text in a
  // portable way. With limit 500 this is cheap.
  const rows = await prisma.feedEvent.findMany({
    where: {
      clientNumber,
      sourceType: 'whatsapp',
      ...(args.userId ? { userId: args.userId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: args.limit,
    select: { id: true, rawPayload: true, userId: true, createdAt: true },
  });

  let candidates = 0;
  let converted = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const payload = row.rawPayload as any;
    const body = String(payload?.body ?? '');
    if (!body || !/[ऀ-ॿ]/.test(body)) {
      skipped += 1;
      continue;
    }
    candidates += 1;
    try {
      const converted_body = await convertBody(body);
      if (!converted_body) {
        failed += 1;
        console.warn(`  [${row.id}] conversion produced no change — likely Gemini still emitted Devanagari`);
        continue;
      }
      if (args.dryRun) {
        console.log(`  [DRY] ${row.id} would update — preview:\n${converted_body.slice(0, 300)}\n`);
      } else {
        await prisma.feedEvent.update({
          where: { id: row.id },
          data: { rawPayload: { ...payload, body: converted_body } as any },
        });
      }
      converted += 1;
    } catch (err: any) {
      failed += 1;
      console.warn(`  [${row.id}] error: ${err.message}`);
    }
  }

  console.log(`\nDone. candidates=${candidates} converted=${converted} skipped=${skipped} failed=${failed} ${args.dryRun ? '(DRY RUN — no writes)' : ''}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
