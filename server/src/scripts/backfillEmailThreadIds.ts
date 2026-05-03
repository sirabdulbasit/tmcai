/**
 * One-off: for every existing email_message page missing metadata.threadId,
 * look up the Gmail message and populate threadId + message-id + in-reply-to
 * headers so thread continuity works retroactively.
 *
 * Idempotent — pages already carrying a threadId are skipped.
 */
import { google } from 'googleapis';
import prisma from '../db/prisma';
import { getAuthenticatedClient } from '../services/integrationService';

async function main() {
  const userId = Number(process.argv[2] ?? 1);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { clientNumber: true, email: true } });
  if (!user) { console.error('user not found'); process.exit(1); }

  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) { console.error('no gmail auth:', error); process.exit(1); }
  const gmail = google.gmail({ version: 'v1', auth: client });

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, metadata->>'gmailMessageId' AS "gmailMessageId", metadata
       FROM wiki_pages
      WHERE client_number = $1 AND user_id = $2 AND page_type = 'email_message'
        AND (metadata->>'threadId' IS NULL OR metadata->>'threadId' = '')`,
    user.clientNumber, userId,
  );
  console.log(`Backfilling threadId on ${rows.length} email_message pages.`);

  let ok = 0, err = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.gmailMessageId) { err++; continue; }
    try {
      const msg = await gmail.users.messages.get({
        userId: 'me', id: r.gmailMessageId, format: 'metadata',
        metadataHeaders: ['Message-ID', 'In-Reply-To', 'References'],
      });
      const headers = msg.data.payload?.headers ?? [];
      const getH = (n: string) => headers.find((h: any) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? '';
      const nextMeta: any = { ...(r.metadata ?? {}) };
      nextMeta.threadId = msg.data.threadId ?? null;
      nextMeta.messageIdHeader = getH('Message-ID') || nextMeta.messageIdHeader;
      nextMeta.inReplyTo = getH('In-Reply-To') || nextMeta.inReplyTo;
      nextMeta.references = getH('References') || nextMeta.references;
      await prisma.wikiPage.update({
        where: { id: r.id },
        data: { metadata: nextMeta as any },
      }).catch(() => {});
      ok++;
    } catch (e: any) {
      err++;
    }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${rows.length}  ok=${ok} err=${err}`);
    // Gentle rate-limit for Gmail metadata fetches
    await new Promise((r) => setTimeout(r, 40));
  }
  console.log(`\nDone. threadId populated on ${ok} pages, ${err} errors.`);
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(0), 1500).unref());
