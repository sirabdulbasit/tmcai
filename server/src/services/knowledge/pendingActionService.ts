/**
 * pendingActionService — durable working memory for a multi-turn action.
 *
 * Sprint 1 (2026-05-21). Addresses the "Brain forgets what we were
 * doing" failure: previously Brain re-derived task state from chat
 * history each turn, making slot-fill and confirmation flows fragile
 * across short / fragmented user replies. This service holds the
 * in-progress action explicitly per (user, channel) and is consulted
 * by the turn-relation reducer ahead of the main composer call.
 *
 * Invariants:
 *   - At most ONE active pending per (userId, channel). "Active" =
 *     status in {collecting_slots, preview_shown}. Terminal statuses
 *     (completed, failed, cancelled) are kept as audit and ignored
 *     by the reducer's "is there a pending?" check.
 *   - Pending rows auto-expire after 1h of inactivity (expiresAt).
 *     A background reaper isn't required for correctness — readers
 *     filter on expiresAt > NOW().
 *   - slots is action-specific JSON; missingSlots is the canonical
 *     order in which to ask the user for missing fields (the slot
 *     filler picks missingSlots[0] for the next ask).
 *   - previewHash is set when a preview is shown. The reducer matches
 *     a "confirm" turn ONLY against the SAME hash to prevent
 *     accidental execution after context drift.
 */
import prisma from '../../db/prisma';
import crypto from 'crypto';

/** Action kinds tracked as pending. Internal actions (add_open_item,
 *  set_brain_name) are NOT tracked — they're one-shot, no slot-fill
 *  ceremony, no preview. Only multi-slot or human-facing actions
 *  benefit from pending state. */
export type PendingActionKind =
  | 'schedule_meeting'
  | 'reschedule_meeting'
  | 'cancel_meeting'
  | 'send_email'
  | 'notify_via_whatsapp'
  | 'delegate_open_item';

export type PendingActionStatus =
  | 'collecting_slots'    // some slots filled, more needed
  | 'preview_shown'       // all slots filled, waiting for user confirmation
  | 'confirmed'           // user said yes, dispatching now
  | 'completed'           // dispatcher succeeded — terminal
  | 'failed'              // dispatcher failed — terminal
  | 'cancelled';          // user cancelled or expired — terminal

const ACTIVE_STATUSES: PendingActionStatus[] = ['collecting_slots', 'preview_shown', 'confirmed'];
const TERMINAL_STATUSES: PendingActionStatus[] = ['completed', 'failed', 'cancelled'];

/** Default TTL — 4 hours from last update. Users routinely check a
 *  detail and come back to confirm; the old 1h window failed too
 *  many "yes"/"send" turns as "expired". If the user really has
 *  moved on, replacement by a new pending (startPending cancels the
 *  prior one) still handles that path. */
const PENDING_TTL_MS = 4 * 60 * 60 * 1000;

export interface PendingAction {
  id: string;
  clientNumber: string;
  userId: number;
  channel: 'web' | 'whatsapp';
  actionKind: PendingActionKind;
  status: PendingActionStatus;
  slots: Record<string, unknown>;
  missingSlots: string[];
  previewHash: string | null;
  previewedAt: Date | null;
  artifactId: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

/** Get the active pending action for a user on a channel, if any.
 *  Returns null when there's no active row OR when the row has
 *  expired. Terminal rows (completed/failed/cancelled) are ignored. */
export async function getActivePending(
  userId: number,
  channel: 'web' | 'whatsapp',
): Promise<PendingAction | null> {
  const row = await (prisma as any).brainPendingAction.findFirst({
    where: {
      userId,
      channel,
      status: { in: ACTIVE_STATUSES },
      expiresAt: { gt: new Date() },
    },
    orderBy: { updatedAt: 'desc' },
  });
  return row ? rowToPending(row) : null;
}

/** Quality Sprint 1: look for a pending that was active until recently
 *  but has now expired. Used when the user sends a short confirmation
 *  ("yes" / "send") after the 1h window has passed — instead of
 *  silently re-deriving as a new task, Brain should say "that preview
 *  expired" and offer to redo it. Returns null if no such row in the
 *  last 24h. */
export async function getRecentlyExpiredPending(
  userId: number,
  channel: 'web' | 'whatsapp',
): Promise<PendingAction | null> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const row = await (prisma as any).brainPendingAction.findFirst({
    where: {
      userId,
      channel,
      status: 'preview_shown',
      expiresAt: { lte: new Date(), gt: dayAgo },
    },
    orderBy: { updatedAt: 'desc' },
  });
  return row ? rowToPending(row) : null;
}

/** Create or replace the pending action. If an active pending exists
 *  for (user, channel), it's marked cancelled before the new one is
 *  inserted — enforces the one-active-per-channel invariant. */
