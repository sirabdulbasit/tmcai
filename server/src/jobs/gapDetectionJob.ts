/**
 * Nexeo Self-Learning — Gap Detection Job (Phase 2)
 *
 * Runs nightly per tenant: sweeps the last 14-30 days of brain
 * interaction logs + feedback, mines patterns, persists new gap
 * candidates for admin review.
 *
 * Cadence: every 24h (first run 5 min after boot). Light load —
 * a few aggregation queries per tenant.
 *
 * Per nexeo_self_learning&development.md §8.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { runGapDetection } from '../services/learning/gapDetectionService';

const log = createLogger('gap-detection-job');

export async function runGapDetectionForAllTenants(): Promise<{
  tenantsScanned: number;
  totalNewGaps: number;
  totalExistingGaps: number;
}> {
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true },
    select: { clientNumber: true },
  });
  let totalNewGaps = 0;
  let totalExistingGaps = 0;
  for (const t of tenants) {
    try {
      const r = await runGapDetection(t.clientNumber);
      totalNewGaps += r.newGaps;
      totalExistingGaps += r.existingGaps;
    } catch (err: any) {
      log.warn('gap detection failed for tenant', { tenant: t.clientNumber, error: err.message });
    }
  }
  log.info('gap detection sweep — all tenants done', {
    tenantsScanned: tenants.length, totalNewGaps, totalExistingGaps,
  });
  return { tenantsScanned: tenants.length, totalNewGaps, totalExistingGaps };
}
