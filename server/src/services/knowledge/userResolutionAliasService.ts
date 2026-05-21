/**
 * userResolutionAliasService — per-user alias memory.
 *
 * Sprint 2 (2026-05-21). Solves "every session asks 'which Asad?'"
 * by recording user-confirmed alias → identifier mappings. Once the
 * user has explicitly resolved "asad" → asad.ahmed@tmcltd.ai, the
 * resolver hits this table on every later mention and surfaces the
 * prior pick as a strong-preference candidate.
 *
 * Stored aliases are normalized (lowercase, trimmed) so "Asad",
 * "asad", " ASAD " all collide on one row per identifier.
 *
 * Sources of truth:
 *   - 'explicit' — user picked from disambiguation ("Asad Ahmed Taj")
 *   - 'inferred' — recipient was unambiguous on dispatch; we record
 *     for future convenience
 *   - 'pinned'   — manual user pin (Settings UI not yet wired)
 *
 * The resolver consumes this to:
 *   1. Boost the matching candidate's score sharply (or auto-pick if
 *      one identifier dominates the alias).
 *   2. Annotate the candidate block with "you've resolved 'asad' to
 *      this person before" so the LLM has a reason to commit
 *      confidently.
 */
import prisma from '../../db/prisma';

export type IdentifierKind = 'email' | 'phone';
export type AliasSource = 'explicit' | 'inferred' | 'pinned';

export interface UserAlias {
  alias: string;
  identifier: string;
  identifierKind: IdentifierKind;
  displayName: string | null;
  source: AliasSource;
  confidence: number;
  usedCount: number;
  lastUsedAt: Date;
}

/** Normalize an alias for storage / lookup. Lowercase, trim, collapse
 *  internal whitespace. Doesn't strip diacritics — those carry
 *  meaning in many names. */
export function normalizeAlias(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Normalize an email or phone identifier so lookups are stable. */
function normalizeIdentifier(raw: string, kind: IdentifierKind): string {
  const t = raw.trim();
  if (kind === 'email') return t.toLowerCase();
  // Phone: strip whitespace, parens, dashes — keep + and digits only.
  return t.replace(/[^\d+]/g, '');
}

/** Look up all aliases the user has recorded for a given alias word.
 *  Returns most-recently-used first. Typical result is 0 or 1 entries;
 *  >1 means the same alias has been resolved to different people at
 *  different times (rare; the resolver picks the most recent). */
export async function findAliasResolutions(
  userId: number,
  alias: string,
): Promise<UserAlias[]> {
  const norm = normalizeAlias(alias);
  const rows = await (prisma as any).userResolutionAlias.findMany({
    where: { userId, alias: norm },
    orderBy: { lastUsedAt: 'desc' },
    take: 5,
  });
  return rows.map(rowToAlias);
}

/** Look up resolutions for an identifier — used when we want to know
 *  "what does the user typically call this person?" for friendly
 *  preview rendering. */
export async function findAliasesForIdentifier(
  userId: number,
  identifier: string,
  identifierKind: IdentifierKind,
): Promise<UserAlias[]> {
  const normId = normalizeIdentifier(identifier, identifierKind);
  const rows = await (prisma as any).userResolutionAlias.findMany({
    where: { userId, identifier: normId, identifierKind },
    orderBy: { usedCount: 'desc' },
    take: 5,
  });
  return rows.map(rowToAlias);
}

/** Record a user-confirmed alias resolution. Upserts on
 *  (userId, alias, identifier) — repeat resolutions bump usedCount
 *  and lastUsedAt instead of inserting duplicates. */
export async function recordResolution(args: {
  clientNumber: string;
  userId: number;
  alias: string;
  identifier: string;
  identifierKind: IdentifierKind;
  displayName?: string | null;
  source?: AliasSource;
}): Promise<UserAlias> {
  const normAlias = normalizeAlias(args.alias);
  const normId = normalizeIdentifier(args.identifier, args.identifierKind);
  const source = args.source ?? 'explicit';

  // Upsert without composite unique helper — use updateMany then
  // create-if-missing pattern. Prisma's upsert requires a unique
  // constraint name match that can be brittle with composite keys.
  const existing = await (prisma as any).userResolutionAlias.findFirst({
    where: { userId: args.userId, alias: normAlias, identifier: normId },
  });
  let row: any;
  if (existing) {
    row = await (prisma as any).userResolutionAlias.update({
      where: { id: existing.id },
      data: {
        usedCount: { increment: 1 },
        lastUsedAt: new Date(),
        // Promote confidence on repeat use but cap at 1.0.
        confidence: Math.min(1.0, existing.confidence + 0.05),
        // Update displayName if newly provided (preserves prior name otherwise).
        ...(args.displayName ? { displayName: args.displayName } : {}),
      },
    });
  } else {
    row = await (prisma as any).userResolutionAlias.create({
      data: {
        clientNumber: args.clientNumber,
        userId: args.userId,
        alias: normAlias,
        identifier: normId,
        identifierKind: args.identifierKind,
        displayName: args.displayName ?? null,
        source,
        confidence: source === 'explicit' ? 1.0 : 0.6,
        usedCount: 1,
      },
    });
  }
  return rowToAlias(row);
}

/** Best-guess single alias for a name — picks the most-recently-used
 *  resolution. Used by the resolver to short-circuit ranking when the
 *  user has a clear historical preference. Returns null when no
 *  resolution is recorded. */
export async function bestAliasResolution(
  userId: number,
  alias: string,
): Promise<UserAlias | null> {
  const all = await findAliasResolutions(userId, alias);
  return all.length > 0 ? all[0] : null;
}

function rowToAlias(row: any): UserAlias {
  return {
    alias: row.alias,
    identifier: row.identifier,
    identifierKind: row.identifierKind as IdentifierKind,
    displayName: row.displayName ?? null,
    source: row.source as AliasSource,
    confidence: Number(row.confidence ?? 0),
    usedCount: Number(row.usedCount ?? 0),
    lastUsedAt: row.lastUsedAt,
  };
}
