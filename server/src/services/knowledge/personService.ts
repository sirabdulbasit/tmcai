/**
 * personService — unified per-user identity for someone the user
 * communicates with.
 *
 * Quality Sprint 3 (2026-05-21). Solves "Asad-in-Gmail +
 * Asad-in-WhatsApp + Asad-in-Calendar are three different rows".
 * A Person aggregates all facets (email, phone, WA JID, internal
 * user id, entity id) under one identity per (userId, clientNumber).
 *
 * Public API:
 *   - findPersonByFacet(userId, facetType, facetValue)
 *   - findPersonsByName(userId, nameFragment)
 *   - findOrCreatePersonByFacet — get or create + auto-link
 *   - linkFacet — add identifier to existing person
 *   - mergePersons — combine two records (for manual data cleanup)
 *   - getPersonWithFacets(personId)
 *   - renderPersonContextLine — for resolver candidate enrichment
 *
 * Auto-linking heuristic:
 *   - When linking a new facet, look for an existing Person whose
 *     canonicalName matches AND already has another facet of a
 *     different type. If found, prefer linking to that person rather
 *     than creating a new one.
 *   - Conservative: name match alone is NOT enough to merge two
 *     different identifier sets. The user's explicit confirmation
 *     (via alias memory) is the trigger for cross-channel merging.
 */
import prisma from '../../db/prisma';

export type FacetType = 'email' | 'phone' | 'whatsapp_jid' | 'user_id' | 'entity_id';
export type FacetSource = 'user_explicit' | 'inferred' | 'system' | 'backfill';

export interface PersonRecord {
  id: string;
  clientNumber: string;
  userId: number;
  displayName: string;
  canonicalName: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface PersonFacetRecord {
  id: string;
  personId: string;
  facetType: FacetType;
  facetValue: string;
  verified: boolean;
  source: FacetSource;
  confidence: number;
  lastSeenAt: Date | null;
}

export interface PersonWithFacets extends PersonRecord {
  facets: PersonFacetRecord[];
}

/** Normalize a name for canonical comparison. Lowercase, collapse
 *  internal whitespace, trim. Doesn't strip diacritics. */
export function canonicalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Normalize a facet value for storage and lookup. Stable across
 *  case / formatting differences for the same identifier. */
export function normalizeFacetValue(facetType: FacetType, raw: string): string {
  const t = raw.trim();
  if (facetType === 'email') return t.toLowerCase();
  if (facetType === 'phone' || facetType === 'whatsapp_jid') {
    // Keep + and digits only — strip spaces, dashes, parens.
    return t.replace(/[^\d+]/g, '');
  }
  return t;
}

/** Look up a person by an exact identifier. Returns null when no
 *  facet matches the (type, value) pair for this user. */
export async function findPersonByFacet(
  userId: number,
  facetType: FacetType,
  facetValue: string,
): Promise<PersonWithFacets | null> {
  const normValue = normalizeFacetValue(facetType, facetValue);
  // Facets are unique by (personId, facetType, facetValue) but the
  // SAME (facetType, facetValue) can in theory appear under multiple
  // persons across users. Filter by userId via the join.
  const facet = await (prisma as any).personFacet.findFirst({
    where: { facetType, facetValue: normValue, person: { userId } },
    include: { person: { include: { facets: true } } },
  });
  if (!facet?.person) return null;
  return rowToPersonWithFacets(facet.person);
}

/** Fuzzy lookup by name fragment. Matches canonicalName containing
 *  the lowercased fragment. Returns most-recently-updated first. */
export async function findPersonsByName(
  userId: number,
  nameFragment: string,
  limit = 10,
): Promise<PersonWithFacets[]> {
  const frag = canonicalizeName(nameFragment);
  if (!frag) return [];
  const rows = await (prisma as any).person.findMany({
    where: {
      userId,
      canonicalName: { contains: frag, mode: 'insensitive' },
    },
    include: { facets: true },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  return rows.map(rowToPersonWithFacets);
}

/** Find a Person by facet, or create one if none exists. When
 *  creating, the displayName must be provided; the facet is added
 *  as the initial row. Idempotent — repeat calls return the same
 *  person and bump lastSeenAt on the facet. */
export async function findOrCreatePersonByFacet(args: {
  clientNumber: string;
  userId: number;
  displayName: string;
  facetType: FacetType;
  facetValue: string;
  source?: FacetSource;
  verified?: boolean;
}): Promise<PersonWithFacets> {
  const normValue = normalizeFacetValue(args.facetType, args.facetValue);
  const existing = await findPersonByFacet(args.userId, args.facetType, normValue);
  if (existing) {
    // Bump lastSeenAt on the facet.
    const targetFacet = existing.facets.find((f) => f.facetType === args.facetType && f.facetValue === normValue);
    if (targetFacet) {
      await (prisma as any).personFacet.update({
        where: { id: targetFacet.id },
        data: { lastSeenAt: new Date() },
      }).catch(() => undefined);
    }
    return existing;
  }
  // No existing Person for this facet. Try the auto-link heuristic:
  // if a person with the same canonical name AND a DIFFERENT facet
  // type already exists for this user, attach the new facet to them.
  const canonical = canonicalizeName(args.displayName);
  if (canonical) {
    const sameNamePersons = await findPersonsByName(args.userId, args.displayName, 5);
    const candidate = sameNamePersons.find((p) =>
      p.facets.some((f) => f.facetType !== args.facetType) &&
      !p.facets.some((f) => f.facetType === args.facetType),
    );
    if (candidate) {
      await linkFacet({
        personId: candidate.id,
        facetType: args.facetType,
        facetValue: normValue,
        source: args.source ?? 'inferred',
        verified: !!args.verified,
      });
      return (await getPersonWithFacets(candidate.id)) ?? candidate;
    }
  }
  // Create a fresh Person + initial facet.
  const created = await (prisma as any).person.create({
    data: {
      clientNumber: args.clientNumber,
      userId: args.userId,
      displayName: args.displayName,
      canonicalName: canonical || null,
      facets: {
        create: {
          facetType: args.facetType,
          facetValue: normValue,
          source: args.source ?? 'inferred',
          verified: !!args.verified,
          lastSeenAt: new Date(),
        },
      },
    },
    include: { facets: true },
  });
  return rowToPersonWithFacets(created);
}

/** Add a facet to an existing Person. Idempotent via the unique
 *  (personId, facetType, facetValue) constraint — repeat calls
 *  bump lastSeenAt instead of inserting duplicates. */
export async function linkFacet(args: {
  personId: string;
  facetType: FacetType;
  facetValue: string;
  source: FacetSource;
  verified?: boolean;
  confidence?: number;
}): Promise<void> {
  const normValue = normalizeFacetValue(args.facetType, args.facetValue);
  const existing = await (prisma as any).personFacet.findFirst({
    where: {
      personId: args.personId,
      facetType: args.facetType,
      facetValue: normValue,
    },
  });
  if (existing) {
    await (prisma as any).personFacet.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: new Date(),
        verified: existing.verified || !!args.verified,
        confidence: Math.min(1.0, existing.confidence + 0.05),
      },
    });
    return;
  }
  await (prisma as any).personFacet.create({
    data: {
      personId: args.personId,
      facetType: args.facetType,
      facetValue: normValue,
      source: args.source,
      verified: !!args.verified,
      confidence: args.confidence ?? (args.source === 'user_explicit' ? 1.0 : 0.7),
      lastSeenAt: new Date(),
    },
  });
}

