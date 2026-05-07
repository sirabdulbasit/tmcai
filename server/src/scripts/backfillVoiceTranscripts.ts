/**
 * Backfill voice-note transcripts for WhatsApp feed_events that
 * predate the inline transcription fix (commit 40a0a6c).
 *
 * Logic:
 *   - Find every whatsapp feed_event where type IS ptt|audio AND
 *     the body is empty OR a "[voice note]" placeholder.
 *   - For each, look up the live webjs client for that user. If
 *     the user hasn't re-paired since the message arrived, the
 *     client either won't exist (skip) or won't have the message
 *     in its cache (skip + log).
 *   - Pull the message via client.getMessageById(waMessageId).
 *     Download media. Transcribe via voiceService. Translate to
 *     English when source isn't English.
 *   - Rewrite raw_payload.body with the standard transcribed
 *     block, set raw_payload.voiceTranscript with the structured
 *     metadata. Idempotent — skips rows that already carry a
 *     transcript.
 *
 * Usage:
 *   cd /var/www/tmcai/server
 *   npx ts-node src/scripts/backfillVoiceTranscripts.ts          # dry-run
 *   npx ts-node src/scripts/backfillVoiceTranscripts.ts --apply  # write
 *
 * Pre-req: WhatsApp Personal must be paired AND alive for the
 * affected user. If the connector died and re-paired, webjs's
 * local cache may not contain old messages — those stay empty
 * until WhatsApp re-syncs them or the user opens the chat.
 */
import prisma from '../db/prisma';
import { transcribeVoiceNote } from '../services/voiceService';
import { callLLM } from '../services/llmRouter';

interface FeedRow {
  id: string;
  clientNumber: string;
  userId: number | null;
  rawPayload: any;
  createdAt: Date;
}

const BATCH = 50;

async function getClientFor(userId: number): Promise<any | null> {
  // Tap the in-memory clients Map exported from UserWebjsProvider.
  // We can't import the Map directly without exporting it; instead
  // call sendReply with a cheap no-op? Easier: import the module's
  // private clients via reflection isn't reliable. So we expose a
  // helper getClient if available, else return null.
  try {
    const mod: any = await import('../services/whatsapp/UserWebjsProvider');
    if (typeof mod.__getInternalClient === 'function') {
      return mod.__getInternalClient(userId);
    }
  } catch { /* fall through */ }
  return null;
}

function humanLang(code: string): string {
  const c = (code || '').toLowerCase();
  if (c.startsWith('ur')) return 'Urdu';
  if (c.startsWith('en')) return 'English';
  if (c.startsWith('hi')) return 'Hindi';
  if (c.startsWith('ar')) return 'Arabic';
  return code || 'unknown language';
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`[voice-backfill] starting in ${apply ? 'APPLY' : 'DRY-RUN'} mode`);

  let cursor: string | undefined;
  let scanned = 0;
  let transcribed = 0;
  let skippedNoClient = 0;
  let skippedNotFound = 0;
  let skippedAlready = 0;
  let errors = 0;

  for (;;) {
    const rows: FeedRow[] = await prisma.$queryRawUnsafe<FeedRow[]>(
      `SELECT id, client_number AS "clientNumber", user_id AS "userId",
              raw_payload AS "rawPayload", created_at AS "createdAt"
         FROM feed_events
        WHERE source_type = 'whatsapp'
          AND user_id IS NOT NULL
          AND (raw_payload->>'type' IN ('ptt', 'audio'))
          AND (raw_payload->>'body' = '' OR raw_payload->>'body' IS NULL
               OR raw_payload->>'body' ILIKE '%[voice note]%'
               OR raw_payload->>'body' ILIKE '%(voice note)%')
          AND raw_payload->'voiceTranscript' IS NULL
          ${cursor ? `AND id > '${cursor.replace(/'/g, "''")}'` : ''}
        ORDER BY id ASC
        LIMIT ${BATCH}`,
    ).catch((err: any) => {
      console.error('[voice-backfill] query failed:', err.message);
      return [] as FeedRow[];
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      scanned += 1;
      const userId = row.userId!;
      const payload = row.rawPayload || {};
      const waMessageId = payload.waMessageId;
      if (!waMessageId) { skippedNotFound += 1; continue; }
      if (payload.voiceTranscript) { skippedAlready += 1; continue; }

      const client = await getClientFor(userId);
      if (!client) { skippedNoClient += 1; continue; }

      try {
        const message = await client.getMessageById?.(waMessageId).catch(() => null);
        if (!message) { skippedNotFound += 1; continue; }
        if (!message.hasMedia) { skippedNotFound += 1; continue; }

        const media = await message.downloadMedia();
        if (!media?.data) { skippedNotFound += 1; continue; }

        const buffer = Buffer.from(media.data, 'base64');
        const tx = await transcribeVoiceNote(buffer, media.mimetype);
        if (!tx.text) { skippedNotFound += 1; continue; }

        let english = '';
        if (!(tx.language || '').toLowerCase().startsWith('en')) {
          try {
            const r = await callLLM(
              'Translate the input into clear, natural English. Output ONLY the English translation — no preamble, no labels, no quotes.',
              tx.text,
              {
                maxTokens: 400,
                providers: ['gemini-flash', 'gemini', 'claude'],
                userId,
                clientNumber: row.clientNumber,
                purpose: 'voice_translate',
                timeoutMs: 12_000,
              },
            );
            english = r.text.trim();
          } catch { /* skip translation, keep original */ }
        }

        const voiceTranscript = {
          language: tx.language || 'unknown',
          original: tx.text,
          english,
          confidence: tx.confidence || 0,
        };
        const formattedBody = [
          `🎤 Voice note in ${humanLang(voiceTranscript.language)} (auto-transcribed)`,
          ``,
          `Original: ${voiceTranscript.original}`,
          english ? `\nEnglish: ${english}` : '',
        ].filter(Boolean).join('\n');

        if (apply) {
          const nextPayload = { ...payload, body: formattedBody, voiceTranscript };
          await prisma.feedEvent.update({
            where: { id: row.id },
            data: { rawPayload: nextPayload as any },
          });
        }
        transcribed += 1;
        console.log(`[voice-backfill] ${apply ? 'wrote' : 'would write'} ${row.id} · ${humanLang(voiceTranscript.language)} · "${voiceTranscript.original.slice(0, 60)}"`);
      } catch (err: any) {
        errors += 1;
        console.warn(`[voice-backfill] ${row.id} failed: ${err.message}`);
      }
    }
    console.log(`[voice-backfill] progress scanned=${scanned} transcribed=${transcribed} skipped(no-client)=${skippedNoClient} skipped(not-found)=${skippedNotFound} errors=${errors}`);
  }

  console.log(`[voice-backfill] done scanned=${scanned} transcribed=${transcribed} skipped(no-client)=${skippedNoClient} skipped(not-found)=${skippedNotFound} skipped(already)=${skippedAlready} errors=${errors} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[voice-backfill] fatal:', err);
  process.exit(1);
});
