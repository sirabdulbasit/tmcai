/**
 * Person Identity — a canonical record per real human, across channels.
 *
 * Problem this solves: sender_history / sender_topic / attachment_doc
 * pages are keyed per-channel (email, phone, wa_id). The same person
 * sending emails AND WhatsApp messages ends up with two wiki pages
 * that don't know about each other. Brain can't answer "what did Fahim
 * say" holistically if "Fahim" spans multiple channels.
 *
 * Solution: treat the existing `entities` table (entity_type='contact')
 * as the canonical person record. Every channel identifier (email, phone,
 * wa_id) is stored on that row. Every wiki page produced from a
 * communication with that person gets tagged with `metadata.entityId`.
 *
 * At query time, when the composer finds a person-related page by
 * semantic search, it expands to ALL pages with the same entityId ⇒
 * cross-channel view in one prompt.
 *
 * Reconciliation rules (all run at sender-wiki upsert time):
 *   1. Primary key: email (for email-source) or phone (for WhatsApp).
 *   2. If no existing entity found by the primary key, search by NAME
 *      (fuzzy pg_trgm similarity > 0.7) — catches the case where we
 *      already have a WhatsApp-only entity for "Fahim Varraich" and
 *      now an email arrives from him.
 *   3. If a match is found, patch the missing channel identifier onto
 *      the existing entity.
 *   4. Otherwise create a fresh entity with the channel identifier.
 *
 * We never merge automatically across emails or across phones (high
 * false-positive risk). We do merge across channel TYPES (email+phone)
 * when name match is strong.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('person-identity');

const NAME_MATCH_THRESHOLD = 0.7;

export interface ResolveOptions {
  clientNumber: string;
  name?: string | null;
  company?: string | null;
}

/**
 * Resolve (or create) a person entity from an email address.
 * Returns the entity id so callers can tag wiki pages with it.
 */
export async function resolvePersonByEmail(email: string, opts: ResolveOptions): Promise<string | null> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  // 1) Exact email hit
  const direct = await prisma.entity.findFirst({
    where: { clientNumber: opts.clientNumber, entityType: 'contact', email: normalizedEmail },
    select: { id: true, name: true, phone: true },
  }).catch(() => null);
  if (direct) {
    // Patch name + company if we now have them and the entity didn't
    if (opts.name && !direct.name) {
      await prisma.entity.update({
        where: { id: direct.id },
        data: { name: opts.name.slice(0, 300), company: opts.company ?? undefined },
      }).catch(() => {});
    }
    return direct.id;
  }

  // 2) Name-based bridging — same person may already exist from WhatsApp
  if (opts.name && opts.name.trim().length >= 3) {
    const bridged = await findByNameForBridging(opts.clientNumber, opts.name, { hasEmail: false });
    if (bridged) {
      await prisma.entity.update({
        where: { id: bridged.id },
        data: {
          email: normalizedEmail,
          company: bridged.company ?? opts.company ?? undefined,
        },
      }).catch(() => {});
      log.info('bridged entity (WA→email)', { entityId: bridged.id, name: opts.name });
      return bridged.id;
    }
  }

  // 3) Create fresh
  const created = await prisma.entity.create({
    data: {
      entityType: 'contact',
      clientNumber: opts.clientNumber,
      name: (opts.name ?? normalizedEmail).slice(0, 300),
      email: normalizedEmail,
      company: opts.company ?? null,
    },
  }).catch(() => null);
  return created?.id ?? null;
}

/**
 * Resolve (or create) a person entity from a phone number (WhatsApp).
 * Same logic as email, with phone as the primary key.
 */
