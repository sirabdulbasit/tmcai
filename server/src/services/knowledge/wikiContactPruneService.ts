/**
 * Prune duplicate contacts in the store the Contacts page actually reads.
 *
 * Owner, 2026-08-25: three screenshots of duplicate contacts, a Prune that changed nothing, and
 * then — "after Prune i am stil seeing this why?"
 *
 * The answer was that Prune was working on the wrong table. `contactPruneService` operates on
 * `prisma.entity`; the Contacts page queries `wiki_pages WHERE page_type='entity_person'`. Two
 * parallel stores — 773 entities against 703 person pages — so Prune could run correctly, report
 * success, and leave his screen untouched. "Hamna ABAP TMC" is not an entity at all; only one
 * Hamna entity exists.
 *
 * Two rules, and the discipline is the same one that makes the difference between a merge you can
 * trust and a merge that quietly fuses two colleagues:
 *
 *   1. A LID IS RESOLVED FROM EVIDENCE, NEVER GUESSED. Hamna's page carried `+255043747987458`,
 *      her WhatsApp LID. Her real number is in `feed_events` under the same sender_name. That
 *      mapping is a fact already in the database, which is what makes rule 2 safe.
 *   2. MERGE ON AN EXACT IDENTIFIER, NEVER ON A NAME. Grouping is by normalised phone or
 *      lowercased email. "Yousuf" and "Yousaf" differ by one letter, and so do many real pairs of
 *      people; a name-similarity merge is how two humans become one and nobody notices.
 *
 * Nothing is deleted. The list route excludes `status IN ('archived','inactive','deleted',
 * 'contradicted')`, so archiving removes a row from the page while leaving it entirely
 * recoverable, stamped with the page that absorbed it. A merge decided by heuristic has to be
 * reversible by construction.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('wiki-contact-prune');

export interface WikiPruneResult {
  lidsResolved: number;
  duplicatesArchived: number;
  dryRun: boolean;
}

/** Rows whose stored "phone" is really a LID, and whose real number the feed can prove. */
const RESOLVE_LIDS = `
  WITH resolved AS (
    SELECT sender_name,
           MAX(CASE WHEN length(regexp_replace(sender_phone,'[^0-9]','','g')) >= 13
                    THEN regexp_replace(sender_phone,'[^0-9]','','g') END) AS lid,
           MAX(CASE WHEN length(regexp_replace(sender_phone,'[^0-9]','','g')) BETWEEN 8 AND 12
                    THEN sender_phone END)                                  AS real_phone
      FROM feed_events
     WHERE sender_name IS NOT NULL AND sender_phone IS NOT NULL AND client_number = $1
     GROUP BY sender_name
    HAVING MAX(CASE WHEN length(regexp_replace(sender_phone,'[^0-9]','','g')) >= 13 THEN 1 END) = 1
       AND MAX(CASE WHEN length(regexp_replace(sender_phone,'[^0-9]','','g')) BETWEEN 8 AND 12 THEN 1 END) = 1
  )
  UPDATE wiki_pages w
     SET metadata = jsonb_set(
                      jsonb_set(w.metadata::jsonb, '{phone}', to_jsonb(r.real_phone), true),
                      '{waLid}', to_jsonb(r.lid), true)
    FROM resolved r
   WHERE w.page_type = 'entity_person'
     AND w.client_number = $1
     AND w.title = r.sender_name
     AND regexp_replace(COALESCE(w.metadata->>'phone',''), '[^0-9]', '', 'g') = r.lid`;

/** Survivor = the `person:<email>` id (stable, email-derived), else the oldest page. */
const ARCHIVE_DUPES = `
  WITH ident AS (
    SELECT id, client_number, user_id, created_at,
           NULLIF(regexp_replace(COALESCE(metadata->>'phone',''), '[^0-9]', '', 'g'), '') AS ph,
           NULLIF(lower(COALESCE(metadata->>'email','')), '')                             AS em
      FROM wiki_pages
     WHERE page_type = 'entity_person'
       AND client_number = $1
       AND status NOT IN ('archived','inactive','deleted','contradicted')
  ), keyed AS (
    SELECT *, COALESCE(ph, em) AS k FROM ident WHERE COALESCE(ph, em) IS NOT NULL
  ), ranked AS (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY client_number, user_id, k
                              ORDER BY (id LIKE 'person:%') DESC, created_at ASC) AS rn,
           COUNT(*)    OVER (PARTITION BY client_number, user_id, k)              AS grp
      FROM keyed
  ), winners AS (SELECT * FROM ranked WHERE rn = 1 AND grp > 1),
     losers  AS (SELECT * FROM ranked WHERE rn > 1 AND grp > 1)
  UPDATE wiki_pages w
     SET status = 'archived',
         metadata = jsonb_set(
                      jsonb_set(w.metadata::jsonb, '{mergedInto}', to_jsonb(win.id), true),
                      '{mergedBy}', to_jsonb('wikiContactPrune'::text), true),
         last_updated_at = now()
    FROM losers l
    JOIN winners win ON win.client_number = l.client_number
                    AND win.user_id = l.user_id AND win.k = l.k
   WHERE w.id = l.id
     AND w.status NOT IN ('archived','inactive','deleted','contradicted')`;

/** Same grouping as ARCHIVE_DUPES, counting only — for the dry-run scan the button does first. */
const COUNT_DUPES = `
  WITH ident AS (
    SELECT id, client_number, user_id,
           NULLIF(regexp_replace(COALESCE(metadata->>'phone',''), '[^0-9]', '', 'g'), '') AS ph,
           NULLIF(lower(COALESCE(metadata->>'email','')), '')                             AS em
      FROM wiki_pages
     WHERE page_type = 'entity_person' AND client_number = $1
       AND status NOT IN ('archived','inactive','deleted','contradicted')
  ), keyed AS (SELECT *, COALESCE(ph, em) AS k FROM ident WHERE COALESCE(ph, em) IS NOT NULL)
  SELECT COALESCE(SUM(n - 1), 0)::int AS dupes FROM (
    SELECT COUNT(*) AS n FROM keyed GROUP BY client_number, user_id, k HAVING COUNT(*) > 1) x`;

export async function pruneWikiContacts(
  clientNumber: string,
  opts: { dryRun?: boolean } = {},
): Promise<WikiPruneResult> {
  const dryRun = opts.dryRun !== false;

  if (dryRun) {
    const rows = await prisma.$queryRawUnsafe<Array<{ dupes: number }>>(COUNT_DUPES, clientNumber)
      .catch(() => [] as Array<{ dupes: number }>);
    return { lidsResolved: 0, duplicatesArchived: rows[0]?.dupes ?? 0, dryRun: true };
  }

  // LIDs first: resolving one can CREATE the match the archive step then acts on, which is
  // exactly what happens for Hamna. Reversing the order would leave her duplicate in place.
  const lidsResolved = await prisma.$executeRawUnsafe(RESOLVE_LIDS, clientNumber).catch((e) => {
    log.warn('LID resolution failed — continuing to the archive pass', { error: e?.message });
    return 0;
  });
  const duplicatesArchived = await prisma.$executeRawUnsafe(ARCHIVE_DUPES, clientNumber).catch((e) => {
    log.warn('duplicate archive failed', { error: e?.message });
    return 0;
  });

  log.info('wiki contact prune', { clientNumber, lidsResolved, duplicatesArchived });
  return { lidsResolved: Number(lidsResolved), duplicatesArchived: Number(duplicatesArchived), dryRun: false };
}
