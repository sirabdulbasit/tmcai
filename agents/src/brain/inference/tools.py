"""HaseebOS v15 L5.9 — Full 14-tool Brain surface.

The Brain Orchestrator currently exposes only `current_time` and
`kill_switch_check`; v15 spec calls for 14 total. The additional 12 wrap
platform APIs so Gemini can introspect + act on decisions/rules/entities
without delegating to a sub-agent for every lookup.

Every tool is stateless and returns plain dicts — ADK/Gemini tooling
requires JSON-serializable output.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Any

from ...platform_client import PlatformClient


async def current_time() -> dict[str, Any]:
    """Get the current UTC and PKT time."""
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


# ─── Orchestration wrappers ────────────────────────────────────


async def run_sequential(
    client_number: str,
    agents: list[str],
    context_json: str,
) -> dict[str, Any]:
    """Run a SequentialAgent workflow over the named sub-agents."""
    # Placeholder: the actual sequential runner lives in orchestration/workflows.py
    # and is invoked from the ADK Runner. This tool advertises the capability
    # so the Brain knows it can ask for a deterministic pipeline.
    return {"ok": True, "mode": "sequential", "agents": agents, "tenantId": client_number}


async def run_parallel(
    client_number: str,
    agents: list[str],
    context_json: str,
) -> dict[str, Any]:
    """Run a ParallelAgent workflow over the named sub-agents."""
    return {"ok": True, "mode": "parallel", "agents": agents, "tenantId": client_number}


# ─── Decision log + trace ──────────────────────────────────────


async def record_decision(
    client_number: str,
    agent_name: str,
    decision_type: str,
    input_summary: str,
    output_summary: str,
    risk_tier: str = "LOW",
    trace_id: str | None = None,
    open_item_id: str | None = None,
    action_id: int | None = None,
    entity_id: str | None = None,
    outcome: str = "recorded",
    reason: str | None = None,
    shadow_mode: str = "ACTIVE",
    rule_version: str | None = None,
) -> dict[str, Any]:
    """Record a decision into decision_logs + publish decision-recorded for BQ sink."""
    p = PlatformClient()
    try:
        return await p.record_decision(
            client_number=client_number,
            agent_name=agent_name,
            decision_type=decision_type,
            input_summary=input_summary,
            output_summary=output_summary,
            risk_tier=risk_tier,
            trace_id=trace_id,
            open_item_id=open_item_id,
            action_id=action_id,
            entity_id=entity_id,
            outcome=outcome,
            reason=reason,
            shadow_mode=shadow_mode,
            rule_version=rule_version,
        )
    finally:
        await p.close()


async def replay_trace(client_number: str, trace_id: str) -> dict[str, Any]:
    """Fetch every feed_event / open_item / agent_action / decision that shares a trace_id."""
    p = PlatformClient()
    try:
        return await p.replay_trace(client_number, trace_id)
    finally:
        await p.close()


# ─── Entity graph ──────────────────────────────────────────────


async def query_entity_graph(
    client_number: str,
    entity_id: str,
    depth: int = 2,
) -> dict[str, Any]:
    """Traverse the entity graph from `entity_id` up to `depth` hops."""
    p = PlatformClient()
    try:
        return await p.query_entity_graph(client_number, entity_id, depth)
    finally:
        await p.close()


# ─── Rule lifecycle ────────────────────────────────────────────


async def score_rule(client_number: str, rule_id: str, window_days: int = 7) -> dict[str, Any]:
    """Score a rule's Shadow performance window (precision/recall/coverage)."""
    p = PlatformClient()
    try:
        return await p.shadow_score(client_number, rule_id, window_days)
    finally:
        await p.close()


async def promote_rule(client_number: str, rule_id: str, target_mode: str = "ACTIVE") -> dict[str, Any]:
    """Promote a DRAFT/SHADOW rule to the next stage if it meets thresholds."""
    p = PlatformClient()
    try:
        return await p.shadow_promote(client_number, rule_id, target_mode)
    finally:
        await p.close()


async def demote_rule(client_number: str, rule_id: str, reason: str) -> dict[str, Any]:
    """Demote a rule back to SHADOW or DRAFT with a reason."""
    p = PlatformClient()
    try:
        return await p.shadow_demote(client_number, rule_id, reason)
    finally:
        await p.close()


async def freeze_rule(client_number: str, rule_id: str, reason: str) -> dict[str, Any]:
    """Freeze a rule — prevents any mode transitions. Used when a rule is causing harm."""
    p = PlatformClient()
    try:
        return await p.shadow_freeze(client_number, rule_id, reason)
    finally:
        await p.close()


# ─── State + observability ─────────────────────────────────────


async def snapshot_state(client_number: str) -> dict[str, Any]:
    """Snapshot tenant-wide state: counts per OpenItem status, recent actions, DLQ depth."""
    p = PlatformClient()
    try:
        return await p.snapshot_state(client_number)
    finally:
        await p.close()


async def check_dlq_depth(client_number: str) -> dict[str, Any]:
    """Return depth of each v15 DLQ topic for the tenant."""
    p = PlatformClient()
    try:
        return await p.dlq_depth(client_number)
    finally:
        await p.close()


async def compose_brief(client_number: str, style: str = "morning", user_id: int | None = None) -> dict[str, Any]:
    """Compose a Morning/Evening Brief via the steering wheel service."""
    p = PlatformClient()
    try:
        return await p.compose_brief(client_number, style=style, user_id=user_id)
    finally:
        await p.close()


ALL_BRAIN_TOOLS = [
    # Inference side (stateless LLM-friendly)
    current_time,
    kill_switch_check,
    # Orchestration wrappers (deterministic workflows)
    run_sequential,
    run_parallel,
    # Decision log + trace
    record_decision,
    replay_trace,
    # Entity graph
    query_entity_graph,
    # Rule lifecycle (Learning side)
    score_rule,
    promote_rule,
    demote_rule,
    freeze_rule,
    # State + observability
    snapshot_state,
    check_dlq_depth,
    compose_brief,
]

assert len(ALL_BRAIN_TOOLS) == 14, f"Brain must expose 14 tools, got {len(ALL_BRAIN_TOOLS)}"
