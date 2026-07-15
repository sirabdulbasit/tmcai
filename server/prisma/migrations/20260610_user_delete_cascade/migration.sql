-- MyOS / Nexeo — make user-owned tables cascade on user delete.
--
-- Per Basit 2026-06-10: admin Delete User was failing with
-- "Foreign key constraint violated on the constraint: `sessions_user_id_fkey`"
-- because 3 user-owned tables still had ON DELETE RESTRICT (the default
-- when a prior migration didn't specify) instead of CASCADE.
--
-- Audit table (audit_log) intentionally stays SET NULL — we keep the
-- audit row for compliance but nullify the user reference so deletion
-- doesn't destroy the history of what they did.
--
-- Three tables converted to CASCADE so user.delete() can complete:
--   sessions        — active login sessions
--   conversations   — chat conversations (messages cascade via conv FK)
--   scheduled_tasks — scheduler entries the user owns
--
-- Strategy: drop the existing FK and re-add with ON DELETE CASCADE.
-- Each ALTER is wrapped in BEGIN/COMMIT-equivalent (Postgres DDL is
-- transactional inside a migration block automatically).

ALTER TABLE sessions
  DROP CONSTRAINT sessions_user_id_fkey,
  ADD CONSTRAINT sessions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE conversations
  DROP CONSTRAINT conversations_user_id_fkey,
  ADD CONSTRAINT conversations_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE scheduled_tasks
  DROP CONSTRAINT scheduled_tasks_user_id_fkey,
  ADD CONSTRAINT scheduled_tasks_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
