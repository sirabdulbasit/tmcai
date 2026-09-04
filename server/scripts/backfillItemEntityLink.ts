/**
 * backfillItemEntityLink — give an open item the person it came from.
 *
 * Owner, 2026-09-04 (CL-055): *"brain is not corelating things correttly"* and
 * *"brain don't know the proper background"*. Measured that day, and this is the whole gap:
 *
 *   open_items.entity_id      populated on   0 of 95 active items
 *   open_items.delegatee_id   populated on   0 of 95
 *   item <-> person edge in entity_links     does not exist (that table is entity->entity)
 *
 * So Brain holds a 974-person / 938-entity graph and a work list, with NO edge between them.
 * Exactly one bridge exists — `open_items.source_feed_event_id -> feed_events.sender_email` —
 * and it was never crossed. DEF-313 crossed it on the ANSWER path (the ledger block now renders
 * the sender). This script crosses it in the DATA, so the link is a fact of the record rather
 * than something recomputed per question, and so the contact's own name, phone and `wa_lid`
 * become reachable from the item.
 *
 * DELIBERATELY NOT A PRUNER. The 79 stale drafts are the self-pruning capability's job
 * (`zombieItemPolicy`), and a second implementation of a protection this codebase already has
 * would be the 11th `protection-with-two-implementations` in a codebase carrying ten. This
 * script only ADDS links. It deletes nothing and it overwrites nothing.
 *
 * Idempotent: only rows where `entity_id IS NULL` are considered, so a second run is a no-op.
 *
 *   npx tsx scripts/backfillItemEntityLink.ts            # DRY RUN — writes nothing
 *   npx tsx scripts/backfillItemEntityLink.ts --apply    # writes
 */
import 'dotenv/config';
import prisma from '../src/db/prisma';

const APPLY = process.argv.includes('--apply');
const CLIENT = process.env.BACKFILL_CLIENT ?? 'TMC-0001';

/**
 * `sender_email` arrives as a raw RFC-5322 From header — `Basit Ahmed <basit.ahmed@tmcltd.com>`,
 * `"Dawar Hussain" <dawar.hussain@tmcltd.com>`, or a bare address. A naive `[^<> ]+@[^<> ]+`
 * carries the opening quote into the address and silently fails to match one contact in the
 * live set, which is the kind of near-miss that reads as "the data is bad" when the parser is.
 */
export function extractAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angled = /<([^<>]+@[^<>]+)>/.exec(raw);
  const candidate = angled ? angled[1] : raw;
  const m = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(candidate);
  return m ? m[0].toLowerCase() : null;
}

async function main(): Promise<void> {
  const items: any[] = await prisma.$queryRawUnsafe(`
    select o.id, o.title, o.status, o.source_feed, f.sender_email, f.sender_name
    from open_items o
    join feed_events f on f.id = o.source_feed_event_id
    where o.client_number = $1 and o.entity_id is null
  `, CLIENT);

  const entities: any[] = await prisma.$queryRawUnsafe(
    `select id, name, email from entities where client_number = $1 and email is not null`, CLIENT);
  const byEmail = new Map<string, any>();
  for (const e of entities) {
    const a = extractAddress(e.email);
    if (a && !byEmail.has(a)) byEmail.set(a, e);
  }

  const matched: Array<{ id: string; title: string; entityId: string; name: string }> = [];
  const noAddress: any[] = [];
  const noEntity = new Map<string, number>();

  for (const it of items) {
    const addr = extractAddress(it.sender_email);
    if (!addr) { noAddress.push(it); continue; }
    const ent = byEmail.get(addr);
    if (!ent) { noEntity.set(addr, (noEntity.get(addr) ?? 0) + 1); continue; }
    matched.push({ id: it.id, title: String(it.title).slice(0, 46), entityId: ent.id, name: ent.name });
  }

  console.log(`\n${APPLY ? 'APPLY' : 'DRY RUN — nothing is written'}   tenant ${CLIENT}`);
  console.log(`unlinked items with a feed event : ${items.length}`);
  console.log(`  would link to an existing contact: ${matched.length}`);
  console.log(`  sender has no email address      : ${noAddress.length}  (gchat stores an opaque users/<id>)`);
  console.log(`  email present but no contact row : ${[...noEntity.values()].reduce((a, b) => a + b, 0)}`);
  if (noEntity.size) {
    console.log('    addresses with no contact:');
    for (const [a, n] of noEntity) console.log(`      ${a}  (${n} item${n === 1 ? '' : 's'})`);
  }
  console.log('\n  sample of what would be linked:');
  for (const m of matched.slice(0, 8)) console.log(`      "${m.title}"  ->  ${m.name}`);

  if (!APPLY) {
    console.log('\nNo rows were written. Re-run with --apply to write.\n');
    return;
  }
  let written = 0;
  for (const m of matched) {
    // Guarded on `entity_id is null` again at write time: a link created between the read and
    // the write is somebody else's decision, and this script never overwrites one.
    written += await prisma.$executeRawUnsafe(
      `update open_items set entity_id = $1, updated_at = now()
       where id = $2 and client_number = $3 and entity_id is null`, m.entityId, m.id, CLIENT);
  }
  console.log(`\nlinked ${written} item(s).\n`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
