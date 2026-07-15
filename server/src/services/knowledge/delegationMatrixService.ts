/**
 * Delegation matrix — per-tenant "who owns what business area".
 *
 * Loaded into every Brain composer call (and into the criticality engine's
 * relationship-risk dimension) so routing decisions are deterministic
 * lookups, not LLM inference. Editable only by tenant ADMIN/SA.
 *
 * Compositional with `BrainConfig.delegationRules`:
 *   - Matrix: knowledge map ("Finance is owned by Aisha; escalate to Asad")
 *   - delegationRules: imperative actions ("delegate emails of type=hr to Y")
 *
 * Cache: 60s TTL on the rendered block keyed by clientNumber. Updates
 * bust the cache through `invalidateMatrixCache`.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { getOrCompute, invalidate as redisInvalidate } from '../../utils/redisClient';

const log = createLogger('delegation-matrix');

export interface DelegationEntry {
  id: number;
  clientNumber: string;
  area: string;
  ownerUserId: number | null;
  ownerName: string;
  ownerEmail: string | null;
  ownerRole: string | null;
  escalateToName: string | null;
  escalateToEmail: string | null;
  notes: string | null;
  effectiveFrom: string | null;
  isActive: boolean;
}

export interface UpsertEntryInput {
  area: string;
  ownerUserId?: number | null;
  ownerName: string;
  ownerEmail?: string | null;
  ownerRole?: string | null;
  escalateToName?: string | null;
  escalateToEmail?: string | null;
  notes?: string | null;
  effectiveFrom?: string | null;
  isActive?: boolean;
}

const CACHE_KEY = (clientNumber: string) => `deleg-matrix:${clientNumber}`;
const CACHE_TTL_SECONDS = 60;

/** Read all active matrix entries for a tenant, sorted by area. */
export async function listActiveEntries(clientNumber: string): Promise<DelegationEntry[]> {
  return prisma.delegationMatrix.findMany({
    where: { clientNumber, isActive: true },
    orderBy: { area: 'asc' },
  }) as unknown as DelegationEntry[];
}

/** Read every entry — admin UI uses this so it can show inactive ones too. */
export async function listAllEntries(clientNumber: string): Promise<DelegationEntry[]> {
  return prisma.delegationMatrix.findMany({
    where: { clientNumber },
    orderBy: [{ isActive: 'desc' }, { area: 'asc' }],
  }) as unknown as DelegationEntry[];
}

/**
 * Insert or update a matrix entry. Tenant + area is the unique key —
 * existing entry for that area is overwritten in place. The previous
 * snapshot is appended to delegation_matrix_history so the audit trail
 * is preserved.
 */
export async function upsertEntry(
  clientNumber: string,
  actorUserId: number,
  input: UpsertEntryInput,
): Promise<DelegationEntry> {
  const area = input.area.trim();
  if (!area) throw new Error('area is required');
  if (!input.ownerName || !input.ownerName.trim()) throw new Error('ownerName is required');

  const existing = await prisma.delegationMatrix.findUnique({
    where: { clientNumber_area: { clientNumber, area } } as any,
  });

  // Audit row: snapshot of pre-change state (or "insert" if creating new).
  const operation = existing ? 'update' : 'insert';
  const snapshot = existing ?? { area, status: 'absent' };

  const data = {
    clientNumber,
    area,
    ownerUserId: input.ownerUserId ?? null,
    ownerName: input.ownerName.trim(),
    ownerEmail: input.ownerEmail ?? null,
    ownerRole: input.ownerRole ?? null,
    escalateToName: input.escalateToName ?? null,
    escalateToEmail: input.escalateToEmail ?? null,
    notes: input.notes ?? null,
    effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : null,
    isActive: input.isActive ?? true,
    updatedByUserId: actorUserId,
  };

  const row = await prisma.delegationMatrix.upsert({
    where: { clientNumber_area: { clientNumber, area } } as any,
    create: { ...data, createdByUserId: actorUserId },
    update: data,
  });

  await prisma.delegationMatrixHistory.create({
    data: {
      clientNumber,
      area,
      operation,
      snapshot: JSON.parse(JSON.stringify(snapshot)),
      changedByUserId: actorUserId,
    },
  });

  await invalidateMatrixCache(clientNumber);
  log.info('delegation matrix upsert', { clientNumber, area, op: operation, actor: actorUserId });
  return row as unknown as DelegationEntry;
}

/** Soft-delete: mark inactive. Hard delete is intentionally not exposed —
 *  preserves the audit trail and avoids breaking foreign-key references. */
export async function deactivateEntry(
  clientNumber: string,
  area: string,
  actorUserId: number,
): Promise<boolean> {
  const existing = await prisma.delegationMatrix.findUnique({
    where: { clientNumber_area: { clientNumber, area } } as any,
  });
  if (!existing) return false;

  await prisma.delegationMatrix.update({
    where: { clientNumber_area: { clientNumber, area } } as any,
    data: { isActive: false, updatedByUserId: actorUserId },
  });
  await prisma.delegationMatrixHistory.create({
    data: {
      clientNumber, area, operation: 'deactivate',
      snapshot: JSON.parse(JSON.stringify(existing)),
      changedByUserId: actorUserId,
    },
  });
  await invalidateMatrixCache(clientNumber);
  return true;
}

/**
 * Render the matrix as a markdown block for injection into Brain prompts.
 * Compact format — one line per area — to keep token usage low.
 * Returns '' when the tenant has no active matrix (Brain falls back to
 * inference). Cached for 60s.
 */
export async function renderMatrixBlock(clientNumber: string): Promise<string> {
  return getOrCompute(CACHE_KEY(clientNumber), CACHE_TTL_SECONDS, async () => {
    const rows = await listActiveEntries(clientNumber);
    if (rows.length === 0) return '';
    const lines: string[] = [];
    lines.push('## Delegation matrix (who owns what — load-bearing for routing decisions)');
    lines.push('Use this map to decide *who* to delegate to or escalate to. Each line: area → owner (role) [escalate-to]. When the user asks "who handles X" or you need to route an item, look up the area here before inferring.');
    lines.push('');
    for (const r of rows) {
      const owner = r.ownerEmail
        ? `${r.ownerName} <${r.ownerEmail}>`
        : r.ownerName;
      const role = r.ownerRole ? ` (${r.ownerRole})` : '';
      const escalate = r.escalateToName
        ? ` — escalate to ${r.escalateToName}${r.escalateToEmail ? ` <${r.escalateToEmail}>` : ''}`
        : '';
      const note = r.notes ? `  · _${r.notes}_` : '';
      lines.push(`- **${r.area}** → ${owner}${role}${escalate}${note}`);
    }
    return lines.join('\n');
  });
}

/** Look up the owner for a single area (case-insensitive exact match). */
export async function findOwnerForArea(
  clientNumber: string,
  area: string,
): Promise<DelegationEntry | null> {
  const row = await prisma.delegationMatrix.findFirst({
    where: {
      clientNumber,
      isActive: true,
      area: { equals: area.trim(), mode: 'insensitive' },
    },
  });
  return (row as unknown as DelegationEntry) ?? null;
}

/** Bust both the rendered-block cache and any future per-area caches. */
export async function invalidateMatrixCache(clientNumber: string): Promise<void> {
  try { await redisInvalidate(CACHE_KEY(clientNumber)); } catch { /* cache unavailable — non-fatal */ }
}
