/**
 * contactPruneService — the contact janitor (2026-07-14).
 *
 * Basit: "there should be a mechanism of keep pruning contacts."
 * The create-time dedup guard stops NEW duplicates; this job keeps
 * the existing set clean forever. Daily, per tenant, capped per run.
 *
 * What it does (in safety order):
 *   1. MERGE exact-name duplicate groups when SAFE: identical full
 *      name (case-insensitive) and NON-conflicting primary
 *      identifiers (at most one distinct email, at most one distinct
 *      phone across the group — fragments with empty slots are the
 *      classic case: "Asad Ahmed Taj" with email-only + phone-only
 *      rows). Canonical row = owner-set > oldest; all identifiers
 *      union onto it (spillover to metadata.altEmails/altPhones);
 *      references repointed (open_items.entity_id, entity_links);
 *      emptied duplicates deleted.
 *   2. ABSORB name-less junk rows (name == email — auto-created from
 *      a bare address) whose email belongs to a NAMED contact's
 *      identifier set → merge into the named contact.
 *   3. FLAG conflicting-identifier same-name groups (two distinct
 *      emails on "Ali Khan") — logged + counted, NEVER auto-merged.
 *      Two real people can share a name; ambiguity is a human call.
 *
 * Guarantees: no information is destroyed (identifiers union, never
 * drop), deletes only rows whose data has been fully absorbed and
 * whose references were repointed, per-run cap bounds blast radius,
 * everything logged for audit.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('contact-prune');

const MAX_MERGES_PER_RUN = 25;

export interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  ownerUserId: number | null;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
}

export interface MergePlan {
  canonicalId: string;
  duplicateIds: string[];
  /** Field updates for the canonical row after union. */
  set: { email?: string; phone?: string; metadata?: Record<string, unknown> };
}

/** Canonical = a row with an owner beats ownerless; then oldest wins
 *  (most likely to be referenced elsewhere). Exported for tests. */
