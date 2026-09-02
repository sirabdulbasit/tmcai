-- DEF-292 — always save who a message came from.
--
-- Owner, 2026-09-02: *"whenever you receive any message from anyone always save the sender
-- number, can you do this??"*
--
-- Today `wa_sender_policy` records a `phone` that, for an `@lid` sender, is the SYNTHETIC
-- `'+' + lid-digits` — not a number, and DEF-121 forbids showing it. The three things that would
-- actually identify the sender were never persisted anywhere:
--
--   raw_sender_id     the untouched WhatsApp identifier (`…@lid` or `…@c.us`) — the only stable
--                     key for that human, and the key the alias lookup already uses
--   display_name      the name WhatsApp itself supplies (`notifyName`). Read since DEF-291 and,
--                     until now, used for one message and discarded
--   resolved_phone    the REAL number, the moment WhatsApp ever supplies one
--
-- `resolved_phone` is the point. WhatsApp withholds the number for an `@lid` sender until a
-- relationship exists (see DEF-291), so it is unknowable on the first message — but it often
-- becomes available later, and nothing was watching for that moment or keeping it. Now every
-- inbound re-checks, and the first time WhatsApp answers, the number is stored against an
-- identity that already has the whole history attached to it.
--
-- Idempotent by project rule: re-running changes nothing.

ALTER TABLE wa_sender_policy ADD COLUMN IF NOT EXISTS raw_sender_id     VARCHAR(64);
ALTER TABLE wa_sender_policy ADD COLUMN IF NOT EXISTS display_name      VARCHAR(120);
ALTER TABLE wa_sender_policy ADD COLUMN IF NOT EXISTS resolved_phone    VARCHAR(32);
ALTER TABLE wa_sender_policy ADD COLUMN IF NOT EXISTS resolved_phone_at TIMESTAMPTZ;
ALTER TABLE wa_sender_policy ADD COLUMN IF NOT EXISTS inbound_count     INTEGER NOT NULL DEFAULT 0;

-- Find a sender by the identifier WhatsApp actually sent, not by our synthetic stand-in.
CREATE INDEX IF NOT EXISTS wa_sender_policy_raw_id_idx
  ON wa_sender_policy (client_number, raw_sender_id);

-- "Which senders are still anonymous?" — the query behind ever closing this gap.
CREATE INDEX IF NOT EXISTS wa_sender_policy_unresolved_idx
  ON wa_sender_policy (client_number)
  WHERE resolved_phone IS NULL;
