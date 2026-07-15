-- Delegation matrix — per-tenant "who owns what".
--
-- HaseebOS v16 Director loads a 36-area / 31-email delegation matrix from a
-- secret into its system prompt every turn, so routing decisions are
-- deterministic lookups, not LLM inference. This table brings the same
-- discipline to MyOS as a per-tenant table editable by tenant admins.
--
-- This is COMPLEMENTARY to the existing per-user `brain_configs.delegation_rules`
-- JSON (which encodes type→assignee imperative rules). The matrix is a
-- knowledge map; the brain_configs rules are imperative actions. The two
-- compose in the Brain prompt: matrix tells WHO owns an area, rules tell
-- WHAT to do with specific item types.
--
-- Scope: each row is tenant-scoped (client_number). All users in the
-- tenant see the same matrix; only ADMIN/SA can mutate.

CREATE TABLE delegation_matrix (
    id                 SERIAL PRIMARY KEY,
    client_number      VARCHAR(20)  NOT NULL,
    area               VARCHAR(100) NOT NULL,
    owner_user_id      INTEGER      REFERENCES users(id) ON DELETE SET NULL,
    owner_name         VARCHAR(200) NOT NULL,
    owner_email        VARCHAR(200),
    owner_role         VARCHAR(100),
    escalate_to_name   VARCHAR(200),
    escalate_to_email  VARCHAR(200),
    notes              TEXT,
    effective_from     DATE,
    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id INTEGER      REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id INTEGER      REFERENCES users(id) ON DELETE SET NULL,

    -- One owner per area per tenant. Use deactivation (is_active=false) +
    -- a new row to preserve history of ownership changes.
    CONSTRAINT delegation_matrix_area_unique UNIQUE (client_number, area)
);

CREATE INDEX delegation_matrix_active_idx
  ON delegation_matrix (client_number, is_active);

CREATE INDEX delegation_matrix_owner_user_idx
  ON delegation_matrix (owner_user_id) WHERE owner_user_id IS NOT NULL;

-- Append-only audit of every change to the matrix. Lets the Brain explain
-- "who owned X on date Y" and supports compliance reviews.
CREATE TABLE delegation_matrix_history (
    id                 SERIAL PRIMARY KEY,
    client_number      VARCHAR(20)  NOT NULL,
    area               VARCHAR(100) NOT NULL,
    operation          VARCHAR(20)  NOT NULL, -- 'insert' | 'update' | 'deactivate' | 'delete'
    snapshot           JSONB        NOT NULL, -- full row at time of change
    changed_by_user_id INTEGER      REFERENCES users(id) ON DELETE SET NULL,
    changed_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX delegation_matrix_history_client_idx
  ON delegation_matrix_history (client_number, area, changed_at DESC);
