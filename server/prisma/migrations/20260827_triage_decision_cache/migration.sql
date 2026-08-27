-- OPT-004 — stop re-reasoning email that has not changed.
--
-- Measured 2026-08-27, for ONE user (TMC-0001):
--
--   purpose=triage   08-19  2,439 calls  10.9M in   $15.23
--                    08-20  3,727 calls  16.6M in   $23.26
--                    08-21  2,981 calls  13.3M in   $18.73
--                    08-27  1,261 calls   ...       $ 8.08 (partial day)
--
-- against a feed of 4,877 events in total that grows by roughly 42/day. Triage
-- was making ~60 LLM calls per new event per day. All-time, `triage` is
-- 487,178 calls and $1,759.67 — 82% of every dollar this system has spent on
-- inference.
--
-- The cache existed. It was an in-process Map with a 1-hour TTL
-- (`triageReasoner.ts`), which fails twice over: it dies on every pm2 restart,
-- and a 1-hour TTL re-reasons an unchanged May email every hour it is looked
-- at, forever. Nothing about that email changes hourly.
--
-- This is the same problem, and the same fix, as OPT-003 (`criticality_fuse`,
-- 2026-08-08). That one went from 17,087 calls/day to ~130/day; its table today
-- holds 3,699 entries that have served 160,241 hits — 97.7% hit rate. The
-- design here is copied on purpose rather than reinvented.
--
-- The key is the PROMPT, not the event. `buildUserPrompt(ctx)` is the exact
-- string the model sees, so identical bytes mean identical inputs and the same
-- answer. A triage decision SHOULD move when its inputs move — a new reply on
-- the thread, a related open item closing, the user deciding something about
-- this sender — and each of those changes the prompt, so it misses the cache by
-- construction. Keying on feed_event_id would have frozen a judgement that
-- ought to change.
--
-- user_id is inside the hash as well as client_number. The OPT-003 precedent
-- scopes by tenant alone; a triage decision names people and drafts replies to
-- them, so sharing one between two users of a tenant is not a risk worth taking
-- for a saving it does not produce.

CREATE TABLE IF NOT EXISTS triage_decision_cache (
  -- sha256 of (prompt_version || client_number || user_id || user_prompt).
  cache_key      CHAR(64)     PRIMARY KEY,
  client_number  VARCHAR(20)  NOT NULL,
  user_id        INTEGER      NOT NULL,
  -- NOT part of the key. Carried so that an explicit invalidation on a pattern
  -- (briefRoutes, when the user acts on a card) is an indexed delete instead of
  -- a scan of the whole table.
  dedup_hash     VARCHAR(80)  NOT NULL,
  -- Bumped whenever the triage system prompt or the decision schema changes.
  -- Without it a prompt improvement would be silently undone by answers cached
  -- from before the change.
  prompt_version VARCHAR(16)  NOT NULL,
  -- The full ReasonerDecision: archetype, rationale, suggestedAction,
  -- confidence, actions, critical, noise, meetingIntent.
  decision       JSONB        NOT NULL,
  hits           INTEGER      NOT NULL DEFAULT 0,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_hit_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Invalidation by pattern.
CREATE INDEX IF NOT EXISTS triage_decision_cache_dedup_ix
  ON triage_decision_cache (dedup_hash);

-- Eviction sweep: oldest-first within a tenant.
CREATE INDEX IF NOT EXISTS triage_decision_cache_age_ix
  ON triage_decision_cache (client_number, created_at);

-- Deliberately NO index on last_hit_at or hits. Both are written on every cache
-- hit and read only by a human curious about the hit rate. Indexing them would
-- reintroduce precisely the write amplification this table exists to remove
-- (OPT-001: 791 MB of indexes on llm_spend that the planner never once chose).

-- ── Attribution ───────────────────────────────────────────────────────────
--
-- `llm_spend.feed_event_id` has existed since the table was created and was
-- NULL on all 2,608,563 rows: every call site passed `purpose` and none passed
-- the event. So spend could be grouped by purpose but never traced to a source
-- event, and "this change removed N calls for event X" was unprovable.
--
-- This needs NO DDL: the column already exists and the call sites now populate
-- it (llmRouter, llmSpendService, triageReasoner, criticalityEngineService).
--
-- An index on `llm_spend (feed_event_id)` was written here and then deliberately
-- removed, for two reasons:
--
--   1. Building it takes an ACCESS EXCLUSIVE lock on a 2.6M-row table that every
--      LLM call inserts into. Locking llm_spend stalls Brain. OPT-001 used
--      DROP INDEX CONCURRENTLY for exactly this reason, and CREATE INDEX
--      CONCURRENTLY cannot run inside the transaction a migration executes in.
--   2. The only reader is a human running a verification query a handful of
--      times. A seq scan is fine for that. An index nobody queries, on the
--      hottest-insert table in the database, is precisely the mistake OPT-001
--      cleaned up — 791 MB of indexes the planner never once chose.
--
-- If per-event spend ever becomes a dashboard view rather than a check, add it
-- then, CONCURRENTLY, outside a migration.
