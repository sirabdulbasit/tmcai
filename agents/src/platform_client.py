"""HTTP client for calling back into the tmcai platform API.

Agents never write to Postgres directly — they go through /api/v1/* so the
platform layer can enforce tenant isolation, risk gating, PII masking, etc.
"""
from __future__ import annotations

import httpx
from typing import Any

from .config import get_settings


class PlatformClient:
    def __init__(self) -> None:
        s = get_settings()
        self._base = s.platform_api_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self._base,
            timeout=30.0,
            headers={
                "Authorization": f"Bearer {s.platform_api_token}",
                "Content-Type": "application/json",
                "X-Agent-Id": s.agent_id,
            },
        )

    async def close(self) -> None:
        await self._client.aclose()

    @staticmethod
    def _tenant_headers(client_number: str) -> dict[str, str]:
        # Platform's agentAuthMiddleware requires X-Tenant-Id alongside the bearer token.
        return {"X-Tenant-Id": client_number}

    # ─── Open Items ────────────────────────────────────────────────
    async def create_open_item(self, client_number: str, item: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.post(
            "/api/v1/open-items",
            json={"clientNumber": client_number, **item},
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()
        return r.json()

    async def update_open_item(self, client_number: str, item_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.patch(
            f"/api/v1/open-items/{item_id}",
            json=patch,
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()
        return r.json()

    # ─── Feed events ───────────────────────────────────────────────
    async def mark_feed_processed(
        self, feed_event_id: str, client_number: str, open_item_id: str | None = None
    ) -> None:
        r = await self._client.post(
            f"/api/v1/feed/events/{feed_event_id}/processed",
            json={"clientNumber": client_number, "openItemId": open_item_id},
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()

    # ─── Actions ───────────────────────────────────────────────────
    async def execute_action(
        self,
        client_number: str,
        user_id: int,
        action_type: str,
        payload: dict[str, Any],
        trace_id: str | None = None,
        executed_by_agent: str | None = None,
    ) -> dict[str, Any]:
        r = await self._client.post(
            "/api/v1/actions/execute",
            headers=self._tenant_headers(client_number),
            json={
                "clientNumber": client_number,
                "userId": user_id,
                "actionType": action_type,
                "payload": payload,
                "traceId": trace_id,
                "executedByAgent": executed_by_agent,
            },
        )
        r.raise_for_status()
        return r.json()

    async def risk_assess(self, client_number: str, user_id: int, body: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.post(
            "/api/v1/risk/assess",
            headers=self._tenant_headers(client_number),
            json={"clientNumber": client_number, "userId": user_id, **body},
        )
        r.raise_for_status()
        return r.json()

    # ─── Decision log ──────────────────────────────────────────────
    async def record_decision(
        self,
        *,
        client_number: str | None = None,
        agent_name: str | None = None,
        decision_type: str | None = None,
        input_summary: str | None = None,
        output_summary: str | None = None,
        risk_tier: str | None = None,
        trace_id: str | None = None,
        open_item_id: str | None = None,
        action_id: int | None = None,
        entity_id: str | None = None,
        outcome: str | None = None,
        reason: str | None = None,
        shadow_mode: str | None = None,
        rule_version: str | None = None,
        entry: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = dict(entry) if entry else {}
        if client_number is not None: body["clientNumber"] = client_number
        if agent_name is not None: body["agentId"] = agent_name
        if decision_type is not None: body["itemType"] = decision_type
        if input_summary is not None: body["inputSummary"] = input_summary
        if output_summary is not None: body["outputSummary"] = output_summary
        if risk_tier is not None: body["riskTier"] = risk_tier
        if trace_id is not None: body["traceId"] = trace_id
        if open_item_id is not None: body["openItemId"] = open_item_id
        if action_id is not None: body["actionId"] = action_id
        if entity_id is not None: body["entityId"] = entity_id
        if outcome is not None: body["userDecision"] = outcome
        if reason is not None: body["overrideReason"] = reason
        if shadow_mode is not None: body["shadowMode"] = shadow_mode
        if rule_version is not None: body["ruleVersion"] = rule_version
        tenant = body.get("clientNumber", "")
        r = await self._client.post(
            "/api/v1/decisions",
            json=body,
            headers=self._tenant_headers(tenant) if tenant else {},
        )
        r.raise_for_status()
        return r.json()

    # ─── L5.9 Brain tool wrappers ──────────────────────────────────
    async def replay_trace(self, client_number: str, trace_id: str) -> dict[str, Any]:
        r = await self._client.get(
            f"/api/v1/decisions/trace/{trace_id}",
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()
        return r.json()

    async def query_entity_graph(self, client_number: str, entity_id: str, depth: int = 2) -> dict[str, Any]:
        r = await self._client.get(
            f"/api/v1/entities/{entity_id}/graph",
            params={"depth": depth},
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()
        return r.json()

    async def shadow_score(self, client_number: str, rule_id: str, window_days: int = 7) -> dict[str, Any]:
        r = await self._client.post(
            f"/api/v1/shadow/rules/{rule_id}/score",
            json={"windowDays": window_days},
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()
        return r.json()

    async def shadow_promote(self, client_number: str, rule_id: str, target_mode: str) -> dict[str, Any]:
        r = await self._client.post(
            f"/api/v1/shadow/rules/{rule_id}/promote",
            json={"targetMode": target_mode},
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()
        return r.json()

    async def shadow_demote(self, client_number: str, rule_id: str, reason: str) -> dict[str, Any]:
        r = await self._client.post(
            f"/api/v1/shadow/rules/{rule_id}/demote",
            json={"reason": reason},
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()
        return r.json()

    async def shadow_freeze(self, client_number: str, rule_id: str, reason: str) -> dict[str, Any]:
        r = await self._client.post(
            f"/api/v1/shadow/rules/{rule_id}/freeze",
            json={"reason": reason},
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()
        return r.json()

    async def snapshot_state(self, client_number: str) -> dict[str, Any]:
        r = await self._client.get(
            "/api/v1/steering/snapshot-state",
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()
        return r.json()

    async def dlq_depth(self, client_number: str) -> dict[str, Any]:
        r = await self._client.get(
            "/api/v1/safety/dlq-depth",
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()
        return r.json()

    # ─── Wiki (Memex) per-user tools ─────────────────────────────
    async def wiki_upsert_page(
        self,
        *,
        client_number: str,
        user_id: int,
        page_type: str,
        title: str,
        body: str,
        confidence: float,
        source_ids: list[dict[str, Any]] | None = None,
        outbound_links: list[dict[str, Any]] | None = None,
        actor: str = "wiki_scribe",
    ) -> dict[str, Any]:
        r = await self._client.post(
            "/api/v1/wiki/pages",
            json={
                "pageType": page_type,
                "title": title,
                "body": body,
                "confidence": confidence,
                "sourceIds": source_ids or [],
                "outboundLinks": outbound_links or [],
                "actor": actor,
                "_asUserId": user_id,
            },
            headers={**self._tenant_headers(client_number), "X-On-Behalf-Of-User": str(user_id)},
        )
        r.raise_for_status()
        return r.json()

    async def wiki_read_page(self, client_number: str, user_id: int, page_id: str) -> dict[str, Any]:
        r = await self._client.get(
            f"/api/v1/wiki/pages/{page_id}",
            headers={**self._tenant_headers(client_number), "X-On-Behalf-Of-User": str(user_id)},
        )
        r.raise_for_status()
        return r.json()

    async def wiki_query_index(
        self, client_number: str, user_id: int, question: str, limit: int = 5
    ) -> dict[str, Any]:
        r = await self._client.get(
            "/api/v1/wiki/index",
            params={"q": question, "limit": limit},
            headers={**self._tenant_headers(client_number), "X-On-Behalf-Of-User": str(user_id)},
        )
        r.raise_for_status()
        return r.json()

    async def wiki_link_pages(
        self, client_number: str, user_id: int, from_page_id: str, to_page_id: str, link_type: str
    ) -> dict[str, Any]:
        r = await self._client.post(
            "/api/v1/wiki/links",
            json={"fromPageId": from_page_id, "toPageId": to_page_id, "linkType": link_type},
            headers={**self._tenant_headers(client_number), "X-On-Behalf-Of-User": str(user_id)},
        )
        r.raise_for_status()
        return r.json()

    async def wiki_refresh_index(self, client_number: str, user_id: int) -> dict[str, Any]:
        r = await self._client.post(
            "/api/v1/wiki/index/refresh",
            json={},
            headers={**self._tenant_headers(client_number), "X-On-Behalf-Of-User": str(user_id)},
        )
        r.raise_for_status()
        return r.json()

    async def wiki_append_log(
        self, client_number: str, user_id: int, kind: str, title: str, details: str | None = None
    ) -> dict[str, Any]:
        r = await self._client.post(
            "/api/v1/wiki/log/append",
            json={"kind": kind, "title": title, "details": details},
            headers={**self._tenant_headers(client_number), "X-On-Behalf-Of-User": str(user_id)},
        )
        r.raise_for_status()
        return r.json()

    async def read_feed_event(self, client_number: str, feed_event_id: str) -> dict[str, Any]:
        r = await self._client.get(
            f"/api/v1/feed/events/{feed_event_id}",
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()
        return r.json()

    async def classify_archetype(self, client_number: str, body: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.post(
            "/api/v1/triage/archetype",
            json=body,
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()
        return r.json()

    async def compose_brief(self, client_number: str, *, style: str = "morning", user_id: int | None = None) -> dict[str, Any]:
        r = await self._client.post(
            "/api/v1/steering/brief",
            json={"style": style, "userId": user_id},
            headers=self._tenant_headers(client_number),
        )
        r.raise_for_status()
        return r.json()

    # ─── Kill switch check (agents gate every tool invocation) ─────
    async def kill_switch_active(self, client_number: str) -> bool:
        try:
            r = await self._client.get(
                "/api/v1/safety/kill-switch/status",
                headers={"X-Tenant-Id": client_number},
            )
            r.raise_for_status()
            return bool(r.json().get("active", False))
        except httpx.HTTPError:
            # Fail-safe: if we can't reach the platform, assume we should halt
            return True
