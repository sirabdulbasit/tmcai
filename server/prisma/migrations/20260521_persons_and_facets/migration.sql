-- Quality Sprint 3 (2026-05-21): unified per-user Person identity.
-- Solves "Asad-via-Gmail + Asad-via-WhatsApp + Asad-via-Calendar
-- are three different rows" — Persons aggregate all facets (email,
-- phone, WA JID, internal user id, entity id) under one identity
-- per (userId, clientNumber).

CREATE TABLE IF NOT EXISTS persons (
  id              TEXT         PRIMARY KEY,
  client_number   VARCHAR(20)  NOT NULL,
  user_id         INTEGER      NOT NULL,
  display_name    VARCHAR(200) NOT NULL,
  canonical_name  VARCHAR(200),
  metadata        JSONB,
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS persons_user_canonical_idx
  ON persons(user_id, canonical_name);

CREATE INDEX IF NOT EXISTS persons_client_user_idx
  ON persons(client_number, user_id);

CREATE TABLE IF NOT EXISTS person_facets (
  id              TEXT         PRIMARY KEY,
  person_id       TEXT         NOT NULL,
  facet_type      VARCHAR(20)  NOT NULL,
  facet_value     VARCHAR(300) NOT NULL,
  verified        BOOLEAN      NOT NULL DEFAULT false,
  source          VARCHAR(20)  NOT NULL,
  confidence      DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  last_seen_at    TIMESTAMP,
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),

  CONSTRAINT person_facets_person_fk
    FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE CASCADE
);

-- Unique per Person per (type, value) — same email can't be attached
-- twice to the same Person. The same identifier CAN belong to
-- different Persons across users (per-user view of identity).
CREATE UNIQUE INDEX IF NOT EXISTS person_facets_person_type_value_uq
  ON person_facets(person_id, facet_type, facet_value);

-- Lookup index: "find person by identifier".
CREATE INDEX IF NOT EXISTS person_facets_type_value_idx
  ON person_facets(facet_type, facet_value);
