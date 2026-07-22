-- Section 33a: delegation lifecycle spine (additive-only; REQ-003 approved).
-- Idempotent: safe to re-run. No existing tables are altered.

CREATE TABLE IF NOT EXISTS delegation_threads (
  id                            TEXT PRIMARY KEY,
  client_number                 VARCHAR(20) NOT NULL,
  owner_user_id                 INTEGER NOT NULL,
  open_item_id                  TEXT NOT NULL,
  counterpart_entity_id         TEXT,
  counterpart_key               VARCHAR(200) NOT NULL,
  counterpart_number_canonical  VARCHAR(32),
  counterpart_email_canonical   VARCHAR(200),
  channel                       VARCHAR(12) NOT NULL,
  state                         VARCHAR(32) NOT NULL DEFAULT 'awaiting_reply',
  origin                        VARCHAR(24) NOT NULL DEFAULT 'worker_send',
  active_intent_event_id        TEXT,
  prior_state                   VARCHAR(32),
  followup_count                INTEGER NOT NULL DEFAULT 0,
  next_followup_at              TIMESTAMP(3),
  grant_id                      TEXT,
  created_at                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at                    TIMESTAMP(3),
  closed_at                     TIMESTAMP(3),
  -- Channel-shape integrity (REQ-002 item 2): NULLs cannot bypass identity.
  CONSTRAINT delegation_threads_channel_shape CHECK (
    (channel = 'whatsapp' AND counterpart_key LIKE 'wa:+%' AND counterpart_number_canonical IS NOT NULL)
    OR
    (channel = 'email' AND counterpart_key LIKE 'em:%' AND counterpart_email_canonical IS NOT NULL)
  ),
  CONSTRAINT delegation_threads_state_valid CHECK (state IN (
    'pending_first_dispatch','dispatch_pending','awaiting_reply','evaluating',
    'awaiting_owner','followup_scheduled','resolved_pending_owner','reopened',
    'receipt_unknown','closed','expired','cancelled'
  ))
);
-- Composite-FK anchor (REQ-003 item 1 structural owner scoping).
CREATE UNIQUE INDEX IF NOT EXISTS delegation_threads_scope_uq
  ON delegation_threads (id, client_number, owner_user_id);
-- ACTIVE-state uniqueness (exact active set, REQ-002/REQ-003).
CREATE UNIQUE INDEX IF NOT EXISTS delegation_threads_active_uq
  ON delegation_threads (client_number, open_item_id, counterpart_key, channel)
  WHERE state IN ('pending_first_dispatch','dispatch_pending','awaiting_reply','evaluating',
                  'awaiting_owner','followup_scheduled','resolved_pending_owner','reopened','receipt_unknown');
CREATE INDEX IF NOT EXISTS delegation_threads_correlation_ix
  ON delegation_threads (client_number, counterpart_key, channel)
  WHERE state IN ('pending_first_dispatch','dispatch_pending','awaiting_reply','evaluating',
                  'awaiting_owner','followup_scheduled','resolved_pending_owner','reopened','receipt_unknown');
CREATE INDEX IF NOT EXISTS delegation_threads_recovery_ix
  ON delegation_threads (client_number, state, next_followup_at);

CREATE TABLE IF NOT EXISTS delegation_thread_events (
  id                   TEXT PRIMARY KEY,
  client_number        VARCHAR(20) NOT NULL,
  thread_id            TEXT NOT NULL REFERENCES delegation_threads(id),
  event_type           VARCHAR(32) NOT NULL,
  direction            VARCHAR(10),
  channel              VARCHAR(12) NOT NULL,
  sender_identity      VARCHAR(64),
  provider_message_id  VARCHAR(160),
  inbound_source_id    VARCHAR(160),
  quoted_provider_id   VARCHAR(160),
  email_message_id     VARCHAR(200),
  in_reply_to          VARCHAR(200),
  receipt_status       VARCHAR(20),
  source_event_id      TEXT,
  classifier_key       VARCHAR(80),
  classification       JSONB,
  provenance           VARCHAR(32) NOT NULL,
  prior_state          VARCHAR(32),
  evidence_source_type VARCHAR(24),
  evidence_source_id   VARCHAR(64),
  created_at           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT dte_event_type_valid CHECK (event_type IN (
    'outbound_intent','outbound_receipt','inbound_received',
    'classification_recorded','processing_error'
  ))
);
-- Durable atomic inbound dedup (append-only; REQ-001 item 4/6).
CREATE UNIQUE INDEX IF NOT EXISTS dte_inbound_dedup_uq
  ON delegation_thread_events (client_number, channel, inbound_source_id)
  WHERE inbound_source_id IS NOT NULL AND event_type = 'inbound_received';
