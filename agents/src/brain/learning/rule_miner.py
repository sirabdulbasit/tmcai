"""HaseebOS v15 L5.8 — Nightly rule miner.

Reads the curated `tmcai_decisions.decision_training` BigQuery view, clusters
inputs by (agent, decision_type, entity_type, outcome), and proposes a DRAFT
rule for each cluster that has enough evidence and high label agreement.

Run nightly via Cloud Scheduler → Cloud Run Job (GCP side) or via a simple
setInterval on the agent worker for local dev.

In local dev without BigQuery, the miner logs a warning and exits cleanly.
"""
from __future__ import annotations

import logging
import os
from typing import Any

log = logging.getLogger(__name__)


def _bq_available() -> bool:
    if os.environ.get("PUBSUB_EMULATOR_HOST"):
        return False
    if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        return True
    if os.environ.get("K_SERVICE") or os.environ.get("GOOGLE_CLOUD_PROJECT"):
        return True
    return False


MIN_EVIDENCE = 10  # at least 10 decisions before we propose a rule
MIN_AGREEMENT = 0.8  # >= 80% of those decisions agree on the label


async def mine_rules(client_number: str | None = None) -> list[dict[str, Any]]:
    """Return the list of proposed DRAFT rules. Caller is responsible for
    persisting them via the platform /api/v1/shadow/rules endpoint."""
    if not _bq_available():
        log.warning("[rule_miner] BigQuery not configured — skipping nightly run")
        return []

    try:
        from google.cloud import bigquery  # type: ignore[import-untyped]
    except Exception:  # noqa: BLE001
        log.warning("[rule_miner] google-cloud-bigquery missing — skipping")
        return []

    client = bigquery.Client()
    where = "1=1"
    params: list = []
    if client_number:
        where = "tenant_id = @tenant_id"
        params.append(bigquery.ScalarQueryParameter("tenant_id", "STRING", client_number))

    sql = f"""
    WITH clusters AS (
      SELECT
        tenant_id,
        agent_name,
        decision_type,
        COUNT(*) AS evidence,
        SUM(CASE WHEN label = 'confirmed' THEN 1 ELSE 0 END) AS confirms,
        SUM(CASE WHEN label = 'overridden' THEN 1 ELSE 0 END) AS overrides
      FROM `tmcai_decisions.decision_training`
      WHERE {where}
        AND shadow_mode IN ('SHADOW','ACTIVE')
        AND recorded_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
      GROUP BY tenant_id, agent_name, decision_type
    )
    SELECT *,
      SAFE_DIVIDE(confirms, confirms + overrides) AS agreement
    FROM clusters
    WHERE confirms + overrides >= @min_ev
    """
    params.append(bigquery.ScalarQueryParameter("min_ev", "INT64", MIN_EVIDENCE))
    job = client.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params))
    rows = list(job.result())

    drafts: list[dict[str, Any]] = []
    for r in rows:
        agreement = r.get("agreement") or 0.0
        if agreement < MIN_AGREEMENT:
            continue
        drafts.append({
            "tenantId": r["tenant_id"],
            "agentName": r["agent_name"],
            "decisionType": r["decision_type"],
            "confirms": r["confirms"],
            "overrides": r["overrides"],
            "evidence": r["evidence"],
            "agreement": float(agreement),
            "proposedMode": "DRAFT",
            "description": f"Auto-draft from {r['evidence']} training rows ({int(agreement*100)}% agreement)",
        })

    log.info("[rule_miner] proposed %d DRAFT rules", len(drafts))
    return drafts
