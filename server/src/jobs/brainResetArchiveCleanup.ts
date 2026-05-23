/**
 * Drops *_wipe_<suffix> archive tables created by the Settings Reset
 * feature after their 7-day retention window. Runs daily.
 *
 * Per Basit 2026-05-23: the wipe is reversible for 7 days; after that
 * the archive auto-cleans so we don't accumulate dead tables.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('brain-reset-archive-cleanup');

const ARCHIVE_TABLE_PREFIXES = [
  'brain_pending_actions_wipe_',
  'clarification_memory_wipe_',
  'reasoning_traces_wipe_',
  'brain_action_artifacts_wipe_',
  'entities_emptycontact_wipe_',
  // 2026-05-23: Full-tier additions per Basit's revised spec
  'open_items_wipe_',
  'wiki_pages_contacts_wipe_',
  'entities_contacts_wipe_',
];

/** Run a single sweep. Looks up brain_resets rows past their archive
 *  expiry and drops the corresponding *_<archive_suffix> tables. */
export async function runBrainResetArchiveCleanup(): Promise<{
  resetsExpired: number;
  tablesDropped: number;
}> {
  const out = { resetsExpired: 0, tablesDropped: 0 };
  try {
    const expired = await (prisma as any).brainReset.findMany({
      where: { archiveExpiresAt: { lt: new Date() }, archiveSuffix: { not: null } },
      select: { id: true, archiveSuffix: true },
    }).catch(() => []);
    for (const row of expired) {
      const suffix: string = row.archiveSuffix;
      if (!suffix || !/^[A-Za-z0-9_]+$/.test(suffix)) {
        log.warn('skipping reset with invalid archiveSuffix', { id: row.id, suffix });
        continue;
      }
      for (const prefix of ARCHIVE_TABLE_PREFIXES) {
        // Tables are named `<prefix><suffix>` where prefix already includes
        // the trailing `_wipe_` separator (e.g. `brain_pending_actions_wipe_`
        // + `rst_2026_05_23_abc123`). Previous version did a bogus replace
        // that produced a name that never matched any real archive table.
        const tbl = `${prefix}${suffix}`;
        try {
          await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${tbl}`);
          out.tablesDropped += 1;
        } catch (e: any) {
          log.warn('drop table failed (non-fatal)', { tbl, error: e?.message });
        }
      }
      // Clear archiveSuffix so we don't try again, but keep the audit row.
      await (prisma as any).brainReset.update({
        where: { id: row.id },
        data: { archiveSuffix: null, archiveExpiresAt: null },
      }).catch(() => undefined);
      out.resetsExpired += 1;
    }
    if (out.resetsExpired > 0) {
      log.info('archive cleanup sweep', out);
    }
  } catch (e: any) {
    log.warn('sweep error', { error: e?.message });
  }
  return out;
}

/** Schedule daily. Pattern matches the other workers in this folder. */
export function scheduleBrainResetArchiveCleanup(): void {
  const INTERVAL_MS = 24 * 60 * 60 * 1000;
  const FIRST_TICK_MS = 60 * 60 * 1000;
  setTimeout(() => {
    runBrainResetArchiveCleanup().catch(() => undefined);
    setInterval(() => runBrainResetArchiveCleanup().catch(() => undefined), INTERVAL_MS);
  }, FIRST_TICK_MS);
  log.info('archive cleanup worker scheduled', { firstTickMs: FIRST_TICK_MS, intervalMs: INTERVAL_MS });
}
