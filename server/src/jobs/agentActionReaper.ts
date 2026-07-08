import prisma from '../db/prisma';

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
