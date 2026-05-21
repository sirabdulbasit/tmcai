/**
 * brainActionArtifactService — canonical lifecycle record for every
 * action Brain has attempted.
 *
 * Quality Sprint 5b (2026-05-21). Replaces the spread-across-three-
 * tables debugging pain (state lives in PendingAction +
 * ActionIdempotencyLog + WA session history role='artifact').
 *
 * One row per action ATTEMPT (not per dispatch — failed previews
 * count). Status transitions are recorded; the row's final state
 * tells you what happened.
 *
 * Usage:
 *   - record('previewed', ...) when gate fires
 *   - update(id, 'confirmed') on user confirmation
 *   - update(id, 'dispatching') just before dispatch
 *   - update(id, 'succeeded' | 'failed') with result/error after
 *   - listRecent(userId, channel, hours?) — for "what did Brain do?"
 *
 * This table is for DEBUGGING + USER-VISIBLE AUDIT (Settings →
 * Brain → Recent Activity). Brain itself reads dispatched artifacts
 * via the existing artifacts block (session history role='artifact')
 * for cancel/reschedule resolution — that path is unchanged.
 */
import prisma from '../../db/prisma';

export type ArtifactStatus =
  | 'previewed'
  | 'confirmed'
  | 'dispatching'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface ActionArtifact {
  id: string;
  clientNumber: string;
  userId: number;
  channel: 'web' | 'whatsapp';
  pendingActionId: string | null;
  previewHash: string | null;
  idempotencyKey: string | null;
  actionType: string;
  status: ArtifactStatus;
  payload: unknown;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  artifactExtId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Record a new artifact at any starting status. Returns the row id. */
export async function recordArtifact(args: {
  clientNumber: string;
  userId: number;
  channel: 'web' | 'whatsapp';
  actionType: string;
  status: ArtifactStatus;
  payload: unknown;
  pendingActionId?: string | null;
  previewHash?: string | null;
  idempotencyKey?: string | null;
  result?: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
  artifactExtId?: string | null;
}): Promise<string> {
  const row = await (prisma as any).brainActionArtifact.create({
    data: {
      clientNumber: args.clientNumber,
      userId: args.userId,
      channel: args.channel,
      actionType: args.actionType,
      status: args.status,
      payload: args.payload as any,
      pendingActionId: args.pendingActionId ?? null,
      previewHash: args.previewHash ?? null,
      idempotencyKey: args.idempotencyKey ?? null,
      result: (args.result ?? null) as any,
      errorCode: args.errorCode ?? null,
      errorMessage: args.errorMessage ?? null,
      artifactExtId: args.artifactExtId ?? null,
    },
  });
  return row.id;
}

/** Transition an existing artifact to a new status, optionally
 *  recording result/error/external id. Safe no-op when artifactId
 *  is missing (e.g., creation failed earlier). */
export async function updateArtifactStatus(
  artifactId: string | null | undefined,
  status: ArtifactStatus,
  extras: {
    result?: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
    artifactExtId?: string | null;
  } = {},
): Promise<void> {
  if (!artifactId) return;
  await (prisma as any).brainActionArtifact.update({
    where: { id: artifactId },
    data: {
      status,
      ...(extras.result !== undefined ? { result: extras.result as any } : {}),
      ...(extras.errorCode !== undefined ? { errorCode: extras.errorCode } : {}),
      ...(extras.errorMessage !== undefined ? { errorMessage: extras.errorMessage } : {}),
      ...(extras.artifactExtId !== undefined ? { artifactExtId: extras.artifactExtId } : {}),
    },
  }).catch((e: any) => {
    console.warn('[action-artifact] updateStatus failed', { artifactId, error: e?.message });
  });
}

/** List a user's recent action artifacts. Used by Settings UI for
 *  "what has Brain been doing?" view and for debugging. */
export async function listRecentArtifacts(args: {
  userId: number;
  channel?: 'web' | 'whatsapp';
  hours?: number;
  limit?: number;
}): Promise<ActionArtifact[]> {
  const cutoff = new Date(Date.now() - (args.hours ?? 24) * 60 * 60 * 1000);
  const rows = await (prisma as any).brainActionArtifact.findMany({
    where: {
      userId: args.userId,
      ...(args.channel ? { channel: args.channel } : {}),
      createdAt: { gt: cutoff },
    },
    orderBy: { createdAt: 'desc' },
    take: args.limit ?? 50,
  });
  return rows.map(rowToArtifact);
}

function rowToArtifact(row: any): ActionArtifact {
  return {
    id: row.id,
    clientNumber: row.clientNumber,
    userId: row.userId,
    channel: row.channel,
    pendingActionId: row.pendingActionId ?? null,
    previewHash: row.previewHash ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
    actionType: row.actionType,
    status: row.status as ArtifactStatus,
    payload: row.payload,
    result: row.result ?? null,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    artifactExtId: row.artifactExtId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