-- Classification idempotency: one persisted verdict per source event per classifier.
CREATE UNIQUE INDEX IF NOT EXISTS dte_classification_uq
  ON delegation_thread_events (client_number, source_event_id, classifier_key)
  WHERE classifier_key IS NOT NULL AND event_type = 'classification_recorded';
-- Outbound correlation scoped to tenant+channel+sending identity (REQ-001 item 6).
CREATE UNIQUE INDEX IF NOT EXISTS dte_outbound_provider_uq
  ON delegation_thread_events (client_number, channel, sender_identity, provider_message_id)
  WHERE provider_message_id IS NOT NULL AND event_type = 'outbound_receipt';
CREATE INDEX IF NOT EXISTS dte_thread_ix ON delegation_thread_events (thread_id, created_at);
CREATE INDEX IF NOT EXISTS dte_email_corr_ix
  ON delegation_thread_events (client_number, channel, email_message_id)
  WHERE email_message_id IS NOT NULL;

-- Grants: SCHEMA ONLY in 33a — zero rows created/read/consumed (REQ-002 item 1).
CREATE TABLE IF NOT EXISTS delegation_authorization_grants (
  id              TEXT PRIMARY KEY,
  client_number   VARCHAR(20) NOT NULL,
  owner_user_id   INTEGER NOT NULL,
  open_item_id    TEXT NOT NULL,
  counterpart_key VARCHAR(200) NOT NULL,
  channel         VARCHAR(12) NOT NULL,
  source          VARCHAR(40) NOT NULL,
  granted_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      TIMESTAMP(3) NOT NULL,
  revoked_at      TIMESTAMP(3),
  metadata        JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS dag_lookup_ix
  ON delegation_authorization_grants (client_number, owner_user_id, open_item_id, counterpart_key, channel);

CREATE TABLE IF NOT EXISTS correlation_incidents (
  id              TEXT PRIMARY KEY,
  client_number   VARCHAR(20) NOT NULL,
  owner_user_id   INTEGER NOT NULL,
  channel         VARCHAR(12) NOT NULL,
  counterpart_key VARCHAR(200) NOT NULL,
  incident_date   DATE NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'open',
  overflow_count  INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at     TIMESTAMP(3),
  resolution_note TEXT
);
-- Owner IS in dedup scope (REQ-003 item 1): one owner's notice never suppresses another's.
CREATE UNIQUE INDEX IF NOT EXISTS correlation_incidents_dedup_uq
  ON correlation_incidents (client_number, owner_user_id, counterpart_key, channel, incident_date);
CREATE UNIQUE INDEX IF NOT EXISTS correlation_incidents_scope_uq
  ON correlation_incidents (id, client_number, owner_user_id);

CREATE TABLE IF NOT EXISTS correlation_incident_candidates (
  id            TEXT PRIMARY KEY,
  client_number VARCHAR(20) NOT NULL,
  owner_user_id INTEGER NOT NULL,
  incident_id   TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cic_incident_scope_fk FOREIGN KEY (incident_id, client_number, owner_user_id)
    REFERENCES correlation_incidents (id, client_number, owner_user_id),
  CONSTRAINT cic_thread_scope_fk FOREIGN KEY (thread_id, client_number, owner_user_id)
    REFERENCES delegation_threads (id, client_number, owner_user_id),
  CONSTRAINT cic_candidate_uq UNIQUE (incident_id, thread_id)
);