export async function startPending(args: {
  clientNumber: string;
  userId: number;
  channel: 'web' | 'whatsapp';
  actionKind: PendingActionKind;
  slots: Record<string, unknown>;
  missingSlots: string[];
}): Promise<PendingAction> {
  // Cancel any existing active pending for this user/channel.
  await (prisma as any).brainPendingAction.updateMany({
    where: {
      userId: args.userId,
      channel: args.channel,
      status: { in: ACTIVE_STATUSES },
    },
    data: { status: 'cancelled', updatedAt: new Date() },
  });
  const now = new Date();
  const row = await (prisma as any).brainPendingAction.create({
    data: {
      clientNumber: args.clientNumber,
      userId: args.userId,
      channel: args.channel,
      actionKind: args.actionKind,
      status: args.missingSlots.length > 0 ? 'collecting_slots' : 'preview_shown',
      slots: args.slots as any,
      missingSlots: args.missingSlots,
      previewHash: null,
      previewedAt: null,
      artifactId: null,
      expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
    },
  });
  return rowToPending(row);
}

/** Merge new slot data into an existing pending. Updates missingSlots
 *  by removing fields that are now present. Transitions status to
 *  preview_shown when missingSlots becomes empty. */
export async function updatePendingSlots(
  pendingId: string,
  slotsPatch: Record<string, unknown>,
  newMissingSlots?: string[],
): Promise<PendingAction | null> {
  const existing = await (prisma as any).brainPendingAction.findUnique({
    where: { id: pendingId },
  });
  if (!existing) return null;
  const mergedSlots = { ...(existing.slots as any), ...slotsPatch };
  const remaining = newMissingSlots ?? (existing.missingSlots as string[]).filter((s) => !(s in slotsPatch));
  const now = new Date();
  const updated = await (prisma as any).brainPendingAction.update({
    where: { id: pendingId },
    data: {
      slots: mergedSlots as any,
      missingSlots: remaining,
      status: remaining.length === 0 ? 'preview_shown' : 'collecting_slots',
      updatedAt: now,
      expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
    },
  });
  return rowToPending(updated);
}

/** Stamp a preview hash + timestamp when the preview is shown to the
 *  user. The reducer matches confirmation turns against this hash to
 *  prevent dispatching after the user has edited slots. */
export async function markPreviewShown(pendingId: string, hash: string): Promise<PendingAction | null> {
  const now = new Date();
  const updated = await (prisma as any).brainPendingAction.update({
    where: { id: pendingId },
    data: {
      previewHash: hash,
      previewedAt: now,
      status: 'preview_shown',
      updatedAt: now,
      expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
    },
  });
  return rowToPending(updated);
}

/** Mark pending as completed (dispatcher succeeded). Stores the
 *  resulting artifactId so subsequent cancel/reschedule turns can
 *  resolve back to it. Terminal status — won't be returned by
 *  getActivePending. */
export async function markCompleted(pendingId: string, artifactId: string): Promise<PendingAction | null> {
  const updated = await (prisma as any).brainPendingAction.update({
    where: { id: pendingId },
    data: {
      status: 'completed',
      artifactId,
      updatedAt: new Date(),
    },
  });
  return rowToPending(updated);
}

/** Mark pending as failed (dispatcher errored). Terminal. */
export async function markFailed(pendingId: string, reason?: string): Promise<void> {
  await (prisma as any).brainPendingAction.update({
    where: { id: pendingId },
    data: {
      status: 'failed',
      updatedAt: new Date(),
      slots: { ...(await getSlots(pendingId)), _failureReason: reason ?? 'unknown' } as any,
    },
  });
}

/** Mark pending as cancelled (user said cancel / new task replaces /
 *  reducer decided). Terminal. */
export async function markCancelled(pendingId: string): Promise<void> {
  await (prisma as any).brainPendingAction.update({
    where: { id: pendingId },
    data: { status: 'cancelled', updatedAt: new Date() },
  });
}

/** Hash a proposed action for preview-confirmation matching.
 *  Stable across whitespace / key-order differences so the same
 *  semantic action produces the same hash on the next turn. */
export function hashProposedAction(actionKind: string, slots: Record<string, unknown>): string {
  // Canonical JSON — sorted keys.
  const sorted = Object.keys(slots).sort().reduce((acc, k) => {
    acc[k] = (slots as any)[k];
    return acc;
  }, {} as Record<string, unknown>);
  const text = `${actionKind}|${JSON.stringify(sorted)}`;
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

// ─── Internal helpers ────────────────────────────────────────────

function rowToPending(row: any): PendingAction {
  return {
    id: row.id,
    clientNumber: row.clientNumber,
    userId: row.userId,
    channel: row.channel as 'web' | 'whatsapp',
    actionKind: row.actionKind as PendingActionKind,
    status: row.status as PendingActionStatus,
    slots: (row.slots ?? {}) as Record<string, unknown>,
    missingSlots: (row.missingSlots ?? []) as string[],
    previewHash: row.previewHash ?? null,
    previewedAt: row.previewedAt ?? null,
    artifactId: row.artifactId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

async function getSlots(pendingId: string): Promise<Record<string, unknown>> {
  const row = await (prisma as any).brainPendingAction.findUnique({
    where: { id: pendingId },
    select: { slots: true },
  });
  return (row?.slots ?? {}) as Record<string, unknown>;
}

export { ACTIVE_STATUSES, TERMINAL_STATUSES };
