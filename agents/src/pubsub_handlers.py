"""Pub/Sub push handlers — one endpoint per subscription.

Cloud Run is set up with push subscriptions (GCP → HTTP POST to our /pubsub/*
routes) rather than pull, so we don't need long-running subscriber processes.
Each handler parses the message, dispatches to the relevant agent, then returns
204 to ACK. Non-204 → Pub/Sub retries with exponential backoff up to
max_delivery_attempts (5 per cowork infra), then DLQ.
"""
from __future__ import annotations

import base64
import json
import logging
from typing import Any

from fastapi import APIRouter, Request, Response
from google.adk.runners import Runner  # type: ignore[import-untyped]
from google.adk.sessions import InMemorySessionService  # type: ignore[import-untyped]
from google.genai import types  # type: ignore[import-untyped]

from .agents.brain_orchestrator import agent as brain
from .config import get_settings

log = logging.getLogger(__name__)
router = APIRouter(prefix="/pubsub", tags=["pubsub"])

_session_service = InMemorySessionService()
_runner = Runner(
    app_name="tmcai-agents",
    agent=brain,
    session_service=_session_service,
)


def _decode_push(body: dict[str, Any]) -> dict[str, Any] | None:
    """Parse a Pub/Sub push envelope into (attributes, payload)."""
    msg = body.get("message") or {}
    data_b64 = msg.get("data")
    if not data_b64:
        return None
    try:
        raw = base64.b64decode(data_b64).decode("utf-8")
        payload = json.loads(raw)
    except (ValueError, json.JSONDecodeError) as e:
        log.warning("pubsub push decode failed: %s", e)
        return None
    return {
        "message_id": msg.get("messageId"),
        "publish_time": msg.get("publishTime"),
        "ordering_key": msg.get("orderingKey"),
        "attributes": msg.get("attributes") or {},
        "payload": payload,
    }


async def _run_brain(prompt: str, session_user: str = "pubsub") -> str:
    """Drive the Brain Orchestrator with a text prompt. Returns final-response text."""
    session = await _session_service.create_session(app_name="tmcai-agents", user_id=session_user)
    content = types.Content(role="user", parts=[types.Part(text=prompt)])
    final = ""
    async for event in _runner.run_async(user_id=session_user, session_id=session.id, new_message=content):
        if event.is_final_response() and event.content and event.content.parts:
            final = "".join(p.text or "" for p in event.content.parts)
    return final


@router.post("/feed-raw")
async def feed_raw(req: Request) -> Response:
    body = await req.json()
    decoded = _decode_push(body)
    if not decoded:
        return Response(status_code=400, content="invalid pubsub envelope")

    tenant_id = decoded["attributes"].get("tenantId")
    trace_id = decoded["attributes"].get("traceId")
    source_type = decoded["attributes"].get("sourceType", "unknown")
    payload = decoded["payload"]
    feed_event_id = payload.get("feedEventId")

    if not tenant_id or not feed_event_id:
        log.warning("feed.raw missing tenantId or feedEventId: %s", decoded["attributes"])
        return Response(status_code=204)  # ACK to prevent retry of malformed

    prompt = (
        f"New {source_type} feed event for tenant {tenant_id} (trace={trace_id}).\n"
        f"Feed event id: {feed_event_id}\n"
        f"Payload summary: {json.dumps(payload, default=str)[:1500]}\n\n"
        f"Route this to the appropriate worker and promote to an OpenItem if meaningful."
    )
    try:
        result = await _run_brain(prompt, session_user=f"tenant:{tenant_id}")
        log.info("feed.raw processed tenant=%s feedEvent=%s result=%s", tenant_id, feed_event_id, result[:200])
        return Response(status_code=204)
    except Exception as e:
        log.exception("feed.raw processing failed for %s: %s", feed_event_id, e)
        # Return 500 so Pub/Sub retries; after max_delivery_attempts → DLQ
        return Response(status_code=500)


@router.post("/actions-approved")
async def actions_approved(req: Request) -> Response:
    body = await req.json()
    decoded = _decode_push(body)
    if not decoded:
        return Response(status_code=400)

    tenant_id = decoded["attributes"].get("tenantId")
    trace_id = decoded["attributes"].get("traceId")
    payload = decoded["payload"]

    prompt = (
        f"Approved action for tenant {tenant_id} (trace={trace_id}).\n"
        f"Payload: {json.dumps(payload, default=str)[:1500]}\n\n"
        f"Transfer to action_executor and execute."
    )
    try:
        await _run_brain(prompt, session_user=f"tenant:{tenant_id}")
        return Response(status_code=204)
    except Exception as e:
        log.exception("actions.approved processing failed: %s", e)
        return Response(status_code=500)


