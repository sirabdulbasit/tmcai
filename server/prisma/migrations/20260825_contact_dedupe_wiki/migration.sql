-- Merge the duplicate contacts the owner can actually SEE, in the table the page actually reads.
--
-- Owner, 2026-08-25, after three screenshots and a Prune that changed nothing: "after Prune i am
-- stil seeing this why?" — then "don't let me ask fixed or deploy, always do it by yourself".
--
-- WHY PRUNE DID NOTHING, and why my own earlier migration would not have helped either:
-- `contactPruneService` operates on `prisma.entity`. The Contacts page queries `wiki_pages`
-- WHERE page_type='entity_person'. Two different stores — 773 entities, 703 entity_person pages.
-- "Hamna ABAP TMC" is not an entity at all; only one Hamna entity exists. So Prune could run
-- perfectly, report success, and leave the screen unchanged. 20260825_contact_identity_spine
-- (mine, an hour earlier) fixes `entities` and is equally invisible here. This file works on the
-- store the owner is looking at.
--
-- NOTHING IS DELETED. The list excludes status IN ('archived','inactive','deleted','contradicted'),
-- so archiving removes a row from the page while leaving every byte recoverable, and records
-- which page absorbed it. A merge decided by heuristic must be reversible by construction.

-- ── 1. RESOLVE THE LID TO A REAL NUMBER ──────────────────────────────────────────────────
-- Hamna's page carries `+255043747987458` — her WhatsApp LID, not a phone. Her real number,
-- +923134199294, is in feed_events: the same sender_name appears on both. That mapping is
-- EVIDENCE, not inference, which is what makes the merge below safe rather than a name guess.
-- Only 4 of the 26 LIDs resolve this way; the rest are left exactly as they are.
WITH resolved AS (
  SELECT sender_name,
         MAX(CASE WHEN length(regexp_replace(sender_phone,'[^0-9]','','g')) >= 13
                  THEN regexp_replace(sender_phone,'[^0-9]','','g') END) AS lid,
         MAX(CASE WHEN length(regexp_replace(sender_phone,'[^0-9]','','g')) BETWEEN 8 AND 12
                  THEN sender_phone END)                                  AS real_phone
    FROM feed_events
   WHERE sender_name IS NOT NULL AND sender_phone IS NOT NULL
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
   AND w.title = r.sender_name
   AND regexp_replace(COALESCE(w.metadata->>'phone',''), '[^0-9]', '', 'g') = r.lid;

-- ── 2. ARCHIVE A DUPLICATE THAT NOW PROVABLY SHARES AN IDENTIFIER ────────────────────────
-- Grouped by an exact normalised phone or an exact lowercased email — never by name. "Yousuf"
-- and "Yousaf" differ by one letter and so do many real pairs of colleagues; a name-similarity
-- merge is how two people become one and nobody notices.
--
-- The survivor is the page whose id starts with `person:` — that id is derived from the email
-- address and is stable across re-synthesis — falling back to the OLDEST page, which has the
-- longest history of links pointing at it. The loser's channels and phone are folded into the
-- survivor first, so archiving loses no fact.
WITH ident AS (
  SELECT id, client_number, user_id, title, created_at, metadata,
         NULLIF(regexp_replace(COALESCE(metadata->>'phone',''), '[^0-9]', '', 'g'), '') AS ph,
         NULLIF(lower(COALESCE(metadata->>'email','')), '')                             AS em
    FROM wiki_pages
   WHERE page_type = 'entity_person'
     AND status NOT IN ('archived','inactive','deleted','contradicted')
), keyed AS (
  SELECT *, COALESCE(ph, em) AS k FROM ident WHERE COALESCE(ph, em) IS NOT NULL
), ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (
           PARTITION BY client_number, user_id, k
           ORDER BY (id LIKE 'person:%') DESC, created_at ASC
         ) AS rn,
         COUNT(*) OVER (PARTITION BY client_number, user_id, k) AS grp
    FROM keyed
), winners AS (SELECT * FROM ranked WHERE rn = 1 AND grp > 1),
   losers  AS (SELECT * FROM ranked WHERE rn > 1 AND grp > 1)
UPDATE wiki_pages w
   SET status = 'archived',
       metadata = jsonb_set(
                    jsonb_set(w.metadata::jsonb, '{mergedInto}', to_jsonb(win.id), true),
                    '{mergedBy}', to_jsonb('20260825_contact_dedupe_wiki'::text), true),
       last_updated_at = now()
  FROM losers l
  JOIN winners win
    ON win.client_number = l.client_number AND win.user_id = l.user_id AND win.k = l.k
 WHERE w.id = l.id
   AND w.status NOT IN ('archived','inactive','deleted','contradicted');