export async function resolvePersonByPhone(phone: string, opts: ResolveOptions): Promise<string | null> {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const direct = await prisma.entity.findFirst({
    where: { clientNumber: opts.clientNumber, entityType: 'contact', phone: normalizedPhone },
    select: { id: true, name: true, email: true },
  }).catch(() => null);
  if (direct) {
    if (opts.name && !direct.name) {
      await prisma.entity.update({
        where: { id: direct.id },
        data: { name: opts.name.slice(0, 300) },
      }).catch(() => {});
    }
    return direct.id;
  }

  if (opts.name && opts.name.trim().length >= 3) {
    const bridged = await findByNameForBridging(opts.clientNumber, opts.name, { hasPhone: false });
    if (bridged) {
      await prisma.entity.update({
        where: { id: bridged.id },
        data: { phone: normalizedPhone },
      }).catch(() => {});
      log.info('bridged entity (email→WA)', { entityId: bridged.id, name: opts.name });
      return bridged.id;
    }
  }

  const created = await prisma.entity.create({
    data: {
      entityType: 'contact',
      clientNumber: opts.clientNumber,
      name: (opts.name ?? normalizedPhone).slice(0, 300),
      phone: normalizedPhone,
    },
  }).catch(() => null);
  return created?.id ?? null;
}

/** Return every wiki_page id tagged to an entity, across all page types. */
export async function getPagesLinkedToEntity(
  clientNumber: string,
  entityId: string,
): Promise<Array<{ id: string; pageType: string; title: string; userId: number }>> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, page_type AS "pageType", title, user_id AS "userId"
       FROM wiki_pages
      WHERE client_number = $1
        AND metadata->>'entityId' = $2
        AND status NOT IN ('superseded','deleted')
      ORDER BY last_updated_at DESC
      LIMIT 40`,
    clientNumber, entityId,
  ).catch(() => []);
  return rows;
}

/** Ad-hoc: resolve a person by any available signal (name / email / phone). Used by the composer. */
export async function resolvePersonBySignals(
  clientNumber: string,
  signals: { email?: string | null; phone?: string | null; name?: string | null },
): Promise<string | null> {
  if (signals.email) {
    const hit = await prisma.entity.findFirst({
      where: { clientNumber, entityType: 'contact', email: normalizeEmail(signals.email) ?? undefined },
      select: { id: true },
    }).catch(() => null);
    if (hit) return hit.id;
  }
  if (signals.phone) {
    const hit = await prisma.entity.findFirst({
      where: { clientNumber, entityType: 'contact', phone: normalizePhone(signals.phone) ?? undefined },
      select: { id: true },
    }).catch(() => null);
    if (hit) return hit.id;
  }
  if (signals.name && signals.name.trim().length >= 3) {
    const hit = await findByNameForBridging(clientNumber, signals.name, {});
    if (hit) return hit.id;
  }
  return null;
}

// ─── internals ───────────────────────────────────────────────────

function normalizeEmail(raw: string): string | null {
  if (!raw) return null;
  // Accept "Name <email@x>" and "email@x" formats.
  const m = raw.match(/<([^>]+@[^>]+)>/);
  const email = (m ? m[1] : raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  let p = raw.replace(/[^\d+]/g, '');
  if (!p.startsWith('+') && p.length > 7) p = '+' + p;
  return p.length >= 8 ? p : null;
}

async function findByNameForBridging(
  clientNumber: string,
  name: string,
  want: { hasEmail?: boolean; hasPhone?: boolean },
): Promise<{ id: string; name: string | null; email: string | null; phone: string | null; company: string | null } | null> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, name, email, phone, company, similarity(name, $1) AS sim
       FROM entities
      WHERE client_number = $2
        AND entity_type = 'contact'
        AND name IS NOT NULL
        AND similarity(name, $1) > $3
      ORDER BY sim DESC
      LIMIT 5`,
    name, clientNumber, NAME_MATCH_THRESHOLD,
  ).catch(() => []);
  if (rows.length === 0) return null;
  // Require a channel slot to be empty if the caller specified.
  for (const r of rows) {
    if (want.hasEmail === false && r.email) continue;
    if (want.hasPhone === false && r.phone) continue;
    return r;
  }
  return null;
}