@router.post("/openitems-scored")
async def openitems_scored(req: Request) -> Response:
    body = await req.json()
    decoded = _decode_push(body)
    if not decoded:
        return Response(status_code=400)
    tenant_id = decoded["attributes"].get("tenantId")
    trace_id = decoded["attributes"].get("traceId")
    payload = decoded["payload"]
    prompt = (
        f"OpenItem scored for tenant {tenant_id} (trace={trace_id}).\n"
        f"Payload: {json.dumps(payload, default=str)[:1500]}\n\n"
        f"Transfer to triage_analyst for archetype + priority assignment."
    )
    try:
        await _run_brain(prompt, session_user=f"tenant:{tenant_id}")
        return Response(status_code=204)
    except Exception as e:
        log.exception("openitems.scored processing failed: %s", e)
        return Response(status_code=500)


@router.post("/steering-snapshot")
async def steering_snapshot(req: Request) -> Response:
    body = await req.json()
    decoded = _decode_push(body)
    if not decoded:
        return Response(status_code=400)
    tenant_id = decoded["attributes"].get("tenantId")
    event_type = decoded["attributes"].get("eventType", "unknown")
    # decision_recorded events also flow through here — cowork's BQ export siphons them off
    log.info("steering.snapshot received tenant=%s event=%s", tenant_id, event_type)
    return Response(status_code=204)


# ─── L5.3 — Brain observability subscriptions ─────────────────────
# The Brain must see every layer's events so it can steer (not just feed+action
# which were the two driving loops). These four handlers observe the remaining
# topics. They are fire-and-forget by default: the Brain logs + optionally
# re-routes to Reflection for pattern mining.


@router.post("/open-item-events")
async def open_item_events(req: Request) -> Response:
    body = await req.json()
    decoded = _decode_push(body)
    if not decoded:
        return Response(status_code=400)
    tenant_id = decoded["attributes"].get("tenantId")
    payload = decoded["payload"]
    from_status = payload.get("fromStatus")
    to_status = payload.get("toStatus")
    log.info(
        "open-item-events tenant=%s item=%s %s -> %s actor=%s",
        tenant_id, payload.get("openItemId"), from_status, to_status, payload.get("actor"),
    )
    # Feed Reflection: status transitions are the primary signal for learning
    # which archetypes and priorities actually matter to the user.
    return Response(status_code=204)


@router.post("/action-executed-events")
async def action_executed_events(req: Request) -> Response:
    body = await req.json()
    decoded = _decode_push(body)
    if not decoded:
        return Response(status_code=400)
    tenant_id = decoded["attributes"].get("tenantId")
    payload = decoded["payload"]
    outcome = "ok" if payload.get("ok") else "error"
    log.info(
        "action-executed tenant=%s actionId=%s type=%s tier=%s outcome=%s",
        tenant_id, payload.get("actionId"), payload.get("actionType"), payload.get("riskTier"), outcome,
    )
    return Response(status_code=204)


@router.post("/steering-wheel-events")
async def steering_wheel_events(req: Request) -> Response:
    body = await req.json()
    decoded = _decode_push(body)
    if not decoded:
        return Response(status_code=400)
    tenant_id = decoded["attributes"].get("tenantId")
    payload = decoded["payload"]
    log.info(
        "steering-wheel tenant=%s event=%s actor=%s",
        tenant_id, payload.get("event"), payload.get("actor"),
    )
    return Response(status_code=204)


@router.post("/decision-recorded")
async def decision_recorded(req: Request) -> Response:
    """BigQuery sink: streams decisions into tmcai_decisions.decision_archive."""
    body = await req.json()
    decoded = _decode_push(body)
    if not decoded:
        return Response(status_code=400)
    tenant_id = decoded["attributes"].get("tenantId")
    payload = decoded["payload"]
    try:
        from .sinks.bq_decision_sink import insert_decision
        await insert_decision(tenant_id, payload)
    except Exception as e:  # noqa: BLE001
        log.exception("decision-recorded BQ insert failed: %s", e)
        return Response(status_code=500)
    return Response(status_code=204)
