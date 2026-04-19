import prisma from '../db/prisma';
import { transitionStatus } from '../services/itemLifecycle/lifecycleService';

/**
 * HaseebOS v15 L2 — snooze timer.
 *
 * Every 60s, finds OpenItems in SNOOZED whose `dueDate` (we re-use dueDate as
 * snoozeUntil via the snooze handler) has elapsed, and transitions them back
 * to TRIAGED via lifecycleService so guards + history + publish all fire.
 *
 * The matrix already allows SNOOZED → TRIAGED with no guard, so this can run
 * unattended.
 */

export interface UnblockResult {
  scanned: number;
  unblocked: number;
  errors: number;
}

export async function wakeSnoozed(): Promise<UnblockResult> {
  const now = new Date();
  const due = await prisma.openItem.findMany({
    where: { status: 'SNOOZED', dueDate: { lte: now } } as any,
    select: { id: true, clientNumber: true, dueDate: true },
    take: 100,
  });
  let unblocked = 0;
  let errors = 0;
  for (const item of due) {
    try {
      const r = await transitionStatus(item.id, 'TRIAGED' as any, {
        clientNumber: item.clientNumber,
        actor: 'system',
        reason: 'snooze timer fired',
      });
      if (r.ok) unblocked += 1;
      else errors += 1;
    } catch (err: any) {
      errors += 1;
      console.warn(`[snoozeUnblocker] ${item.id} failed: ${err.message}`);
    }
  }
  return { scanned: due.length, unblocked, errors };
}
