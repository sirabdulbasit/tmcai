-- Nexeo — Self-Learning Phase 2 (Gap Detection + Product Proposals + Dev Requests)
--
-- Per nexeo_self_learning&development.md §7.4-7.6. Three tables that
-- turn accumulated Phase 1 learning data into actionable product
-- improvement proposals and dev requests — each gated by human
-- approval at every transition.
--
-- Flow:
--   Phase 1 data (logs, feedback, memories)
--     ↓ Gap Detection Job
--   brain_detected_gaps (new)
--     ↓ admin approves
--   brain_product_proposals (draft → awaiting_approval → approved)
--     ↓ admin approves
--   brain_development_requests (draft → coding_in_progress → pr_created → deployed)
--
-- Hard governance rule: Brain can author rows in any of these tables,
-- but no row transitions to a "shipping" state without an admin's
-- explicit click. Status fields are constrained at the app level
-- (no DB CHECK to keep migrations frictionless).

-- ─── Table 4 — brain_detected_gaps ───────────────────────────────
-- Detected by the gap detection job (runs nightly in Session 4).
-- Examples: repeated user prompts unanswered, parity mismatches,
-- frequent connector token expiries, missed important emails.

CREATE TABLE IF NOT EXISTS brain_detected_gaps (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  client_number   VARCHAR(20) NOT NULL,
  user_id         INTEGER,
    -- NULL = tenant-wide gap; otherwise user-scoped
  gap_type        VARCHAR(100) NOT NULL,
    -- 'missing_feature' | 'workflow_automation' | 'triage_quality' |
    -- 'day_brief_quality' | 'connector_issue' | 'whatsapp_issue' |
    -- 'open_item_issue' | 'knowledge_gap' | 'parity_issue' |
    -- 'security_issue' | 'privacy_issue' | 'ux_improvement' |
    -- 'product_performance' | 'language_tone_issue' |
    -- 'alert_quality_issue' | 'follow_up_quality_issue' |
    -- 'delegation_issue' | 'calendar_conflict_issue' |
    -- 'contact_resolution_issue'
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  evidence        JSONB NOT NULL,
    -- {interactionIds: [...], feedbackIds: [...], counts: {...},
    --  sample_prompts: [...], example_failures: [...]}
  affected_surfaces TEXT[],
  affected_connectors TEXT[],
  affected_roles    TEXT[],
  frequency_count INTEGER DEFAULT 0,
  business_impact VARCHAR(50),
    -- 'low' | 'medium' | 'high' | 'critical'
  risk_level      VARCHAR(50),
  brain_confidence NUMERIC(5,2),
  suggested_action TEXT,
  status          VARCHAR(50) DEFAULT 'new',
    -- 'new' | 'under_review' | 'approved' | 'rejected' |
    -- 'converted_to_proposal' | 'implemented'
  reviewed_by     INTEGER,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brain_gaps_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT brain_gaps_tenant_fk
    FOREIGN KEY (client_number) REFERENCES tenants(client_number) ON DELETE CASCADE,
  CONSTRAINT brain_gaps_reviewer_fk
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_brain_gaps_open
  ON brain_detected_gaps (client_number, status, gap_type, created_at DESC)
  WHERE status IN ('new', 'under_review');
CREATE INDEX idx_brain_gaps_recent
  ON brain_detected_gaps (client_number, created_at DESC);

-- ─── Table 5 — brain_product_proposals ───────────────────────────
-- Promoted from an approved gap by the Product Manager Agent.
-- Includes user stories, acceptance criteria, risk + impact.

CREATE TABLE IF NOT EXISTS brain_product_proposals (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  client_number   VARCHAR(20) NOT NULL,
  user_id         INTEGER,
  gap_id          TEXT,
  title           TEXT NOT NULL,
  problem_statement TEXT NOT NULL,
  business_impact TEXT,
  user_impact     TEXT,
  affected_surfaces TEXT[],
  affected_connectors TEXT[],
  affected_services TEXT[],
  proposal_markdown TEXT NOT NULL,
    -- Full structured proposal: user stories, acceptance criteria,
    -- data requirements, privacy/security notes
  risk_level      VARCHAR(50) DEFAULT 'medium',
  priority        VARCHAR(50) DEFAULT 'medium',
  estimated_complexity VARCHAR(50) DEFAULT 'medium',
  status          VARCHAR(50) DEFAULT 'draft',
    -- 'draft' | 'awaiting_approval' | 'approved' | 'rejected' |
    -- 'converted_to_development'
  created_by_brain BOOLEAN DEFAULT TRUE,
  approved_by     INTEGER,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brain_proposals_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT brain_proposals_tenant_fk
    FOREIGN KEY (client_number) REFERENCES tenants(client_number) ON DELETE CASCADE,
  CONSTRAINT brain_proposals_gap_fk
    FOREIGN KEY (gap_id) REFERENCES brain_detected_gaps(id) ON DELETE SET NULL,
  CONSTRAINT brain_proposals_approver_fk
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_brain_proposals_status
  ON brain_product_proposals (client_number, status, created_at DESC);

-- ─── Table 6 — brain_development_requests ────────────────────────
-- Promoted from an approved proposal. Carries the technical spec,
-- target repo/branch, PR URL once the Developer Agent creates it,
-- test + security review status. Brain can author + draft these
-- but cannot deploy — every transition past pr_created requires
-- human approval.

CREATE TABLE IF NOT EXISTS brain_development_requests (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  client_number   VARCHAR(20) NOT NULL,
  user_id         INTEGER,
  gap_id          TEXT,
  proposal_id     TEXT,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  requirement_markdown TEXT NOT NULL,
  technical_spec_markdown TEXT,
  target_repository TEXT,
  target_branch   TEXT,
  generated_branch TEXT,
  pull_request_url TEXT,
  test_status     VARCHAR(50) DEFAULT 'not_started',
    -- 'not_started' | 'in_progress' | 'passing' | 'failing'
  security_status VARCHAR(50) DEFAULT 'not_started',
    -- 'not_started' | 'in_progress' | 'passed' | 'concerns_raised' |
    -- 'blocked'
  status          VARCHAR(50) DEFAULT 'draft',
    -- 'draft' | 'awaiting_approval' | 'approved_for_development' |
    -- 'coding_in_progress' | 'pr_created' | 'review_required' |
    -- 'uat_required' | 'approved_for_release' | 'deployed' |
    -- 'rejected'
  risk_level      VARCHAR(50) DEFAULT 'high',
    -- defaults to 'high' — code changes always need scrutiny
  requested_by    INTEGER,
  approved_by     INTEGER,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brain_devreqs_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT brain_devreqs_tenant_fk
    FOREIGN KEY (client_number) REFERENCES tenants(client_number) ON DELETE CASCADE,
  CONSTRAINT brain_devreqs_gap_fk
    FOREIGN KEY (gap_id) REFERENCES brain_detected_gaps(id) ON DELETE SET NULL,
  CONSTRAINT brain_devreqs_proposal_fk
    FOREIGN KEY (proposal_id) REFERENCES brain_product_proposals(id) ON DELETE SET NULL,
  CONSTRAINT brain_devreqs_requester_fk
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT brain_devreqs_approver_fk
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_brain_devreqs_status
  ON brain_development_requests (client_number, status, created_at DESC);
