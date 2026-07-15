"""Triage Analyst — assigns archetypes + priority scores to Open Items."""
from __future__ import annotations

from typing import Any

from google.adk.agents import Agent  # type: ignore[import-untyped]

from ..config import get_settings
from ..platform_client import PlatformClient

_settings = get_settings()


ARCHETYPES = {"reply_needed", "delegate", "inform_only", "schedule_meeting", "review_risk", "acknowledge"}


async def assign_archetype(
    client_number: str,
    open_item_id: str,
    archetype: str,
    priority_score: float,
    reasoning: str,
) -> dict[str, Any]:
    """Set archetype + priority_score on an OpenItem."""
    if archetype not in ARCHETYPES:
        return {"error": f"unknown archetype '{archetype}'; allowed: {sorted(ARCHETYPES)}"}
    p = PlatformClient()
    try:
        out = await p.update_open_item(
            client_number,
            open_item_id,
            {"archetype": archetype, "priorityScore": priority_score, "enrichmentData": {"triageReasoning": reasoning}},
        )
        return {"openItemId": out.get("id"), "archetype": archetype, "priorityScore": priority_score}
    finally:
        await p.close()


async def suggest_action(
    client_number: str,
    user_id: int,
    open_item_id: str,
    suggested_action: str,
    rationale: str,
    confidence: float,
) -> dict[str, Any]:
    """Log a suggested action into DecisionLog (no execute here — that's Action Executor's job)."""
    p = PlatformClient()
    try:
        return await p.record_decision(
            {
                "clientNumber": client_number,
                "userId": user_id,
                "sessionType": "intraday",
                "itemType": "triage",
                "openItemId": open_item_id,
                "suggestedAction": suggested_action,
                "userDecision": "approved",  # provisional — user confirms later
                "isMatch": False,
                "inputSummary": rationale,
                "confidenceScore": confidence,
                "agentId": "triage_analyst",
            }
        )
    finally:
        await p.close()


TRIAGE_INSTRUCTIONS = """\
You are the Triage Analyst. For each scored OpenItem:

1. Read title, description, entity, source.
2. Assign one of 6 archetypes:
   - reply_needed   (user must send a response)
   - delegate       (route to a team member)
   - inform_only    (no response needed, just awareness)
   - schedule_meeting (calendar coordination needed)
   - review_risk    (compliance/financial/legal flag)
   - acknowledge    (low-priority FYI)
3. Compute a priority score in [0.0, 1.0] weighted by:
   - entity importance (VIP contacts, key clients → +0.3)
   - urgency (deadline/dependency → +0.2)
   - financial value ($10K+ → +0.2)
   - sender seniority / repeat-offender pattern → +0.1
   - age / escalation status → +0.1
   Clamp to [0, 1].
4. Call `assign_archetype` to persist.
5. Optionally call `suggest_action` with the recommended next step + confidence.

Never execute actions. Never modify anything besides archetype + priorityScore + enrichment_data.
"""


agent = Agent(
    model=_settings.gemini_flash_model,
    name="triage_analyst",
    description="Assigns archetype + priorityScore to OpenItems; suggests next actions.",
    instruction=TRIAGE_INSTRUCTIONS,
    tools=[assign_archetype, suggest_action],
)
