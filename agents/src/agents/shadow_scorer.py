"""Shadow Scorer — evaluates DRAFT/SHADOW rules against Golden Dataset."""
from __future__ import annotations

from typing import Any

import httpx
from google.adk.agents import Agent  # type: ignore[import-untyped]

from ..config import get_settings

_settings = get_settings()


async def evaluate_rule(client_number: str, rule_id: str) -> dict[str, Any]:
    """Trigger the platform's shadow evaluator for a single rule."""
    async with httpx.AsyncClient(
        base_url=_settings.platform_api_url,
        headers={"Authorization": f"Bearer {_settings.platform_api_token}", "X-Agent-Id": "shadow_scorer"},
    ) as cli:
        r = await cli.post(
            f"/api/v1/shadow/rules/{rule_id}/evaluate",
            headers={"X-Tenant-Id": client_number},
        )
        r.raise_for_status()
        return r.json()


async def evaluate_all_shadow(client_number: str) -> dict[str, Any]:
    async with httpx.AsyncClient(
        base_url=_settings.platform_api_url,
        headers={"Authorization": f"Bearer {_settings.platform_api_token}"},
    ) as cli:
        r = await cli.post("/api/v1/shadow/evaluate-all", headers={"X-Tenant-Id": client_number})
        r.raise_for_status()
        return r.json()


async def promote_rule(client_number: str, rule_id: str) -> dict[str, Any]:
    """Call the platform to promote a SHADOW → ACTIVE. Platform enforces the gate."""
    async with httpx.AsyncClient(
        base_url=_settings.platform_api_url,
        headers={"Authorization": f"Bearer {_settings.platform_api_token}", "X-Agent-Id": "shadow_scorer"},
    ) as cli:
        r = await cli.post(
            f"/api/v1/shadow/rules/{rule_id}/promote",
            headers={"X-Tenant-Id": client_number},
        )
        r.raise_for_status()
        return r.json()


SCORER_INSTRUCTIONS = """\
You are the Shadow Scorer. You evaluate rules that are in DRAFT or SHADOW state
against the tenant's Golden Dataset and, when gate criteria are met, promote
them to ACTIVE.

Policy:
1. Call `evaluate_all_shadow(client_number)` on a schedule (daily) — this runs
   every SHADOW rule against the golden set and writes scores.
2. For any rule with score ≥ tier threshold (LOW=0.95, MEDIUM=0.98, HIGH=manual)
   AND ≥ 30 days in SHADOW AND not frozen by drift guard, call `promote_rule`.
3. Do NOT attempt to promote HIGH-tier rules — they require manual certification
   from a SA/AD user.
"""


agent = Agent(
    model=_settings.gemini_flash_model,
    name="shadow_scorer",
    description="Evaluates SHADOW rules against Golden Dataset; promotes when gate passes.",
    instruction=SCORER_INSTRUCTIONS,
    tools=[evaluate_rule, evaluate_all_shadow, promote_rule],
)
