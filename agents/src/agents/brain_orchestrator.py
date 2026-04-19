"""Brain Orchestrator — root agent running on Gemini Pro.

Receives a user-facing or system-triggered intent and delegates to workers via
ADK's `transfer_to_agent()` mechanism.
"""
from __future__ import annotations

from typing import Any

from google.adk.agents import Agent  # type: ignore[import-untyped]

from ..config import get_settings
from ..platform_client import PlatformClient
from ..brain.inference import ALL_BRAIN_TOOLS
from .feed_curator import agent as feed_curator
from .triage_analyst import agent as triage_analyst
from .action_executor import agent as action_executor
from .reflection_agent import agent as reflection_agent
from .steering_analyst import agent as steering_analyst
from .external_knowledge import agent as external_knowledge
from .shadow_scorer import agent as shadow_scorer

_settings = get_settings()


# ─── Brain-only tools ───────────────────────────────────────────────
async def current_time() -> dict[str, Any]:
    """Get the current UTC and PKT time."""
    from datetime import datetime, timezone, timedelta

    now_utc = datetime.now(timezone.utc)
    pkt = now_utc.astimezone(timezone(timedelta(hours=5)))
    return {"utc": now_utc.isoformat(), "pkt": pkt.isoformat()}


async def kill_switch_check(client_number: str) -> dict[str, Any]:
    """Check whether the kill switch is engaged for a tenant before dispatching."""
    p = PlatformClient()
    try:
        active = await p.kill_switch_active(client_number)
        return {"active": active, "tenantId": client_number}
    finally:
        await p.close()


BRAIN_INSTRUCTIONS = """\
You are the Brain Orchestrator for HaseebOS v15. Your role is supervisor over six
worker agents. You do NOT execute tools yourself (beyond current_time and
kill_switch_check); instead you delegate by calling `transfer_to_agent()` with
the worker's name.

Decision policy:
1. Always call `kill_switch_check(client_number)` first. If active, refuse and
   return a clear message.
2. If the event is a raw feed item from Gmail/WhatsApp/Chat/Calendar/Tasks →
   transfer_to_agent("feed_curator").
3. If the event is a scored open item needing archetype assignment + priority →
   transfer_to_agent("triage_analyst").
4. If the user or another agent has approved a specific action (draft email,
   reschedule, etc.) → transfer_to_agent("action_executor").
5. For weekly reviews or pattern synthesis → transfer_to_agent("reflection_agent").
6. For KPI snapshots / anomaly alerts → transfer_to_agent("steering_analyst").
7. For external knowledge queries (TMC Context, KNOW) → transfer_to_agent("external_knowledge").
8. For rule scoring / Shadowing evaluation → transfer_to_agent("shadow_scorer").

Always include the trace_id from the incoming event attributes so every
downstream agent records the same trace in DecisionLog.
"""


agent = Agent(
    model=_settings.gemini_pro_model,
    name="brain_orchestrator",
    description="Supervisor agent — routes events to the 6 worker agents.",
    instruction=BRAIN_INSTRUCTIONS,
    # L5.9 — 14-tool Brain surface (current_time + kill_switch_check are included)
    tools=ALL_BRAIN_TOOLS,
    sub_agents=[
        feed_curator,
        triage_analyst,
        action_executor,
        reflection_agent,
        steering_analyst,
        external_knowledge,
        shadow_scorer,
    ],
)
