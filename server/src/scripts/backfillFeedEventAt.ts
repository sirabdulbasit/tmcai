/**
 * Backfill feed_events.event_at from rawPayload for rows that predate
 * the column. Idempotent: only touches rows where event_at IS NULL.
 *
 * Usage (prod or local):
 *   npx ts-node src/scripts/backfillFeedEventAt.ts          # dry-run
 *   npx ts-node src/scripts/backfillFeedEventAt.ts --apply  # write
 *
 * Strategy:
 *   - Iterate in batches of 500 by primary key, ordered ascending.
 *   - For each row, run the same extractSourceEventTime() the ingest
 *     path uses, so the result is consistent with what new rows get.
 *   - When the helper returns null (source had no parseable date),
 *     leave event_at NULL — display falls back to createdAt cleanly.
 *
 * Performance: a single UPDATE per row is fine for the ~100K-row scale
 * we're at. For larger tables, batch into INSERT...ON CONFLICT or
 * temp-table joins.
 */
import prisma from '../db/prisma';
import { extractSourceEventTime } from '../services/feed/feedEventTime';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`[backfill] starting in ${apply ? 'APPLY' : 'DRY-RUN'} mode`);

  let cursor: string | undefined;
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  const BATCH = 500;

  for (;;) {
    const rows = await (prisma.feedEvent.findMany({
      where: { eventAt: null } as any,
      orderBy: { id: 'asc' } as any,
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor } as any, skip: 1 } : {}),
      select: { id: true, rawPayload: true, createdAt: true } as any,
    }) as unknown as Promise<Array<{ id: string; rawPayload: any; createdAt: Date }>>)
      .catch((err: any) => {
        console.error('[backfill] query failed:', err.message);
        return [] as Array<{ id: string; rawPayload: any; createdAt: Date }>;
      });
    if (rows.length === 0) break;

    for (const r of rows) {
      scanned += 1;
      const eventAt = extractSourceEventTime(r.rawPayload);
      if (!eventAt) { skipped += 1; continue; }
      if (apply) {
        await prisma.feedEvent.update({
          where: { id: r.id },
          data: { eventAt } as any,
        }).catch((err: any) => {
          console.warn(`[backfill] update failed id=${r.id}: ${err.message}`);
        });
      }
      updated += 1;
    }
    cursor = rows[rows.length - 1]!.id;
    console.log(`[backfill] progress scanned=${scanned} updated=${updated} skipped=${skipped}`);
  }

  console.log(`[backfill] done scanned=${scanned} updated=${updated} skipped=${skipped} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