/** Merge two Person records — typically used for manual cleanup
 *  when the auto-link heuristic misses a true match. Moves all
 *  facets from secondary to primary, deletes secondary. */
export async function mergePersons(
  primaryId: string,
  secondaryId: string,
): Promise<void> {
  if (primaryId === secondaryId) return;
  await prisma.$transaction(async (tx) => {
    const secondaryFacets = await (tx as any).personFacet.findMany({
      where: { personId: secondaryId },
    });
    for (const f of secondaryFacets) {
      // Move facet to primary; ignore unique-conflict (already exists on primary).
      try {
        await (tx as any).personFacet.update({
          where: { id: f.id },
          data: { personId: primaryId },
        });
      } catch { /* unique conflict — drop the duplicate */
        await (tx as any).personFacet.delete({ where: { id: f.id } }).catch(() => undefined);
      }
    }
    await (tx as any).person.delete({ where: { id: secondaryId } }).catch(() => undefined);
  });
}

/** Fetch a Person and all its facets. */
export async function getPersonWithFacets(personId: string): Promise<PersonWithFacets | null> {
  const row = await (prisma as any).person.findUnique({
    where: { id: personId },
    include: { facets: true },
  });
  return row ? rowToPersonWithFacets(row) : null;
}

/** Render a one-line context string for resolver candidate enrichment.
 *  Used to surface "also reachable via X" so the LLM sees cross-
 *  channel coherence without having to grep multiple rows. */
export function renderPersonContextLine(person: PersonWithFacets): string {
  const emails = person.facets.filter((f) => f.facetType === 'email').map((f) => f.facetValue);
  const phones = person.facets.filter((f) => f.facetType === 'phone' || f.facetType === 'whatsapp_jid').map((f) => f.facetValue);
  const parts: string[] = [];
  if (emails.length > 0) parts.push(`email${emails.length === 1 ? '' : 's'}: ${emails.join(', ')}`);
  if (phones.length > 0) parts.push(`phone${phones.length === 1 ? '' : 's'}: ${phones.join(', ')}`);
  if (parts.length === 0) return '';
  return `known to you across — ${parts.join('; ')}`;
}

// ─── Internal helpers ───────────────────────────────────────────

function rowToPersonWithFacets(row: any): PersonWithFacets {
  return {
    id: row.id,
    clientNumber: row.clientNumber,
    userId: row.userId,
    displayName: row.displayName,
    canonicalName: row.canonicalName ?? null,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    facets: (row.facets ?? []).map((f: any) => ({
      id: f.id,
      personId: f.personId,
      facetType: f.facetType as FacetType,
      facetValue: f.facetValue,
      verified: !!f.verified,
      source: f.source as FacetSource,
      confidence: Number(f.confidence ?? 0),
      lastSeenAt: f.lastSeenAt ?? null,
    })),
  };
}
