/**
 * One-off: for each tenant entity with >=2 linked wiki source pages,
 * synthesize the entity_person concept page. For each distinct `project`
 * page, synthesize the topic concept page.
 *
 * Idempotent — the synthesizer upserts by title. Re-running refreshes
 * the summary with whatever new source pages landed since last run.
 */
import prisma from '../db/prisma';
import { synthesizeNow } from '../services/knowledge/conceptSynthesizerService';

const MIN_LINKED_PAGES = 2;

async function main() {
  const clientNumber = process.argv[2] ?? 'TMC-0001';

  // 1) People concept pages — entities with >=MIN_LINKED_PAGES linked sources
  const personsToSynth = await prisma.$queryRawUnsafe<any[]>(
    `SELECT metadata->>'entityId' AS entity_id, COUNT(*)::int AS n
       FROM wiki_pages
      WHERE client_number = $1
        AND metadata->>'entityId' IS NOT NULL
        AND metadata->>'entityId' <> ''
        AND status NOT IN ('superseded','deleted')
      GROUP BY metadata->>'entityId'
      HAVING COUNT(*) >= $2
      ORDER BY COUNT(*) DESC`,
    clientNumber, MIN_LINKED_PAGES,
  );
  console.log(`Synthesizing ${personsToSynth.length} entity_person pages…`);
  let pOk = 0, pErr = 0;
  for (const [i, r] of personsToSynth.entries()) {
    try {
      const id = await synthesizeNow({ clientNumber, kind: 'person', id: r.entity_id });
      if (id) pOk++; else pErr++;
    } catch { pErr++; }
    if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${personsToSynth.length}  ok=${pOk} err=${pErr}`);
  }
  console.log(`Persons: synthesized ${pOk}, errors ${pErr}\n`);

  // 2) Topic concept pages — seed from existing project pages
  const projects = await prisma.wikiPage.findMany({
    where: { clientNumber, pageType: 'project', status: 'active' } as any,
    select: { title: true },
  });
  console.log(`Synthesizing ${projects.length} topic pages (from projects)…`);
  let tOk = 0, tErr = 0;
  for (const [i, p] of projects.entries()) {
    try {
      const id = await synthesizeNow({ clientNumber, kind: 'topic', id: p.title });
      if (id) tOk++; else tErr++;
    } catch { tErr++; }
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${projects.length}  ok=${tOk} err=${tErr}`);
  }
  console.log(`Topics: synthesized ${tOk}, errors ${tErr}`);
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(0), 2000).unref());
