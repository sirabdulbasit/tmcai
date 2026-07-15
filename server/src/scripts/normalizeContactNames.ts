/**
 * normalizeContactNames.ts — one-shot backfill that re-renders the
 * `title` of every entity_person row through normalizeContactName().
 *
 * Why: contacts ingested before the helper landed stored the raw
 * RFC2822 lockup as the name (`saroosh saeed <saroosh.saeed@…>`).
 * This re-parses each row and writes back the cleaned form
 * (`Saroosh Saeed`).
 *
 * Skips rows where the user explicitly renamed (metadata.userRenamed=true).
 *
 * Usage:
 *   Dry run (default):  npx ts-node src/scripts/normalizeContactNames.ts [TMC-0001]
 *   Apply:              APPLY=1 npx ts-node src/scripts/normalizeContactNames.ts [TMC-0001]
 *
 * Tenant arg is optional; if omitted, every tenant's contacts are scanned.
 */
import 'dotenv/config';
import prisma from '../db/prisma';
import { normalizeContactName } from '../services/knowledge/entitySweepService';

const APPLY = process.env.APPLY === '1';
const TENANT = process.argv[2] ?? null;

interface Row {
  id: string;
  client_number: string;
  title: string;
  metadata: Record<string, unknown> | null;
}

async function main() {
  const where = TENANT ? `WHERE page_type = 'entity_person' AND client_number = $1` : `WHERE page_type = 'entity_person'`;
  const params = TENANT ? [TENANT] : [];

  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT id, client_number, title, metadata
       FROM wiki_pages
       ${where}
       ORDER BY client_number, id`,
    ...params,
  );

  console.log(`[normalize] scanned ${rows.length} contact rows ${TENANT ? `in ${TENANT}` : '(all tenants)'}`);
  console.log(`[normalize] mode: ${APPLY ? 'APPLY' : 'DRY RUN (set APPLY=1 to write)'}\n`);

  let changed = 0;
  let skippedRenamed = 0;
  let unchanged = 0;
  let collisions = 0;
  const samples: Array<{ id: string; before: string; after: string }> = [];
  const collisionSamples: Array<{ id: string; title: string; tried: string }> = [];

  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    if (meta.userRenamed === true) { skippedRenamed++; continue; }

    const email = (meta.email as string | null) ?? null;
    const next = normalizeContactName(r.title, email);
    if (!next || next === r.title) { unchanged++; continue; }

    if (samples.length < 20) samples.push({ id: r.id, before: r.title, after: next });

    if (APPLY) {
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE wiki_pages
              SET title = $1,
                  last_updated_by = 'normalize_contact_names',
                  last_updated_at = NOW()
            WHERE id = $2`,
          next.slice(0, 280),
          r.id,
        );
        changed++;
      } catch (e: any) {
        if (e?.meta?.code === '23505' || /unique/i.test(String(e?.message ?? ''))) {
          // Another row already owns this normalised title within
          // (tenant, user, page_type). Stamp for follow-up dedup.
          await prisma.$executeRawUnsafe(
            `UPDATE wiki_pages
                SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
              WHERE id = $2`,
            JSON.stringify({ normalizationCollision: true, normalizationCollisionTarget: next }),
            r.id,
          ).catch(() => {});
          collisions++;
          if (collisionSamples.length < 10) collisionSamples.push({ id: r.id, title: r.title, tried: next });
        } else {
          throw e;
        }
      }
    } else {
      changed++;
    }
  }

  console.log(`[normalize] would change ${changed}, unchanged ${unchanged}, user-renamed (skipped) ${skippedRenamed}, collisions ${collisions}\n`);
  if (collisionSamples.length) {
    console.log('Collisions (needed dedup, title kept as-is):');
    for (const c of collisionSamples) console.log(`  ${c.title}  (would be → ${c.tried})`);
    console.log('');
  }
  if (samples.length) {
    console.log('Sample changes:');
    for (const s of samples) console.log(`  ${s.before}\n    → ${s.after}`);
  }
  if (!APPLY && changed > 0) {
    console.log(`\nRe-run with APPLY=1 to write these ${changed} updates.`);
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[normalize] FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
