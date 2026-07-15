"""Action Executor — consumes actions.approved, calls platform API to execute handlers."""
from __future__ import annotations

from typing import Any

from google.adk.agents import Agent  # type: ignore[import-untyped]

from ..config import get_settings
from ..platform_client import PlatformClient

_settings = get_settings()


async def execute(
    client_number: str,
    user_id: int,
    action_type: str,
    payload_json: str,
    trace_id: str | None = None,
) -> dict[str, Any]:
    """Dispatch an approved action to the platform's handler registry.

    `payload_json` is a JSON string representing the handler-specific payload
    (Gemini function-call schemas don't allow open-ended dicts, so we pass it
    as a string and parse here).
    """
    import json as _json

    p = PlatformClient()
    try:
        try:
            payload = _json.loads(payload_json) if payload_json else {}
        except _json.JSONDecodeError as exc:
            return {"error": f"payload_json is not valid JSON: {exc}"}
        if not isinstance(payload, dict):
            return {"error": "payload_json must decode to a JSON object"}
        return await p.execute_action(
            client_number=client_number,
            user_id=user_id,
            action_type=action_type,
            payload=payload,
            trace_id=trace_id,
            executed_by_agent="action_executor",
        )
    finally:
        await p.close()


async def risk_assess(
    client_number: str,
    user_id: int,
    action_type: str,
    financial_value_usd: float | None = None,
    target_is_vip: bool = False,
    target_is_external: bool = False,
) -> dict[str, Any]:
    """Pre-flight risk check before execute. Returns {tier, reasons, policy}."""
    p = PlatformClient()
    try:
        return await p.risk_assess(
            client_number,
            user_id,
            {
                "actionType": action_type,
                "financialValueUsd": financial_value_usd,
                "targetIsVip": target_is_vip,
                "targetIsExternal": target_is_external,
            },
        )
    finally:
        await p.close()


EXECUTOR_INSTRUCTIONS = """\
You are the Action Executor. You receive approved actions and dispatch them to
the platform's handler registry via `execute`.

Hard rules:
1. BEFORE every execute, call `risk_assess`. If tier=HIGH without a pre-existing
   approval_id in the payload, REFUSE and return a message asking the Brain to
   route through `wait_for_approval` first.
2. NEVER call execute() twice for the same action — the platform's idempotency
   layer will reject it, but don't rely on that.
3. Always pass the trace_id through so DecisionLog correlates with the feed event.

Supported action types (not exhaustive — check the platform registry):
- Communication: send_email, send_email_reply, forward_email, send_whatsapp_message, send_chat_reply
- Calendar: create_event, reschedule_event, cancel_event, propose_times, add_attendee
- Task: create_task, complete_task, reassign_task, add_subtask
- CRM: create_odoo_lead, update_odoo_crm, create_odoo_opportunity, update_odoo_opportunity
- Lifecycle: snooze, close, archive, split_item, merge_items, escalate, demote
- Orchestration: transfer_to_agent, wait_for_approval, parallel_fan_out
- Brain: update_priority, tag_entity, extract_insight, update_memory, sync_thought_to_notion
- Governance: request_approval, log_override, freeze_rule
"""


agent = Agent(
    model=_settings.gemini_flash_model,
    name="action_executor",
    description="Dispatches approved actions to the platform handler registry.",
    instruction=EXECUTOR_INSTRUCTIONS,
    tools=[execute, risk_assess],
)
