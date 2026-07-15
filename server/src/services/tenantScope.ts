// ═════════════════════════════════════════════════════════════════════════════
// tenantScope.ts — E3/E5 tenant-isolation defense in depth (2026-07-09).
//
// Several personal-data paths (file upload, GDrive sync, chat retrieval)
// only carry a userId, but their tables now carry a client_number column
// so a wrong/leaked userId can't silently cross tenants. This helper is
// the ONE place that maps userId → clientNumber (users.client_number is
// the ground truth: every user belongs to exactly one tenant), so every
// writer stamps rows the same way and every reader filters the same way.
// ═════════════════════════════════════════════════════════════════════════════

import prisma from '../db/prisma';

/**
 * Resolve the tenant (client_number) that owns a user.
 *
 * Returns null when the user doesn't exist — callers treat null as
 * "no tenant context": writers then leave client_number NULL (the row
 * degrades to the pre-E3 user-only scoping instead of failing the
 * user's upload/sync), and readers skip the tenant filter (legacy
 * behavior) rather than filtering everything out.
 */
export async function resolveClientNumberForUser(userId: number): Promise<string | null> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    'SELECT client_number FROM users WHERE id = $1',
    userId,
  );
  return rows[0]?.client_number ?? null;
}
