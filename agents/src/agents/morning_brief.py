"""HaseebOS v15 L4.4 — Morning Brief agent.

Exposed as a workflow-agent composition so Cloud Scheduler (or the node
server's daily cron) can POST to `/admin/compose-brief` and get a narrative
back.

Internally it uses the deterministic workflows defined in
`brain/orchestration/workflows.py` — ParallelAgent fetches KPIs + news +
recent patterns concurrently, then a SequentialAgent step composes the
narrative.
"""
from __future__ import annotations

from google.adk.agents import Agent  # type: ignore[import-untyped]

from ..config import get_settings

_settings = get_settings()


BRIEF_INSTRUCTIONS = """\
You are the Morning Brief composer. Given parallel inputs from Steering
(KPIs), External Knowledge (news + weather), and Reflection (overnight
patterns), produce a crisp 8-12 bullet narrative for Abdul in PKT timezone.

Structure:
- Top of day: 1 sentence framing
- Priorities: 3-4 bullets of today's highest-leverage OpenItems
- Risk watch: anything HIGH-tier needing approval today
- Calendar: meetings >= 15 minutes
- Patterns: 1 insight from overnight reflection
- Weather/news: 1-2 lines max

Tone: direct, present-tense, no filler. Never output JSON.
"""


agent = Agent(
    model=_settings.gemini_flash_model,
    name="morning_brief",
    description="Composes Abdul's daily Morning Brief from KPIs + news + patterns.",
    instruction=BRIEF_INSTRUCTIONS,
    tools=[],
)
