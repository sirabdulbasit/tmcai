-- Section 35 Phase 1 — per-sender door policy for the tenant WhatsApp channel.
-- Owner ruling 2026-08-04: unknown senders get ONE ask ("reply or ignore?");
-- the decision persists until countermanded. Idempotent by construction.

CREATE TABLE IF NOT EXISTS wa_sender_policy (
  client_number   VARCHAR(20)  NOT NULL,
  phone           VARCHAR(32)  NOT NULL,
  owner_user_id   INTEGER      NOT NULL,
  -- 'pending'  → owner asked, no decision yet (repeat inbound never re-asks)
  -- 'allowed'  → owner said reply / sender had concern evidence
  -- 'ignored'  → owner said ignore; silent drop until countermanded
  policy          VARCHAR(12)  NOT NULL DEFAULT 'pending',
  -- 'owner_decision' | 'concern_evidence' — who/what set the policy.
  -- NEVER a Brain recommendation: ignore decisions are the owner's alone.
  decided_by      VARCHAR(24),
  decided_at      TIMESTAMPTZ,
  evidence        JSONB,
  note            VARCHAR(300),
  first_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_inbound_at TIMESTAMPTZ,
  CONSTRAINT wa_sender_policy_pkey PRIMARY KEY (client_number, phone)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'wa_sender_policy' AND indexname = 'wa_sender_policy_owner_idx'
  ) THEN
    CREATE INDEX wa_sender_policy_owner_idx ON wa_sender_policy (client_number, owner_user_id, policy);
  END IF;
END $$;
