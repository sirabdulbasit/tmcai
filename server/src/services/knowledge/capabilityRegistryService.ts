/**
 * capabilityRegistryService — what each user is allowed to do.
 *
 * Phase 1 of data-driven refactor (2026-05-22). Replaces inline
 * checks like "if user.integrationProvider === 'google' then can
 * send_email" with table-driven enforcement.
 *
 * Capability keys are short identifiers like 'send_email',
 * 'schedule_meeting', 'notify_via_whatsapp'. The generic dispatcher
 * checks status='enabled' before invoking the action handler.
 *
 * Status:
 *   - 'enabled':   user can use it.
 *   - 'disabled':  explicitly turned off.
 *   - 'requested': Brain proposed this capability (e.g., via
 *                  request_capability action), pending user approval
 *                  in Settings.
 *   - 'denied':    user explicitly rejected; don't re-propose for 30 days.
 */
import prisma from '../../db/prisma';

export type CapabilityStatus = 'enabled' | 'disabled' | 'requested' | 'denied';

export interface CapabilityRecord {
  capabilityKey: string;
  status: CapabilityStatus;
  config: unknown;
  grantedAt: Date | null;
  updatedAt: Date;
}

/** Check if the user has an enabled capability. Used by the generic
 *  dispatcher before invoking action handlers. */
export async function hasCapability(
  userId: number,
  capabilityKey: string,
): Promise<boolean> {
  const row = await (prisma as any).capabilityRegistry.findFirst({
    where: { userId, capabilityKey, status: 'enabled' },
    select: { id: true },
  });
  return !!row;
}

/** Get the full record for a (user, capability) pair. */
export async function getCapability(
  userId: number,
  capabilityKey: string,
): Promise<CapabilityRecord | null> {
  const row = await (prisma as any).capabilityRegistry.findFirst({
    where: { userId, capabilityKey },
  });
  return row ? toRecord(row) : null;
}

/** List all capabilities for a user. Used by Settings UI. */
export async function listUserCapabilities(userId: number): Promise<CapabilityRecord[]> {
  const rows = await (prisma as any).capabilityRegistry.findMany({
    where: { userId },
    orderBy: { capabilityKey: 'asc' },
  });
  return rows.map(toRecord);
}

/** Grant or update a capability. Idempotent upsert on
 *  (userId, capabilityKey). */
export async function grantCapability(args: {
  clientNumber: string;
  userId: number;
  capabilityKey: string;
  status: CapabilityStatus;
  config?: unknown;
  grantedBy?: number | null;
}): Promise<CapabilityRecord> {
  const existing = await (prisma as any).capabilityRegistry.findFirst({
    where: { userId: args.userId, capabilityKey: args.capabilityKey },
  });
  if (existing) {
    const row = await (prisma as any).capabilityRegistry.update({
      where: { id: existing.id },
      data: {
        status: args.status,
        ...(args.config !== undefined ? { config: args.config as any } : {}),
        ...(args.status === 'enabled' && !existing.grantedAt
          ? { grantedAt: new Date(), grantedBy: args.grantedBy ?? null }
          : {}),
      },
    });
    return toRecord(row);
  }
  const row = await (prisma as any).capabilityRegistry.create({
    data: {
      clientNumber: args.clientNumber,
      userId: args.userId,
      capabilityKey: args.capabilityKey,
      status: args.status,
      config: (args.config ?? null) as any,
      grantedBy: args.grantedBy ?? null,
      grantedAt: args.status === 'enabled' ? new Date() : null,
    },
  });
  return toRecord(row);
}

/** Brain can call this to record that it tried to use a capability
 *  that doesn't exist yet — turns into a pending request the user
 *  approves in Settings. */
export async function requestCapability(args: {
  clientNumber: string;
  userId: number;
  capabilityKey: string;
  config?: unknown;
}): Promise<CapabilityRecord> {
  // Don't re-propose denied/disabled capabilities.
  const existing = await getCapability(args.userId, args.capabilityKey);
  if (existing && (existing.status === 'denied' || existing.status === 'enabled')) {
    return existing;
  }
  return grantCapability({ ...args, status: 'requested' });
}

function toRecord(row: any): CapabilityRecord {
  return {
    capabilityKey: row.capabilityKey,
    status: row.status as CapabilityStatus,
    config: row.config ?? null,
    grantedAt: row.grantedAt ?? null,
    updatedAt: row.updatedAt,
  };
}
