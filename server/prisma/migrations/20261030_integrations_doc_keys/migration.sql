-- DEF-367 — Integrations: keep the keys the API document printed, encrypted, so
-- the Connect test can try them and keep the one that works (vm
-- integrationDocReader pickWorkingSecret). Hand-written, idempotent, additive.
--
--   * api_doc_keys_enc holds ciphertext only: 'v1:<iv>:<tag>:<ct>' of a JSON
--     array of strings, AES-256-GCM, store/secretStore.ts — the same envelope as
--     secret_enc. The CHECK refuses anything that is not that envelope, so a
--     plaintext key can never be written here by any code path.
--   * Written when a document is attached (replaced with each new document);
--     read only by sources/docKeys.ts. Never returned by the API.

ALTER TABLE integration_syncs ADD COLUMN IF NOT EXISTS api_doc_keys_enc TEXT;

DO $$ BEGIN
  ALTER TABLE integration_syncs ADD CONSTRAINT integration_syncs_doc_keys_check
    CHECK (api_doc_keys_enc IS NULL OR api_doc_keys_enc LIKE 'v1:%');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
