/**
 * HaseebOS v15 — Phase 7 load test: feed ingestion throughput.
 *
 * Simulates 500 events/day × N tenants sustained over a compressed time window
 * (default: 500 events/tenant pushed in ~5 minutes — concurrency capped).
 *
 * Usage:
 *   npx ts-node src/scripts/loadTestFeed.ts --tenants 5 --events-per-tenant 500 [--concurrency 8] [--duration-sec 300]
 *
 * Measures: dedup rate, throughput (events/sec), p50/p95/p99 latency, DB row growth.
 * Non-destructive: all events get `content_hash` prefix `chaos_loadtest_` so they
 * can be purged afterward via `DELETE FROM feed_events WHERE content_hash LIKE 'chaos_loadtest_%'`.
 */

import dotenv from 'dotenv';
dotenv.config();
import { ingest } from '../services/feed/feedIngestionService';
import prisma from '../db/prisma';

interface Args {
  tenants: number;
  eventsPerTenant: number;
  concurrency: number;
  durationSec: number;
  purge: boolean;
}

function parseArgs(): Args {
  const a: Args = { tenants: 5, eventsPerTenant: 500, concurrency: 8, durationSec: 300, purge: false };
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === '--tenants' && process.argv[i + 1]) a.tenants = parseInt(process.argv[++i], 10);
    else if (arg === '--events-per-tenant' && process.argv[i + 1]) a.eventsPerTenant = parseInt(process.argv[++i], 10);
    else if (arg === '--concurrency' && process.argv[i + 1]) a.concurrency = parseInt(process.argv[++i], 10);
    else if (arg === '--duration-sec' && process.argv[i + 1]) a.durationSec = parseInt(process.argv[++i], 10);
    else if (arg === '--purge') a.purge = true;
  }
  return a;
}

interface Stats {
  sent: number;
  newRows: number;
  dupRows: number;
  errors: number;
  latencies: number[];
}

async function main() {
  const args = parseArgs();

  if (args.purge) {
    const result = await prisma.$executeRaw`DELETE FROM feed_events WHERE content_hash LIKE 'chaos_loadtest_%'`;
    console.log(`[loadtest] purged ${result} rows and exiting`);
    await prisma.$disconnect();
    return;
  }

  console.log(
    `[loadtest] tenants=${args.tenants} events-per-tenant=${args.eventsPerTenant} concurrency=${args.concurrency} duration≤${args.durationSec}s`,
  );

  // Ensure tenant rows exist (best-effort; we won't fail if not — just use synthetic client numbers)
  const clientNumbers = await pickTenants(args.tenants);
  console.log(`[loadtest] using tenants: ${clientNumbers.join(', ')}`);

  const total = args.tenants * args.eventsPerTenant;
  const queue: Array<{ tenant: string; idx: number }> = [];
  for (const t of clientNumbers) {
    for (let i = 0; i < args.eventsPerTenant; i += 1) queue.push({ tenant: t, idx: i });
  }
  shuffle(queue);

  const start = Date.now();
  const deadline = start + args.durationSec * 1000;
  const stats: Stats = { sent: 0, newRows: 0, dupRows: 0, errors: 0, latencies: [] };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < args.concurrency; w += 1) {
    workers.push(worker(queue, stats, deadline));
  }
  await Promise.all(workers);

  const elapsedSec = (Date.now() - start) / 1000;
  const throughput = stats.sent / elapsedSec;
  const p50 = percentile(stats.latencies, 0.5);
  const p95 = percentile(stats.latencies, 0.95);
  const p99 = percentile(stats.latencies, 0.99);

  console.log(`\n─── Load test summary ───`);
  console.log(`  elapsed:     ${elapsedSec.toFixed(1)}s`);
  console.log(`  sent:        ${stats.sent} / ${total}`);
  console.log(`  new rows:    ${stats.newRows}`);
  console.log(`  duplicates:  ${stats.dupRows}`);
  console.log(`  errors:      ${stats.errors}`);
  console.log(`  throughput:  ${throughput.toFixed(1)} events/sec`);
  console.log(`  p50 latency: ${p50.toFixed(1)}ms`);
  console.log(`  p95 latency: ${p95.toFixed(1)}ms`);
  console.log(`  p99 latency: ${p99.toFixed(1)}ms`);

  const inDb = await prisma.feedEvent.count({ where: { contentHash: { startsWith: 'chaos_loadtest_' } } });
  console.log(`  feed_events rows with test prefix: ${inDb}`);
  console.log(`\nTo clean up: npx ts-node src/scripts/loadTestFeed.ts --purge`);

  await prisma.$disconnect();
}

async function worker(queue: Array<{ tenant: string; idx: number }>, stats: Stats, deadline: number): Promise<void> {
  while (queue.length > 0 && Date.now() < deadline) {
    const item = queue.pop();
    if (!item) break;
    const t0 = Date.now();
    try {
      // Vary sourceId so 95% are unique and 5% collide (dedup smoke test)
      const collide = Math.random() < 0.05;
      const sourceId = collide ? `chaos_fixed_${item.tenant}_${item.idx % 20}` : `chaos_${item.tenant}_${item.idx}_${Date.now()}`;
      const result = await ingest({
        clientNumber: item.tenant,
        sourceType: 'gmail',
        sourceId,
        payload: { subject: `Load test ${item.idx}`, body: 'synthetic', chaosLoadtest: true },
      });
      stats.sent += 1;
      stats.latencies.push(Date.now() - t0);
      if (result.status === 'new') stats.newRows += 1;
      else if (result.status === 'duplicate') stats.dupRows += 1;
      else stats.errors += 1;
    } catch (err: any) {
      stats.errors += 1;
      console.warn(`[loadtest] ingest error: ${err.message}`);
    }
  }
}

async function pickTenants(n: number): Promise<string[]> {
  const rows = await prisma.tenant.findMany({ where: { isActive: true }, select: { clientNumber: true }, take: n });
  if (rows.length >= n) return rows.map((r) => r.clientNumber);
  // Pad with synthetic client numbers — they won't satisfy tenant FK but feed_events has no FK to tenants
  const extra = Array.from({ length: n - rows.length }, (_, i) => `LT-${i + 1}`);
  return [...rows.map((r) => r.clientNumber), ...extra];
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
