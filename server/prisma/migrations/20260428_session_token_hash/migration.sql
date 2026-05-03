-- C2: Hash session tokens at rest.
--
-- Previously the `sessions.token` column stored the raw bearer token. A
-- read-only DB leak would have handed an attacker live, valid sessions.
-- We now store the SHA-256 hash of the token; the raw token is only
-- returned to the client at issue time and never persisted.
--
-- Migration strategy:
--   1) add nullable token_hash column + index
--   2) backfill: hash each existing token in-place (encode(digest(token,'sha256'),'hex'))
--   3) make token_hash NOT NULL UNIQUE
--   4) drop token column (after backfill — no live sessions are invalidated)

-- Requires pgcrypto for digest(); no-op if already enabled.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_hash VARCHAR(64);

UPDATE sessions
SET token_hash = encode(digest(token, 'sha256'), 'hex')
WHERE token_hash IS NULL AND token IS NOT NULL;

-- Any rows with NULL token (shouldn't exist, but be defensive) get revoked
-- so they cannot validate.
UPDATE sessions
SET is_revoked = TRUE
WHERE token_hash IS NULL;

-- token_hash must be unique to enable lookups; revoked stub rows above
-- have NULL hash so we make the column NOT NULL only after dropping them.
DELETE FROM sessions WHERE token_hash IS NULL;

ALTER TABLE sessions ALTER COLUMN token_hash SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_key ON sessions(token_hash);

-- Drop the legacy plaintext column + its unique index.
ALTER TABLE sessions DROP COLUMN IF EXISTS token;