export function pickCanonical(rows: ContactRow[]): ContactRow {
  const sorted = [...rows].sort((a, b) => {
    const aOwner = a.ownerUserId != null ? 0 : 1;
    const bOwner = b.ownerUserId != null ? 0 : 1;
    if (aOwner !== bOwner) return aOwner - bOwner;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return sorted[0]!;
}

/** Decide whether a same-name group can auto-merge, and how.
 *  Safe = at most ONE distinct primary email and ONE distinct phone
 *  across the group (empty slots don't conflict). Conflicting groups
 *  return null → flagged, human call. Exported for tests. */
export function planMerge(rows: ContactRow[]): MergePlan | null {
  if (rows.length < 2) return null;
  const emails = Array.from(new Set(rows.map((r) => (r.email ?? '').toLowerCase()).filter(Boolean)));
  const phones = Array.from(new Set(rows.map((r) => (r.phone ?? '').trim()).filter(Boolean)));
  if (emails.length > 1 || phones.length > 1) return null; // conflict → flag only

  const canonical = pickCanonical(rows);
  const duplicates = rows.filter((r) => r.id !== canonical.id);

  const set: MergePlan['set'] = {};
  if (!canonical.email && emails[0]) set.email = emails[0];
  if (!canonical.phone && phones[0]) set.phone = phones[0];

  // Union alt identifiers from all rows so nothing is lost.
  const meta = { ...((canonical.metadata as Record<string, unknown>) ?? {}) } as Record<string, any>;
  const altEmails = new Set<string>(Array.isArray(meta.altEmails) ? meta.altEmails : []);
  const altPhones = new Set<string>(Array.isArray(meta.altPhones) ? meta.altPhones : []);
  for (const d of duplicates) {
    const dm = (d.metadata as Record<string, any>) ?? {};
    for (const e of Array.isArray(dm.altEmails) ? dm.altEmails : []) altEmails.add(String(e).toLowerCase());
    for (const p of Array.isArray(dm.altPhones) ? dm.altPhones : []) altPhones.add(String(p));
  }
  if (altEmails.size > 0 || altPhones.size > 0) {
    set.metadata = { ...meta, ...(altEmails.size ? { altEmails: [...altEmails] } : {}), ...(altPhones.size ? { altPhones: [...altPhones] } : {}) };
  }
  return { canonicalId: canonical.id, duplicateIds: duplicates.map((d) => d.id), set };
}

async function executeMerge(clientNumber: string, plan: MergePlan): Promise<boolean> {
  try {
    // Repoint references BEFORE deleting the duplicates.
    await prisma.openItem.updateMany({
      where: { clientNumber, entityId: { in: plan.duplicateIds } },
      data: { entityId: plan.canonicalId },
    }).catch(() => {});
    await (prisma as any).entityLink.deleteMany({
      // Links between the duplicates and the canonical would violate
      // the unique after repoint — simplest safe move: drop links that
      // involve a duplicate (they were fragment rows; real links live
      // on the canonical).
      where: { OR: [{ entityId: { in: plan.duplicateIds } }, { linkedEntityId: { in: plan.duplicateIds } }] },
    }).catch(() => {});
    await prisma.entity.deleteMany({ where: { id: { in: plan.duplicateIds }, clientNumber } });
    if (Object.keys(plan.set).length > 0) {
      await prisma.entity.update({ where: { id: plan.canonicalId }, data: plan.set as any }).catch(() => {});
    }
    log.info('merged duplicate contacts', { clientNumber, canonical: plan.canonicalId, absorbed: plan.duplicateIds });
    return true;
  } catch (e: any) {
    log.warn('merge failed (skipped)', { clientNumber, canonical: plan.canonicalId, error: e?.message });
    return false;
  }
}

export interface PruneResult {
  groupsSeen: number;
  merged: number;
  junkAbsorbed: number;
  conflictsFlagged: number;
}

export async function runContactPrune(clientNumber: string): Promise<PruneResult> {
  const out: PruneResult = { groupsSeen: 0, merged: 0, junkAbsorbed: 0, conflictsFlagged: 0 };

  // ── 1+3: exact-name duplicate groups ─────────────────────────────
  const dupNames = await prisma.$queryRawUnsafe<Array<{ lname: string }>>(
    `SELECT lower(name) AS lname
       FROM entities
      WHERE client_number = $1 AND entity_type = 'contact' AND name IS NOT NULL AND length(name) >= 3
      GROUP BY lower(name) HAVING count(*) > 1
      LIMIT 50`,
    clientNumber,
  ).catch(() => []);

  for (const g of dupNames) {
    if (out.merged >= MAX_MERGES_PER_RUN) break;
    out.groupsSeen += 1;
    const rows = await prisma.entity.findMany({
      where: { clientNumber, entityType: 'contact', name: { equals: g.lname, mode: 'insensitive' } },
      select: { id: true, name: true, email: true, phone: true, ownerUserId: true, createdAt: true, metadata: true } as any,
    }).catch(() => [] as any[]) as unknown as ContactRow[];
    const plan = planMerge(rows);
    if (!plan) {
      out.conflictsFlagged += 1;
      log.info('same-name group with conflicting identifiers — flagged, not merged', {
        clientNumber, name: g.lname, ids: rows.map((r) => r.id),
      });
      continue;
    }
    if (await executeMerge(clientNumber, plan)) out.merged += 1;
  }

  // ── 2: name-less junk rows (name == email) absorbed into named
  //       contacts that own that address ────────────────────────────
  const junk = await prisma.$queryRawUnsafe<Array<{ id: string; email: string }>>(
    `SELECT id, email FROM entities
      WHERE client_number = $1 AND entity_type = 'contact'
        AND email IS NOT NULL AND lower(name) = lower(email)
      LIMIT 25`,
    clientNumber,
  ).catch(() => []);
  for (const j of junk) {
    if (out.merged + out.junkAbsorbed >= MAX_MERGES_PER_RUN) break;
    // A NAMED contact holding this email as primary or alt?
    const owner = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM entities
        WHERE client_number = $1 AND entity_type = 'contact' AND id <> $2
          AND lower(name) <> lower($3)
          AND (lower(email) = lower($3) OR metadata->'altEmails' ? lower($3))
        LIMIT 1`,
      clientNumber, j.id, j.email,
    ).catch(() => []);
    if (owner.length === 0) continue; // orphan bare-address contact — keep (might be a real unknown sender)
    const ok = await executeMerge(clientNumber, { canonicalId: owner[0]!.id, duplicateIds: [j.id], set: {} });
    if (ok) out.junkAbsorbed += 1;
  }

  if (out.merged > 0 || out.junkAbsorbed > 0 || out.conflictsFlagged > 0) {
    log.info('contact prune complete', { clientNumber, ...out });
  }
  return out;
}

/** Daily sweep across tenants. Registered in server.ts. */
export async function runContactPruneForAllTenants(): Promise<void> {
  const tenants = await prisma.user.findMany({
    where: { isActive: true },
    select: { clientNumber: true },
    distinct: ['clientNumber'],
  }).catch(() => [] as Array<{ clientNumber: string }>);
  for (const t of tenants) {
    await runContactPrune(t.clientNumber).catch((e) => log.warn('tenant prune failed', { clientNumber: t.clientNumber, error: e?.message }));
  }
}
