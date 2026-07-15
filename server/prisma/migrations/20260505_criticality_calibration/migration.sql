-- ============================================================
-- 20260505_criticality_calibration
--
-- The criticality calibration service (services/triage/
-- criticalityCalibrationService.ts) has always read/written this table,
-- but no migration existed for it. The local dev DB had it from an
-- ad-hoc CREATE; production never did. After Phase A wired the
-- feedback diagnosis loop into the service, every 👎 produced a
-- silently-failed UPDATE on production.
--
-- This migration creates the table to match the service's INSERT shape
-- exactly. Idempotent — safe to re-run.
--
-- The table holds per-(tenant, user) signal weights and a global
-- threshold shift that the criticality engine reads via
-- getEffectiveCriticalThreshold(). thresholdShift drifts in
-- [-0.2, +0.2] from 👍/👎 diagnoses with categories
-- over_flagged_critical / under_flagged_critical / irrelevant.
-- ============================================================

CREATE TABLE IF NOT EXISTS criticality_calibration (
  client_number          VARCHAR(20)  NOT NULL,
  user_id                INTEGER      NOT NULL,
  time_pressure_w        REAL         NOT NULL DEFAULT 1.0,
  impact_w               REAL         NOT NULL DEFAULT 1.0,
  relationship_risk_w    REAL         NOT NULL DEFAULT 1.0,
  cascade_w              REAL         NOT NULL DEFAULT 1.0,
  pattern_anomaly_w      REAL         NOT NULL DEFAULT 1.0,
  global_threshold_shift REAL         NOT NULL DEFAULT 0.0,
  sample_count           INTEGER      NOT NULL DEFAULT 0,
  last_diagnosis_at      TIMESTAMP,
  last_diagnosis_id      TEXT,
  updated_at             TIMESTAMP    NOT NULL DEFAULT now(),
  PRIMARY KEY (client_number, user_id)
);
