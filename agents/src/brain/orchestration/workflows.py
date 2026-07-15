"""HaseebOS v15 L5.2 — ADK SequentialAgent / ParallelAgent workflows.

These are deterministic pipelines composed of existing Flash workers. The
Brain Orchestrator picks them via the `run_sequential` / `run_parallel` tools
from inference/tools.py — or the Pub/Sub handlers invoke them directly when
they know which pipeline fits.

ADK supports two composition primitives:

- SequentialAgent: runs sub_agents in order, passing shared `session_state`
  between them. Used when step N needs step N-1's output.

- ParallelAgent: runs sub_agents concurrently. Used when each sub-task is
  independent (e.g. fetch calendar + news + KPIs for Morning Brief).

On ADK versions where these classes are unavailable we fall back to plain
Agent wrappers so imports still succeed.
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)

try:
    from google.adk.agents import SequentialAgent, ParallelAgent  # type: ignore[import-untyped]
    _ADK_WORKFLOWS_AVAILABLE = True
except Exception:  # noqa: BLE001
    SequentialAgent = None  # type: ignore[assignment]
    ParallelAgent = None  # type: ignore[assignment]
    _ADK_WORKFLOWS_AVAILABLE = False

from ...agents.feed_curator import agent as feed_curator
from ...agents.triage_analyst import agent as triage_analyst
from ...agents.reflection_agent import agent as reflection_agent
from ...agents.steering_analyst import agent as steering_analyst
from ...agents.shadow_scorer import agent as shadow_scorer
from ...agents.external_knowledge import agent as external_knowledge


def _maybe_sequential(name: str, sub_agents):  # noqa: ANN001
    if not _ADK_WORKFLOWS_AVAILABLE:
        log.warning("SequentialAgent unavailable — %s will run via Brain free-form routing", name)
        return None
    return SequentialAgent(name=name, description=f"v15 deterministic pipeline: {name}", sub_agents=sub_agents)


def _maybe_parallel(name: str, sub_agents):  # noqa: ANN001
    if not _ADK_WORKFLOWS_AVAILABLE:
        log.warning("ParallelAgent unavailable — %s will run sequentially", name)
        return None
    return ParallelAgent(name=name, description=f"v15 parallel pipeline: {name}", sub_agents=sub_agents)


# ─── Pipeline 1: feed event → OpenItem ──────────────────────────────
# Curator classifies + promotes, then Triage assigns priority + SLA.
feed_to_openitem_pipeline = _maybe_sequential(
    "feed_to_openitem_pipeline",
    [feed_curator, triage_analyst],
)

# ─── Pipeline 2: Morning Brief ──────────────────────────────────────
# Parallel fan-out: Steering (KPIs), External Knowledge (news/weather),
# Reflection (pattern digest). Then a final SequentialAgent step synthesises
# the narrative — represented here by Steering Analyst acting as the composer.
_morning_brief_parallel = _maybe_parallel(
    "morning_brief_gather",
    [steering_analyst, external_knowledge, reflection_agent],
)
morning_brief_pipeline = (
    _maybe_sequential(
        "morning_brief_pipeline",
        [_morning_brief_parallel, steering_analyst],
    )
    if _morning_brief_parallel is not None
    else None
)

# ─── Pipeline 3: Nightly Reflection → Shadow scoring ────────────────
reflection_pipeline = _maybe_sequential(
    "reflection_pipeline",
    [reflection_agent, shadow_scorer],
)
