/**
 * DEF-354 — Integrations Stage 1: the schedule dispatcher.
 *
 * Spec INTEGRATIONS_DESIGN.md §2.5. Run every 60 s by
 * protectedJob('integration_sync_dispatcher', 'maintenance'). Replaces vm's
 * scheduler loop (port notes, schedule-api §4), closing its defects:
 *
 *  - The slot is CLAIMED atomically before the run starts (UPDATE … WHERE
 *    last_slot_at < $slot RETURNING). Two replicas, or two overlapping ticks,
 *    cannot both claim it; a crash consumes the slot instead of retrying it every
 *    60 s forever (vm "throws before startRun, retried every 60s").
 *  - No slot before activated_at is ever owed (`activated_at <= $slot` in the
 *    claim, and isDue's own check): turning on never back-fills a slot that
 *    already passed (vm activation regression, planner test :546-578).
 *  - Only ACTIVE rows are read, so a PAUSED integration is never dispatched;
 *    the claim re-checks status, so a pause between the read and the claim wins.
 *
 * The read of ACTIVE rows is the ONE cross-tenant read of the feature, and is
 * explicit (runWithoutTenant). Every later statement names the row's own
 * client_number, and the run itself is started inside that tenant's scope.
 */
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { runInTenantScope, runWithoutTenant } from '../../../db/tenantContext';
import { getBehaviorValue } from '../../behaviorConfig';
import { isDue, nextScheduledRun } from '../engine/planner';
import { startRun } from '../engine/runJobs';
import { scheduleOf } from '../store/integrationStore';
import { RunBusyError, SCHEDULER_ACTOR, type DispatcherModule, type DispatchResult } from '../types';

const log = createLogger('integration-dispatcher');

const MAX_CONCURRENT_KEY = 'integrations.max_concurrent_runs';

export const dispatchDueIntegrations: DispatcherModule['dispatchDueIntegrations'] = async (now = new Date()) => {
  const result: DispatchResult = { claimed: 0, started: 0, skipped: 0 };

  const rows = await runWithoutTenant(() => prisma.integrationSync.findMany({
    // The DB CHECK already makes ACTIVE imply both; repeating it here keeps a
    // NULL activated_at from ever reaching isDue (vm's back-fill gap).
    where: { status: 'ACTIVE', approvedVersionId: { not: null }, activatedAt: { not: null } },
    select: {
      id: true, clientNumber: true, frequency: true, runTime: true, dayOfWeek: true, dayOfMonth: true,
      timezone: true, lastSlotAt: true, activatedAt: true,
    },
    orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
  }));
  if (rows.length === 0) return result;

  // Process-wide budget (the box also runs production — a sheet read holds up
  // to 10 MB). Counted from the run rows, so manual runs and runs started by
  // another tick still occupy their slot.
  const maxConcurrent = await getBehaviorValue(MAX_CONCURRENT_KEY);
  let running = await runWithoutTenant(() => prisma.integrationRun.count({ where: { status: 'RUNNING' } }));

  for (const row of rows) {
    try {
      const schedule = scheduleOf(row);
      const slot = isDue(schedule, now, row.lastSlotAt, row.activatedAt, row.timezone);
      if (!slot) continue;

      if (running >= maxConcurrent) {
        // Not claimed: the slot stays owed and the next tick picks it up.
        result.skipped += 1;
        continue;
      }

      const next = nextScheduledRun(schedule, slot, row.timezone);
      // The claim, exactly as spec §2.5. Raw SQL ⇒ client_number explicit.
      const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
        UPDATE integration_syncs
           SET last_slot_at = ${slot}, next_run_at = ${next}, updated_at = now()
         WHERE id = ${row.id} AND client_number = ${row.clientNumber}
           AND status = 'ACTIVE'
           AND activated_at <= ${slot}
           AND (last_slot_at IS NULL OR last_slot_at < ${slot})
        RETURNING id`;
      if (claimed.length === 0) {
        // Another replica/tick claimed it, or it was paused meanwhile.
        result.skipped += 1;
        continue;
      }
      result.claimed += 1;

      try {
        // startRun resolves as soon as the run row (the mutex) exists; the run
        // itself continues in the background — a tick never waits on a sheet.
        const { runId } = await runInTenantScope(
          { clientNumber: row.clientNumber, userId: null, bypass: false },
          () => startRun(row.clientNumber, row.id, { dryRun: false, trigger: 'scheduled', triggeredBy: SCHEDULER_ACTOR }),
        );
        result.started += 1;
        running += 1;
        log.info('scheduled run started', { cn: row.clientNumber, id: row.id, slot: slot.toISOString(), runId });
      } catch (err) {
        // The slot stays consumed on purpose: a manual run in progress
        // (RunBusyError) already reads the sheet, and a failure to start must not
        // become a retry every 60 s.
        result.skipped += 1;
        if (err instanceof RunBusyError) {
          log.info('scheduled slot skipped: a run is already in progress', { cn: row.clientNumber, id: row.id });
        } else {
          log.error('scheduled run failed to start', { cn: row.clientNumber, id: row.id, error: (err as Error)?.message });
        }
      }
    } catch (err) {
      // One bad row (e.g. a zone the runtime no longer knows) never stops the others.
      result.skipped += 1;
      log.error('dispatch failed for integration', { cn: row.clientNumber, id: row.id, error: (err as Error)?.message });
    }
  }

  if (result.claimed || result.skipped) log.info('integration dispatch tick', { ...result });
  return result;
};

/** Module conformance check — a signature drift from types.ts fails tsc here. */
export const dispatcher = { dispatchDueIntegrations } satisfies DispatcherModule;
