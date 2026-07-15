/**
 * One-off: embed every wiki page that doesn't yet have an embedding,
 * chronologically. Safe to rerun — `embedWikiPage` is idempotent on a
 * SHA-256 hash of (title+body) so unchanged pages are no-ops.
 *
 * Bounded: processes in batches of 50, sleeps briefly between batches
 * to stay well under Gemini embedding RPM limits.
 */
import prisma from '../db/prisma';
import { embedWikiPage } from '../services/knowledge/wikiEmbeddingService';

const BATCH = 50;
const SLEEP_MS = 300;

async function main() {
  const clientNumber = process.argv[2] ?? null;
  const filter = clientNumber ? `AND client_number = '${clientNumber.replace(/'/g, "''")}'` : '';

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id FROM wiki_pages
      WHERE embedding IS NULL
        AND page_type NOT IN ('tenant_index','tenant_log')
        AND status NOT IN ('superseded','deleted')
        ${filter}
      ORDER BY last_updated_at ASC`,
  );
  console.log(`Found ${rows.length} pages to embed${clientNumber ? ` in tenant ${clientNumber}` : ''}.`);

  let done = 0, err = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    await Promise.all(slice.map(async (r: any) => {
      try { await embedWikiPage(r.id); done += 1; }
      catch { err += 1; }
    }));
    const pct = Math.round(((i + slice.length) / rows.length) * 100);
    console.log(`  ${i + slice.length}/${rows.length} (${pct}%) done=${done} err=${err}`);
    if (i + BATCH < rows.length) await new Promise((r) => setTimeout(r, SLEEP_MS));
  }

  console.log(`\nFinished. Embedded ${done}, errors ${err}.`);
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(0), 1500).unref());
