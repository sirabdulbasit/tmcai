-- DEF-305 / CL-052 — Brain's own inbox.
--
-- Owner ruling, 2026-09-03: "since brain knows his own number so the message sent to this number
-- is the message for brain (not for user), brain will analyze and see to whom it is relevant to
-- notify or not ... if something really important to notify user then do (but brain should know
-- to which user he should notify)".
--
-- WHY A TABLE IS THE PRECONDITION, not an implementation detail. Today a third party's message
-- to Brain's number is recorded NOWHERE as a message. `whatsapp_messages` is inserted only AFTER
-- identity resolution (WhatsAppInbound.ts:241), so it holds conversations with REGISTERED users
-- only. The sole surviving trace of an unregistered sender's message is the relay notification in
-- `brain_user_messages` plus a counter on `wa_sender_policy`.
--
-- So making notification selective WITHOUT this table would delete the record along with the
-- notification, and Brain could no longer answer "did anybody message you" — which is DEF-270,
-- a defect the owner reported and which was fixed by reading the relay log. The record and the
-- notification have to be separate things before one of them can become optional.
--
-- The decision is stored alongside the message, not just acted on: `relevant_user_id`,
-- `relevance_reason`, `notify_decision` and `notify_reason` make every withheld notification
-- auditable. A message Brain decided not to forward must be explainable later, or "brain will
-- decide" becomes "brain silently dropped it" — the shape of DEF-060, where real people messaged
-- and the owner was never told and the only trace was one log line.

CREATE TABLE IF NOT EXISTS brain_inbox_messages (
  id               BIGSERIAL PRIMARY KEY,
  client_number    VARCHAR(20) NOT NULL,

  -- Identity as it arrived. `raw_sender_id` is the transport's own id (a `@lid` or `@c.us`
  -- address) and is the only durable key for an @lid sender. `sender_phone` holds a REAL
  -- number when one is known and is left NULL rather than filled with the @lid-derived
  -- synthetic — the owner has ruled twice that the synthetic must never appear anywhere
  -- owner-facing (DEF-293, DEF-298).
  raw_sender_id    TEXT,
  sender_phone     TEXT,
  sender_name      TEXT,

  body             TEXT NOT NULL,
  wa_message_id    VARCHAR(120),
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Which user this concerns, and why. NULL means Brain could not attribute it to anyone,
  -- which is a fact about the message and not an error.
  relevant_user_id  INTEGER,
  relevance_reason  TEXT,

  -- What Brain decided to do, and why, in its own words.
  notify_decision   TEXT NOT NULL DEFAULT 'pending',
  notify_reason     TEXT,
  notified_at       TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Who messaged me in the last N hours" — the question this table exists to answer.
CREATE INDEX IF NOT EXISTS brain_inbox_messages_recent_idx
  ON brain_inbox_messages (client_number, received_at DESC);

-- "What did I decide to withhold, and for whom" — the audit direction.
CREATE INDEX IF NOT EXISTS brain_inbox_messages_decision_idx
  ON brain_inbox_messages (client_number, relevant_user_id, notify_decision, received_at DESC);

-- Same sender across many messages, for the sender-level view.
CREATE INDEX IF NOT EXISTS brain_inbox_messages_sender_idx
  ON brain_inbox_messages (client_number, raw_sender_id, received_at DESC);

-- The decision vocabulary is closed, so an unrecognised value is a bug that surfaces at the
-- write rather than a silent state nothing handles. 'pending' is the pre-decision state.
--
-- NOTE FOR WHOEVER APPLIES THIS: no comment below contains a semicolon, deliberately. The
-- first version had one inside "-- unknown sender; the one-time triage ask ...", and a naive
-- split-on-semicolon applier cut this statement in half and reported a syntax error on the
-- fragment. A migration that only applies under a clever applier is a migration that will
-- silently half-apply one day.
ALTER TABLE brain_inbox_messages DROP CONSTRAINT IF EXISTS brain_inbox_messages_decision_check;
ALTER TABLE brain_inbox_messages ADD CONSTRAINT brain_inbox_messages_decision_check
  CHECK (notify_decision IN (
    'pending',              -- recorded, not yet decided
    'notified',             -- forwarded to a user
    'withheld_not_substantive',  -- Brain judged it did not warrant interrupting anyone
    'withheld_no_user',     -- nobody it could be attributed to
    'withheld_ignored_sender',   -- standing ignore policy on this sender
    'asked_owner',          -- unknown sender, so the one-time triage ask went out instead
    'notify_failed'         -- the decision was to notify and the send did not succeed
  ));

-- BACKFILL — the history has to move with the reader.
--
-- The reasoning block used to read relayed messages out of `brain_user_messages`, and 14 of
-- them are in the last 24 hours alone. Pointing the block at `brain_inbox_messages` without
-- moving that history would have blanked it until new mail arrived: Brain would have answered
-- "nobody has messaged me" about messages it had forwarded an hour earlier, which is DEF-270
-- word for word. Caught by a DEF-270 guard test going red, which is what that test is for.
--
-- These rows really were forwarded, so they land as `notified` with an honest reason. The body
-- comes from `metadata->>'relayedBody'` where present, and otherwise from the dedup key, whose
-- shape is `wa_counterpart:<identity>:<first 40 chars of body>` — read-only recovery of text
-- that is already there, the same fallback the old block used, and marked as truncated.
--
-- Idempotent through `wa_message_id`, which carries the source row id.

INSERT INTO brain_inbox_messages
  (client_number, raw_sender_id, sender_phone, sender_name, body, wa_message_id,
   received_at, relevant_user_id, relevance_reason, notify_decision, notify_reason, notified_at)
SELECT
  b.client_number,
  NULLIF(split_part(regexp_replace(coalesce(b.dedup_key,''), '^wa_counterpart:', ''), ':', 1), ''),
  NULL,
  NULL,
  COALESCE(
    NULLIF(b.metadata->>'relayedBody', ''),
    NULLIF(array_to_string((string_to_array(coalesce(b.dedup_key,''), ':'))[3:], ':'), '')
      || ' (truncated at 40 chars by the dedup key it was recovered from)'
  ),
  'backfill:' || b.id::text,
  b.created_at,
  b.user_id,
  'backfilled from the relay log, which had one recipient by design',
  'notified',
  'forwarded before Brain decided for itself (Section 35, unconditional relay)',
  b.created_at
FROM brain_user_messages b
WHERE b.kind = 'wa_counterpart_message'
  AND NOT EXISTS (
    SELECT 1 FROM brain_inbox_messages i WHERE i.wa_message_id = 'backfill:' || b.id::text
  );
