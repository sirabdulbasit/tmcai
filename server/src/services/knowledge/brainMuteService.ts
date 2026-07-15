/**
 * brainMuteService — central read-side enforcement of the 2026-05-13
 * three-state contact scope model.
 *
 * Background: contacts have metadata.scope ∈ {'private','normal','tenant'}.
 *   'private' means Brain ignores the contact entirely:
 *     - Out of My Attention
 *     - Out of Day Brief
 *     - No Open Items extraction from their threads
 *     - Suggester returns no card for their feed events
 *     - Instruction extractor doesn't include them in delegate-to context
 *
 * Important: this is a READ-side filter only. Feed events from Private
 * senders are STILL recorded into feed_events (audit/history matters,
 * and the user's WhatsApp/Gmail clients still receive the messages).
 * What's suppressed is Brain processing — the surface rendering, the
 * LLM suggestions, the open-item creation.
 *
 * Per the 2026-05-13 contacts-visibility-is-user-decided rule, Brain
 * MUST NOT auto-classify contacts into this list. It's populated only
 * by user click on the ContactsPage ScopeSelector → PATCH /scope.
 */
import prisma from '../../db/prisma';

export interface BrainMutedSet {
  /** Lowercased emails from wiki_pages where scope='private' for this user. */
  emails: Set<string>;
  /** Digit-only phone identifiers (E.164 minus '+'-leading rule, normalised). */
  phones: Set<string>;
  /** wiki_pages.id values for the muted entity_person rows. */
  entityIds: Set<string>;
}

const EMPTY: BrainMutedSet = {
  emails: new Set(),
  phones: new Set(),
  entityIds: new Set(),
};

// Per-request memo: a single Brain pipeline run (e.g. one
// buildAttentionList call) typically asks for the muted set 1–4 times
// across downstream filters. Memoise inside a 30s TTL so we don't
// re-query for each call site in the same pipeline run.
const cache = new Map<string, { value: BrainMutedSet; expiresAt: number }>();
const TTL_MS = 30_000;

function cacheKey(clientNumber: string, userId: number): string {
  return `${clientNumber}:${userId}`;
}

/**
 * Return the set of (emails, phones, entityIds) the user has marked
 * Private (Brain-muted) in their contacts. Scope is per-user — if a
 * contact is tenant-shared (scope='tenant'), it is by definition NOT
 * muted (you wouldn't share a contact you want Brain to ignore).
 *
 * Includes BOTH:
 *  - rows owned by this user (their explicit clicks)
 *  - linked-person siblings — when a user marks one row Private, the
 *    other identifier rows linked to the same person should also be
 *    treated as muted. Path B grouping: linkedPersonId joins the rows.
 */
export async function getBrainMutedSenders(
  clientNumber: string,
  userId: number,
): Promise<BrainMutedSet> {
  const key = cacheKey(clientNumber, userId);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: string;
      email: string | null;
      phone: string | null;
      linkedPersonId: string | null;
    }>>(
      `SELECT id,
              lower(metadata->>'email')          AS email,
              metadata->>'phone'                 AS phone,
              metadata->>'linkedPersonId'        AS "linkedPersonId"
         FROM wiki_pages
        WHERE client_number = $1
          AND user_id = $2
          AND page_type = 'entity_person'
          AND metadata->>'scope' = 'private'`,
      clientNumber, userId,
    );

    const emails = new Set<string>();
    const phones = new Set<string>();
    const entityIds = new Set<string>();
    const linkedIds = new Set<string>();
    for (const r of rows) {
      entityIds.add(r.id);
      if (r.email) emails.add(r.email);
      if (r.phone) {
        const norm = r.phone.replace(/[^\d+]/g, '');
        if (norm) phones.add(norm);
      }
      if (r.linkedPersonId) linkedIds.add(r.linkedPersonId);
    }

    // Expand via linkedPersonId — if any sibling identifier is in the
    // muted set, all linked siblings are too. Path B per-channel scope
    // technically lets each row have its own scope, but for Brain-mute
    // purposes it makes more sense to honor "I muted this person on
    // any channel → mute on all their channels". The user can flip
    // each row Private independently if they want finer control.
    if (linkedIds.size > 0) {
      const sibs = await prisma.$queryRawUnsafe<Array<{
        id: string; email: string | null; phone: string | null;
      }>>(
        `SELECT id,
                lower(metadata->>'email') AS email,
                metadata->>'phone'        AS phone
           FROM wiki_pages
          WHERE client_number = $1
            AND user_id = $2
            AND page_type = 'entity_person'
            AND metadata->>'linkedPersonId' = ANY($3::text[])`,
        clientNumber, userId, Array.from(linkedIds),
      );
      for (const s of sibs) {
        entityIds.add(s.id);
        if (s.email) emails.add(s.email);
        if (s.phone) {
          const norm = s.phone.replace(/[^\d+]/g, '');
          if (norm) phones.add(norm);
        }
      }
    }

    const value: BrainMutedSet = { emails, phones, entityIds };
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  } catch {
    return EMPTY;
  }
}

/** Convenience: is this email Brain-muted for this user? */
export async function isBrainMutedEmail(
  clientNumber: string, userId: number, email: string | null | undefined,
): Promise<boolean> {
  if (!email) return false;
  const set = await getBrainMutedSenders(clientNumber, userId);
  return set.emails.has(email.toLowerCase());
}

/** Convenience: is this phone Brain-muted for this user? */
export async function isBrainMutedPhone(
  clientNumber: string, userId: number, phone: string | null | undefined,
): Promise<boolean> {
  if (!phone) return false;
  const set = await getBrainMutedSenders(clientNumber, userId);
  const norm = String(phone).replace(/[^\d+]/g, '');
  return norm ? set.phones.has(norm) : false;
}

/** Convenience: is this wiki_pages id Brain-muted for this user? */
export async function isBrainMutedEntity(
  clientNumber: string, userId: number, entityId: string | null | undefined,
): Promise<boolean> {
  if (!entityId) return false;
  const set = await getBrainMutedSenders(clientNumber, userId);
  return set.entityIds.has(entityId);
}

/** Invalidate the cache for a (clientNumber, userId). Call when the
 *  user changes a contact's scope so the next read sees the new state. */
export function invalidateBrainMuteCache(
  clientNumber: string, userId: number,
): void {
  cache.delete(cacheKey(clientNumber, userId));
}
