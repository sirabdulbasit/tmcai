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
from .wiki_scribe import agent as wiki_scribe

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
You are the Brain Orchestrator for MyOS. Your role is supervisor over seven
worker agents. You do NOT execute tools yourself (beyond current_time,
kill_switch_check, and the wiki lookup tools); instead you delegate by calling
`transfer_to_agent()` with the worker's name.

Decision policy:
1. Always call `kill_switch_check(client_number)` first. If active, refuse and
   return a clear message.
2. For any KNOWLEDGE QUESTION from a user (anything asking what we know,
   what happened, who said what, what's the status of X), ALWAYS call
   `query_wiki_index(client_number, user_id, question)` FIRST — the user's
   personal wiki likely has a pre-synthesized answer. Read the top 2-3 pages
   via `read_wiki_page`. If the wiki gives you a direct answer, return it
   citing the page titles. Only fall back to raw retrieval (external_knowledge
   or entity graph) if the wiki coverage is insufficient.
3. If the event is a raw feed item from Gmail/WhatsApp/Chat/Slack/CRM/Calendar/Tasks →
   transfer_to_agent("feed_curator").
4. If the event is an OpenItem transitioning to CLOSED →
   transfer_to_agent("wiki_scribe") to ingest the close into the user's wiki.
5. If the event is a scored open item needing archetype assignment + priority →
   transfer_to_agent("triage_analyst").
6. If the user or another agent has approved a specific action (draft email,
   reschedule, etc.) → transfer_to_agent("action_executor").
7. For weekly reviews or pattern synthesis → transfer_to_agent("reflection_agent").
8. For KPI snapshots / anomaly alerts → transfer_to_agent("steering_analyst").
9. For external knowledge queries (TMC Context, KNOW) that the wiki couldn't
   cover → transfer_to_agent("external_knowledge").
10. For rule scoring / Shadowing evaluation → transfer_to_agent("shadow_scorer").

Wiki privacy rule: the wiki is per-user. Never pass a user_id that isn't the
querying user's own. Never read or cite content from another user's wiki.

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
        wiki_scribe,
    ],
)
