-- DEF-296 — the email fallback delivered messages that could not be recorded, so the daily cap
-- silently stopped working.
--
-- Owner, 2026-09-02: *"why i am receiving these emails??"* — 30 `[open_item_draft_ask]` emails in
-- three minutes, against a daily cap of 20.
--
-- The mechanism, and it is entirely this constraint. When every WhatsApp channel fails,
-- `brainOutboundService` falls back to email and sets `channelsUsed = ['email']`, so the audit
-- write attempts `channel = 'email'`. This CHECK permitted only text / voicenote / call_cta /
-- call_business / auto, so the INSERT threw and **no row was written at all**. Consequences, in
-- order of how much they cost:
--
--   1. The daily cap counts rows with status 'sent' or 'partial'. With none written, `sentToday`
--      never increased — so the cap stopped bounding anything the moment WhatsApp went down, and
--      every queued notification poured into his inbox. The throttle failed exactly when the
--      channel it protects was already failing.
--   2. The per-kind rate limiter reads the same table, so it stopped working too.
--   3. Nothing recorded that Brain had emailed him. `channel` has NEVER held 'email' in 28,954
--      rows, which is what made this invisible for as long as it was.
--
-- Idempotent by project rule: dropping the old constraint by name and adding the widened one is
-- safe to re-run, and the ADD is guarded so a second run cannot fail.

ALTER TABLE brain_user_messages
  DROP CONSTRAINT IF EXISTS brain_user_messages_channel_check;

ALTER TABLE brain_user_messages
  ADD CONSTRAINT brain_user_messages_channel_check
  CHECK (channel IN ('text', 'voicenote', 'call_cta', 'call_business', 'auto', 'email'));
