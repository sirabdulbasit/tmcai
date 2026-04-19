"""FastAPI entrypoint for the agent worker.

Serves Pub/Sub push endpoints + health + an admin endpoint to trigger a manual
Brain invocation (for testing from the Steering Wheel UI or curl).
"""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .config import get_settings

# Promote settings to env vars that third-party SDKs read directly.
# pydantic-settings loads .env into Settings, but google-genai + google-adk
# read os.environ. Bridge the two so loading .env is enough for all SDKs.
_s = get_settings()
if _s.gemini_api_key and not os.environ.get("GEMINI_API_KEY"):
    os.environ["GEMINI_API_KEY"] = _s.gemini_api_key
if _s.gemini_api_key and not os.environ.get("GOOGLE_API_KEY"):
    os.environ["GOOGLE_API_KEY"] = _s.gemini_api_key

from .pubsub_handlers import router as pubsub_router, _run_brain  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s %(message)s")

app = FastAPI(title="TMCAI Agent Worker", version="0.1.0")
app.include_router(pubsub_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "tmcai-agents"}


@app.get("/config")
async def config() -> dict[str, object]:
    s = get_settings()
    # Never expose tokens in this endpoint — only names/ids.
    return {
        "gcp_project_id": s.gcp_project_id,
        "gcp_location": s.gcp_location,
        "gemini_pro": s.gemini_pro_model,
        "gemini_flash": s.gemini_flash_model,
        "topics": {
            "feed_raw": s.topic_feed_raw,
            "openitems_scored": s.topic_openitems_scored,
            "actions_approved": s.topic_actions_approved,
            "steering_snapshot": s.topic_steering_snapshot,
        },
    }


class ManualRunBody(BaseModel):
    tenant_id: str
    prompt: str


@app.post("/admin/run-brain")
async def admin_run_brain(body: ManualRunBody) -> dict[str, str]:
    """Manual Brain invocation — only protect via Cloud Run IAM."""
    try:
        result = await _run_brain(body.prompt, session_user=f"admin:{body.tenant_id}")
        return {"result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


class MineRulesBody(BaseModel):
    tenant_id: str | None = None


@app.post("/admin/mine-rules")
async def admin_mine_rules(body: MineRulesBody | None = None) -> dict[str, object]:
    """HaseebOS v15 L5.8 — nightly rule miner entrypoint.

    Target of the `tmcai-rule-miner-nightly` Cloud Scheduler job (02:00 UTC).
    Scans the BigQuery `decision_training` view and returns proposed DRAFT
    rules. Protected by Cloud Run IAM (OIDC token from the scheduler SA).
    """
    from .brain.learning import mine_rules

    tenant_id = (body.tenant_id if body else None) or None
    try:
        drafts = await mine_rules(tenant_id)
        return {"ok": True, "tenantId": tenant_id, "draftCount": len(drafts), "drafts": drafts}
    except Exception as e:
        logging.getLogger(__name__).exception("[admin/mine-rules] failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e
