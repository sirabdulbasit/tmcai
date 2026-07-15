/**
 * actionStatusService — user-facing action status surface (#14,
 * 2026-07-14). Unconfirmed/stale actions were previously visible only
 * in the admin health endpoint; the user whose email "sent for
 * execution" never got confirmed had no way to see that.
 *
 * Wording contract (never renders unconfirmed as done):
 *   dispatched   → "sent for execution"
 *   executing    → "executing"
 *   done         → "confirmed complete"
 *   unconfirmed  → "done-but-unconfirmed: executed, confirmation unavailable"
 *   stale        → "outcome unknown — being reconciled"
 *   error        → "failed"
 *
 * Retry is DISABLED across the board in v1: enabling it requires
 * proving idempotency evidence per action (provider id present +
 * reconciler verdict), and a wrong "retry" on a send is a double-send.
 * The reconciler (agentActionReaper) updates these rows as provider
 * evidence arrives, so the surface self-updates.
 *
 * No stack traces, no provider tokens, no message bodies — only the
 * action type, honest status, and timestamps.
 */
import prisma from '../../db/prisma';

export interface UserActionStatus {
  id: number;
  actionType: string;
  status: string;
  statusLabel: string;
  claimsCompletion: false | true;
  retryEnabled: false;
  createdAt: Date;
  updatedAt: Date | null;
}

export const STATUS_LABELS: Record<string, string> = {
  dispatched: 'sent for execution',
  executing: 'executing',
  done: 'confirmed complete',
  unconfirmed: 'executed — confirmation unavailable (will keep checking)',
  stale: 'outcome unknown — being reconciled',
  error: 'failed',
};

export function labelFor(status: string): string {
  return STATUS_LABELS[status] ?? 'outcome unknown';
}

/** Only 'done' may ever read as completed to the user. */
export function rendersAsComplete(status: string): boolean {
  return status === 'done';
}

/** The user's own in-flight / unconfirmed / recently-failed actions.
 *  STRICTLY user+tenant scoped — another user's actions can never
 *  appear here. */
export async function listUserActionStatuses(
  clientNumber: string,
  userId: number,
  limit = 25,
): Promise<UserActionStatus[]> {
  const rows = await prisma.agentAction.findMany({
    where: {
      clientNumber, userId,
      status: { in: ['dispatched', 'executing', 'unconfirmed', 'stale', 'error'] },
    } as any,
    select: { id: true, actionType: true, status: true, createdAt: true, updatedAt: true } as any,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  }).catch(() => [] as any[]);

  return (rows as any[]).map((r) => ({
    id: r.id,
    actionType: r.actionType,
    status: r.status,
    statusLabel: labelFor(r.status),
    claimsCompletion: rendersAsComplete(r.status) as false,
    retryEnabled: false as const,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt ?? null,
  }));
}
