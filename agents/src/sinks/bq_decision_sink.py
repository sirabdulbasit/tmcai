"""HaseebOS v15 L5.4 — BigQuery sink for decision_logs.

Streams every `decision-recorded` Pub/Sub message into
`tmcai_decisions.decision_archive`. The table is append-only and acts as the
permanent audit trail that Reflection / Rule Miner train against.

Local-dev fallback: if BigQuery creds are not available (no GOOGLE_APPLICATION_CREDENTIALS,
no `tmcai-key.json`, or running against Pub/Sub emulator) the sink logs the row
and returns. This mirrors pubsubPublisher's emulator short-circuit on the
Node side.
"""
from __future__ import annotations

import logging
import os
from typing import Any

log = logging.getLogger(__name__)

_DATASET = os.environ.get("BQ_DECISIONS_DATASET", "tmcai_decisions")
_TABLE = os.environ.get("BQ_DECISIONS_TABLE", "decision_archive")


def _bq_available() -> bool:
    if os.environ.get("PUBSUB_EMULATOR_HOST"):
        # Full local dev: emulator implies no real GCP creds configured.
        return False
    if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        return True
    # Cloud Run default SA
    if os.environ.get("K_SERVICE") or os.environ.get("GOOGLE_CLOUD_PROJECT"):
        return True
    return False


async def insert_decision(tenant_id: str | None, payload: dict[str, Any]) -> None:
    """Stream a single decision row into BQ. Best-effort — logs on failure."""
    row = _to_row(tenant_id, payload)
    if not _bq_available():
        log.info("[bq_sink] local mode — skipping BQ insert: %s", row.get("decision_id"))
        return

    try:
        # Import lazily so the rest of the agent still boots if bigquery deps
        # are missing in a dev container.
        from google.cloud import bigquery  # type: ignore[import-untyped]

        client = bigquery.Client()
        table_ref = f"{client.project}.{_DATASET}.{_TABLE}"
        errors = client.insert_rows_json(table_ref, [row])
        if errors:
            log.error("[bq_sink] insert errors: %s", errors)
            raise RuntimeError(f"bigquery insert errors: {errors}")
        log.info("[bq_sink] archived decision %s -> %s", row.get("decision_id"), table_ref)
    except Exception as e:  # noqa: BLE001
        log.exception("[bq_sink] insert failed: %s", e)
        raise


def _to_row(tenant_id: str | None, payload: dict[str, Any]) -> dict[str, Any]:
    # Canonical schema for tmcai_decisions.decision_archive (schema DDL shipped
    # in migrations/bigquery/decision_archive.sql). Keep keys snake_case and
    # primitive-only so BQ streaming insert is happy.
    return {
        "tenant_id": tenant_id,
        "decision_id": payload.get("decisionId"),
        "trace_id": payload.get("traceId"),
        "agent_name": payload.get("agentName"),
        "decision_type": payload.get("decisionType"),
        "input_summary": payload.get("inputSummary"),
        "output_summary": payload.get("outputSummary"),
        "risk_tier": payload.get("riskTier"),
        "action_id": payload.get("actionId"),
        "open_item_id": payload.get("openItemId"),
        "feed_event_id": payload.get("feedEventId"),
        "entity_id": payload.get("entityId"),
        "outcome": payload.get("outcome"),
        "reason": payload.get("reason"),
        "rule_version": payload.get("ruleVersion"),
        "shadow_mode": payload.get("shadowMode"),
        "recorded_at": payload.get("recordedAt"),
    }
