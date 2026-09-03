import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { looksLikeLidDigits } from '../whatsapp/waIdentity';

const log = createLogger('scoped-contacts');

/**
 * DEF-040 — the ONLY place allowed to read a contact page.
 *
 * External audit, 2026-08-05: *"`fetch_contact_full` returns another user's private contact —
 * email, phone, saved-phonebook name, provenance and the other owner's user id — all readable by
 * any user in the tenant."* Verified still live on 2026-09-03: all three lookup limbs filtered on
 * `client_number` alone, and the renderer *detected* foreign ownership
 * (`another user (id ${row.userId})`) and printed the payload anyway. Measured exposure: user 2
 * could read all **351** contacts belonging to user 3, and vice versa.
 *
 * That is a **recurrence of the class fixed on 2026-05-25**. That one was a WRITER misattributing
 * rows; this is a READER with no scope predicate. The audit was explicit that the remedy must be
 * structural rather than a patched `WHERE`: *"one shared scoped-contact accessor that every reader
 * must use … CI guard naming it sole owner, same shape as `waIdentity.ts`."* This module is that
 * accessor, and `tests/def040ScopedContacts.test.ts` is that guard.
 *
 * THE RULE: **a contact is private to the user who owns it.** Tenant-wide visibility exists but
 * is opt-in and owner-set (`metadata.scope = 'tenant'`); as of today no row carries it, so in
 * practice every contact belongs to exactly one person. `client_number` alone is a TENANT
 * boundary and was never a user boundary — conflating the two is the whole defect.
 */
/**
 * The scope rule, matching what `entityCatalogRoutes` and `riskRulesService` already enforce.
 *
 * My first version of this omitted the third clause and was therefore **more restrictive than
 * the codebase's own convention** — it would have hidden contacts the requester had legitimately
 * discovered, trading a leak for a different wrong answer. Found by reading the two readers that
 * were already correct instead of assuming mine was the first.
 *
 *   user_id                      — you own it
 *   scope = 'tenant'             — the owner opted into sharing it
 *   discovered_by_users @> [you] — you are one of the people it surfaced through
 */
export const CONTACT_SCOPE_SQL =
  `(user_id = $2 OR metadata->>'scope' = 'tenant' OR metadata->'discovered_by_users' @> $3::jsonb)`;

export interface ScopedContactPage {
  id: string;
  title: string;
  userId: number;
  status: string;
  metadata: any;
  createdAt: Date | null;
  lastUpdatedAt: Date | null;
}

/**
 * DEF-298 — a LID never leaves here wearing a phone number's clothes.
 *
 * The owner has been shown a synthetic number THREE times, and said twice that it is useless to
 * him and must not appear anywhere owner-facing. DEF-293 fixed the FORMATTER and is deployed and
 * verified. This is the other half: 24 contact pages still STORE a 13+ digit LID in
 * `metadata.phone`, residue DEF-245 left behind when it cleaned `entities` and not these. The
 * third occurrence, "+109526195949711 (Mubarak Jharna Mahandri)", is verbatim what that row holds.
 *
 * `20260903_lid_is_not_a_phone` moves those 24 values to `waLid`. This is the guard that makes
 * the class unrepeatable rather than the instance fixed: a stale page, a re-synthesis from stale
 * data, or a future writer cannot put a LID in front of the owner through the contact path,
 * because the only reader of that path will not hand one out as a phone.
 *
 * Projected at the accessor, deliberately, not added as a second formatter — the audit's own
 * words, and `protection-with-two-implementations` is ten occurrences deep here. The value is not
 * destroyed: it moves to `waLid` on the way out, so internal callers that legitimately want the
 * WhatsApp identity still have it.
 */
function withoutLidAsPhone<T extends { metadata: any }>(row: T): T {
  const phone = row?.metadata?.phone;
  if (!phone || !looksLikeLidDigits(String(phone))) return row;
  const { phone: _dropped, ...rest } = row.metadata ?? {};
  return {
    ...row,
    metadata: { ...rest, waLid: row.metadata?.waLid ?? String(phone), phoneWasLid: true },
  };
}

/** Look a contact up by wiki page id, email, or phone — scoped to what the requester may see. */
export async function findScopedContactPage(args: {
  clientNumber: string;
  userId: number;
  byId?: string;
  byEmail?: string;
  byPhone?: string;
}): Promise<ScopedContactPage | null> {
  const { clientNumber, userId } = args;
  const discoveredBy = JSON.stringify([userId]);
  const select = `SELECT id, title, user_id AS "userId", status, metadata,
                         created_at AS "createdAt", last_updated_at AS "lastUpdatedAt"
                    FROM wiki_pages
                   WHERE client_number = $1 AND page_type = 'entity_person'
                     AND ${CONTACT_SCOPE_SQL}`;
  try {
    if (args.byId) {
      const rows = await prisma.$queryRawUnsafe<ScopedContactPage[]>(
        `${select} AND id = $4 LIMIT 1`, clientNumber, userId, discoveredBy, args.byId);
      return rows[0] ? withoutLidAsPhone(rows[0]) : null;
    }
    if (args.byEmail) {
      const rows = await prisma.$queryRawUnsafe<ScopedContactPage[]>(
        `${select} AND lower(metadata->>'email') = $4 LIMIT 1`,
        clientNumber, userId, discoveredBy, args.byEmail.toLowerCase());
      return rows[0] ? withoutLidAsPhone(rows[0]) : null;
    }
    if (args.byPhone) {
      const rows = await prisma.$queryRawUnsafe<ScopedContactPage[]>(
        `${select} AND regexp_replace(coalesce(metadata->>'phone',''), '[^0-9+]','','g') = $4 LIMIT 1`,
        clientNumber, userId, discoveredBy, args.byPhone);
      return rows[0] ? withoutLidAsPhone(rows[0]) : null;
    }
    return null;
  } catch (error: any) {
    // Fail CLOSED. A lookup that errors must not fall back to an unscoped read — that is how the
    // original defect would come back wearing a try/catch.
    log.warn('scoped contact lookup failed — returning nothing', {
      error: String(error?.message ?? error).slice(0, 140),
    });
    return null;
  }
}

/** Phone numbers on a contact matched by email — scoped, and excluding retired records. */
export async function findScopedContactPhonesByEmail(args: {
  clientNumber: string;
  userId: number;
  email: string;
}): Promise<string[]> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ phone: string }>>(
      `SELECT regexp_replace(coalesce(metadata->>'phone',''), '[^0-9+]','','g') AS phone
         FROM wiki_pages
        WHERE client_number = $1 AND page_type = 'entity_person'
          AND ${CONTACT_SCOPE_SQL}
          AND lower(metadata->>'email') = $4
          AND status NOT IN ('archived','inactive','deleted','contradicted')`,
      args.clientNumber, args.userId, JSON.stringify([args.userId]), args.email.toLowerCase());
    // Same rule for the phone list: a LID is not a number anyone can message, so handing one
    // to the WhatsApp resolver would produce a send to an address the owner never chose.
    return rows.map((r) => r.phone).filter((phone) => Boolean(phone) && !looksLikeLidDigits(phone));
  } catch (error: any) {
    log.warn('scoped contact phone lookup failed — returning nothing', {
      error: String(error?.message ?? error).slice(0, 140),
    });
    return [];
  }
}
