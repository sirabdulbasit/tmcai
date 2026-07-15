"""Reflection Agent — nightly pattern analysis, proposes DRAFT rules."""
from __future__ import annotations

from typing import Any

from google.adk.agents import Agent  # type: ignore[import-untyped]

from ..config import get_settings
from ..platform_client import PlatformClient

_settings = get_settings()


async def propose_draft_rule(
    client_number: str,
    rule_name: str,
    rule_spec: dict[str, Any],
    risk_tier: str,
    rationale: str,
) -> dict[str, Any]:
    """Create a DRAFT rule in rule_lifecycle via the platform. Shadow Scorer picks it up."""
    import httpx

    s = get_settings()
    async with httpx.AsyncClient(
        base_url=s.platform_api_url,
        headers={"Authorization": f"Bearer {s.platform_api_token}", "X-Agent-Id": "reflection_agent"},
    ) as cli:
        r = await cli.post(
            "/api/v1/shadow/rules",
            json={
                "clientNumber": client_number,
                "ruleName": rule_name,
                "ruleSpec": {**rule_spec, "rationale": rationale},
                "riskTier": risk_tier,
            },
        )
        r.raise_for_status()
        return r.json()


async def create_thought(
    client_number: str,
    user_id: int,
    title: str,
    content: str,
    thought_type: str = "pattern_insight",
) -> dict[str, Any]:
    """Write a ThoughtEntry — the Thought Pipeline renders these in the UI."""
    p = PlatformClient()
    try:
        return await p.execute_action(
            client_number=client_number,
            user_id=user_id,
            action_type="extract_insight",
            payload={"title": title, "content": content, "target": "thought_entry"},
            executed_by_agent="reflection_agent",
        )
    finally:
        await p.close()


REFLECTION_INSTRUCTIONS = """\
You are the Reflection Agent. You run nightly and look for patterns in the
tenant's DecisionLog + actions over the past 7/30 days.

Your outputs:
1. `create_thought` — surface a pattern insight to Abdul (e.g. "You consistently
   approve invoice-reminder emails from vendor X — consider a DRAFT rule.")
2. `propose_draft_rule` — formal rule proposal that enters DRAFT state. The
   Shadow Scorer will then evaluate it over 30 days before it can promote to
   ACTIVE.

Don't create rules without supporting evidence: require ≥10 matching decisions
over ≥14 days before proposing.
"""


agent = Agent(
    model=_settings.gemini_flash_model,
    name="reflection_agent",
    description="Nightly pattern analysis; proposes DRAFT rules + ThoughtEntries.",
    instruction=REFLECTION_INSTRUCTIONS,
    tools=[propose_draft_rule, create_thought],
)
