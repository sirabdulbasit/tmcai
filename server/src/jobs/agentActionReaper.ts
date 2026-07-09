import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('agent-action-reaper');

/**
 * B1 (2026-07-08) — dispatched-action reaper.
 *
 * When an action is published to the ADK agent worker its AgentAction row
 * is 'dispatched'. Only the executor's confirmation callback may advance it
 * to 'done'/'error'. If confirmation never arrives (worker crash, dropped
 * message, dead subscription), the row must NOT linger looking in-flight
 * forever — and it must NEVER become 'done' without confirmation. This
 * reaper moves overdue 'dispatched' rows to 'stale' so the UI and follow-up
 * logic can surface "outcome unknown — verify manually".
 */

export const DISPATCH_CONFIRM_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

export interface ReapResult {
  reaped: number;
}

export async function reapStaleAgentActions(now: Date = new Date()): Promise<ReapResult> {
  const cutoff = new Date(now.getTime() - DISPATCH_CONFIRM_TIMEOUT_MS);
  const r = await prisma.agentAction.updateMany({
    where: {
      status: 'dispatched',
      updatedAt: { lt: cutoff },
    },
    data: {
      status: 'stale',
      error: 'no confirmation from agent worker within timeout — outcome unknown, verify manually',
    },
  });
  return { reaped: r.count };
}

/**
 * B4 (2026-07-09) — provider-confirmed-but-DB-write-fails reconciliation.
 *
 * The confirmed outcome is durable in action_idempotency_log BEFORE the
 * AgentAction status write (withIdempotency stores it inside the executor
 * closure). If the process dies between provider ack and the row update,
 * the row is stuck 'executing' while the log holds the truth. This pass
 * resolves stuck rows FROM the log via the _idempotencyKey the executor
 * embeds in the row's input JSON:
 *   log says ok    → 'done' with the logged output (no re-send — the send
 *                    already happened and was confirmed)
 *   log says fail  → 'error'
 *   no log entry / no key → 'stale' (outcome unknown; NEVER 'done')
 */
export interface ReconcileResult {
  scanned: number;
  recovered: number;
  failed: number;
  staled: number;
}

export async function reconcileStuckExecuting(now: Date = new Date()): Promise<ReconcileResult> {
  const result: ReconcileResult = { scanned: 0, recovered: 0, failed: 0, staled: 0 };
  const cutoff = new Date(now.getTime() - DISPATCH_CONFIRM_TIMEOUT_MS);
  const stuck = await prisma.agentAction.findMany({
    where: { status: 'executing', updatedAt: { lt: cutoff } },
    select: { id: true, input: true },
    take: 100,
  }).catch(() => [] as Array<{ id: number; input: unknown }>);

  for (const row of stuck) {
    result.scanned += 1;
    try {
      const key = (row.input as Record<string, unknown> | null)?.['_idempotencyKey'];
      const log = typeof key === 'string' && key
        ? await prisma.actionIdempotencyLog.findUnique({ where: { idempotencyKey: key } }).catch(() => null)
        : null;
      const logged = (log?.result ?? null) as { ok?: boolean; output?: unknown; error?: string } | null;

      if (logged?.ok === true) {
        await prisma.agentAction.update({
          where: { id: row.id },
          data: { status: 'done', output: (logged.output ?? null) as any, undoStatus: 'undoable' },
        });
        result.recovered += 1;
      } else if (logged && logged.ok === false) {
        await prisma.agentAction.update({
          where: { id: row.id },
          data: { status: 'error', error: logged.error ?? 'failed (recovered from idempotency log)' },
        });
        result.failed += 1;
      } else {
        await prisma.agentAction.update({
          where: { id: row.id },
          data: { status: 'stale', error: 'stuck executing with no idempotency-log record — outcome unknown, verify manually' },
        });
        result.staled += 1;
      }
    } catch (err: any) {
      log.warn('reconcile failed for action', { id: row.id, err: err?.message });
    }
  }

  if (result.scanned > 0) log.info('executing-reconcile pass', result as any);
  return result;
}
