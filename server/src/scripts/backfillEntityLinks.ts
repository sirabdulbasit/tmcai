/**
 * One-off: walk every sender_history / sender_topic / attachment_doc
 * page and attach a canonical entityId via personIdentityService.
 *
 * Idempotent — pages that already have a metadata.entityId are skipped.
 * Runs clientNumber by default = TMC-0001; pass arg to change.
 */
import prisma from '../db/prisma';
import { resolvePersonByEmail, resolvePersonByPhone } from '../services/knowledge/personIdentityService';

async function main() {
  const clientNumber = process.argv[2] ?? 'TMC-0001';

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, user_id AS "userId", page_type AS "pageType", title, metadata
       FROM wiki_pages
      WHERE client_number = $1
        AND page_type IN ('sender_history','sender_topic','attachment_doc')
        AND status NOT IN ('superseded','deleted')
        AND (metadata->>'entityId' IS NULL OR metadata->>'entityId' = '')
      ORDER BY last_updated_at DESC`,
    clientNumber,
  );
  console.log(`Found ${rows.length} pages without entityId.`);

  let linked = 0, skipped = 0;
  for (const r of rows) {
    const meta: any = r.metadata ?? {};
    // Best-effort: use meta.email / meta.phone if present, else parse the title.
    let email: string | null = meta.email ?? meta.senderEmail ?? null;
    let phone: string | null = meta.phone ?? meta.senderPhone ?? null;
    const name: string | null = meta.name ?? meta.senderName ?? null;

    if (!email && !phone) {
      // sender_history title is either an email or a phone; attachment_doc
      // carries the sender email in meta.senderEmail (already handled above).
      if (r.pageType !== 'attachment_doc') {
        const t: string = String(r.title ?? '').trim();
        if (/@/.test(t)) email = t;
        else if (/^\+?\d[\d\s-]+$/.test(t)) phone = t;
      }
    }

    let entityId: string | null = null;
    if (email) {
      entityId = await resolvePersonByEmail(email, { clientNumber, name });
    } else if (phone) {
      entityId = await resolvePersonByPhone(phone, { clientNumber, name });
    }

    if (!entityId) { skipped += 1; continue; }

    const nextMeta = { ...meta, entityId };
    await prisma.wikiPage.update({
      where: { id: r.id },
      data: { metadata: nextMeta as any },
    }).catch(() => {});
    linked += 1;
    if (linked % 50 === 0) console.log(`  ${linked} linked · ${skipped} skipped · ${rows.length - linked - skipped} remaining`);
  }

  console.log(`\nDone. Linked ${linked}, skipped ${skipped}.`);
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(0), 1500).unref());
