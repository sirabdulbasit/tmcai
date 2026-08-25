-- Wire the identity spine that already exists, and stop the phone column holding WhatsApp LIDs.
--
-- Owner, 2026-08-25, sending three screenshots of the Contacts page: two rows for Hamna, SIX for
-- Muhammad Yousuf, two for Asad Ahmed sharing one email. Then: "the contacts are not being
-- Self Pruning". CL-037 / DEF-245.
--
-- MEASURED BEFORE WRITING THIS:
--     773  contact entities
--     773  with linked_person_id NULL          — one hundred percent
--     215  with an EMAIL ADDRESS as the name   — 28%
--      26  with a LID-shaped phone (13+ digits)
--     974  persons rows · 1,953 facets (974 email + 974 entity_id + 4 user_id + 1 phone)
--
-- The schema audit recommended "make Person/PersonFacet the identity spine". It ALREADY IS one —
-- populated, with 974 entity_id facets recording exactly which entity each person is. It is
-- connected to nothing: every contact has the linking column NULL. So this is not a migration to
-- a new model. It connects a column to the table sitting beside it.

-- ── 1. A LID IS NOT A PHONE NUMBER ───────────────────────────────────────────────────────
-- Hamna's WhatsApp LID `255043747987458@lid` (confirmed in the production log) was stored as
-- `+255043747987458`, so her WhatsApp identity could never match her real +923134199294 and she
-- appears twice. `whatsapp-lid-activity-rejected` is at 7 occurrences.
--
-- MOVED, NEVER DELETED. The shape test is a heuristic — E.164 permits up to 15 digits, so a
-- genuine long number could in principle be caught. The data says otherwise here (118 contacts
-- sit at 12 digits, and every 13+ example is plainly a LID, one of them the tenant's own number
-- filed under the name "Nexeo") — but a heuristic that DELETES is a different risk from one that
-- RELOCATES. Nothing is lost: if a real number is caught, it is in wa_lid and recoverable.
ALTER TABLE entities ADD COLUMN IF NOT EXISTS wa_lid VARCHAR(32);

COMMENT ON COLUMN entities.wa_lid IS
  'WhatsApp LID (<digits>@lid), digits only. NEVER a dialable number — that is `phone`. Populated by 20260825_contact_identity_spine for rows whose phone held a LID.';

UPDATE entities
   SET wa_lid = COALESCE(wa_lid, regexp_replace(phone, '[^0-9]', '', 'g')),
       phone  = NULL
 WHERE phone IS NOT NULL
   AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 13;

-- ── 2. CONNECT THE SPINE ─────────────────────────────────────────────────────────────────
-- linked_person_id is a GROUP key, not a foreign key: "rows with the same linkedPersonId form a
-- person group" (schema.prisma). So the value must be stable for one human across every row.
--
-- Grouped by persons.canonical_name, NOT by person id: persons are duplicated per user (user 2
-- and user 3 each hold a "Hamna Latif Bhutta"), so a person id would give the same human two
-- different group keys — reproducing the bug in a new column. MIN(id) per canonical name is
-- deterministic and re-runnable.
--
-- NO FUZZY MATCHING. Only links that already exist as entity_id facets are used. That reaches
-- 424 of 773 contacts across 410 humans. It will NOT merge Muhammad Yousuf's five rows, because
-- nothing in the data yet proves ".com" and ".ai" are one man — and inventing that proof from
-- name similarity is how two different people get merged. "Yousuf" and "Yousaf" differ by one
-- letter; so do many real pairs of colleagues.
--
-- Rows whose person has a NULL or empty canonical_name are SKIPPED. One such person currently
-- holds 6 entities; grouping those under a shared key would assert six strangers are one person
-- on the strength of a missing field.
--
-- GROUPED BY NAME ALONE, and the first draft of this file got it wrong in a way worth recording:
-- it grouped by (entity_id, canonical_name), which puts exactly one entity in every group. The
-- rehearsal reported "groups holding MORE THAN ONE contact row: 0" — a migration that populates
-- a column, satisfies every check, and deduplicates nothing. Caught only because the rehearsal
-- asked whether anything had actually been GROUPED, rather than whether the column was filled.
WITH named AS (
  SELECT f.facet_value AS entity_id, pr.canonical_name
    FROM person_facets f
    JOIN persons pr ON pr.id = f.person_id
   WHERE f.facet_type = 'entity_id'
     AND pr.canonical_name IS NOT NULL
     AND btrim(pr.canonical_name) <> ''
), grp AS (
  SELECT n.entity_id,
         MIN(k.group_id)::varchar(32) AS group_id
    FROM named n
    JOIN (SELECT canonical_name, MIN(entity_id) AS group_id
            FROM named GROUP BY canonical_name) k
      ON k.canonical_name = n.canonical_name
   GROUP BY n.entity_id
)
UPDATE entities e
   SET linked_person_id = grp.group_id
  FROM grp
 WHERE e.id = grp.entity_id
   AND e.linked_person_id IS DISTINCT FROM grp.group_id;

-- ── 3. Make the group key queryable ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS entities_linked_person_id_idx ON entities (linked_person_id);
CREATE INDEX IF NOT EXISTS entities_wa_lid_idx ON entities (wa_lid);
