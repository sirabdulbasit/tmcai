-- MyOS — switch to new Google OAuth app.
--
-- Run after cowork delivers new CLIENT_ID + CLIENT_SECRET and you've updated
-- .env. Existing refresh tokens were issued by the OLD OAuth app and cannot
-- be refreshed by the NEW app, so we mark every Google-family user_connector
-- as 'disconnected' — next time a user opens Connectors, they click Configure
-- → Connect → new refresh token lands on the same row → status flips back to
-- 'connected'.
--
-- Nothing else is touched. feed_events, open_items, decision_logs, wiki,
-- shadow rules — all preserved.

BEGIN;

-- 1. Disconnect all google-family connectors tenant-wide.
UPDATE user_connectors uc
SET status = 'disconnected',
    error_message = 'OAuth app migration on 2026-04-21 — please reconnect',
    updated_at = NOW()
FROM connector_types ct
WHERE uc.connector_type_id = ct.id
  AND ct.slug IN (
    'gmail',
    'google_calendar',
    'google_tasks',
    'google_chat',
    'google_drive_personal',
    'google_sheets',
    'google_drive_org'
  )
  AND uc.status IN ('connected', 'configured', 'error');

-- 2. Clear the legacy users.integration_* slots too (they use the same OAuth
--    app for the legacy Gmail/Calendar sync path).
UPDATE users
SET integration_refresh_token = NULL,
    integration_access_token  = NULL,
    integration_status        = 'disconnected',
    integration_error         = 'OAuth app migration on 2026-04-21 — please reconnect',
    updated_at                = NOW()
WHERE integration_provider = 'google'
  AND integration_refresh_token IS NOT NULL;

-- 3. Report who's affected so we can tell them to reconnect.
SELECT u.email, u.client_number,
       (SELECT string_agg(ct.slug, ', ' ORDER BY ct.slug)
        FROM user_connectors uc
        JOIN connector_types ct ON ct.id = uc.connector_type_id
        WHERE uc.user_id = u.id
          AND uc.status = 'disconnected'
          AND uc.error_message LIKE '%OAuth app migration%') AS needs_reauth
FROM users u
WHERE u.integration_status = 'disconnected'
  AND u.integration_error LIKE '%OAuth app migration%';

COMMIT;
