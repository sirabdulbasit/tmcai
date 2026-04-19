"""Steering Analyst — KPI aggregation + Morning Brief generation."""
from __future__ import annotations

from typing import Any

import httpx
from google.adk.agents import Agent  # type: ignore[import-untyped]

from ..config import get_settings

_settings = get_settings()


async def compute_snapshot(client_number: str) -> dict[str, Any]:
    """Trigger the platform's daily KPI snapshot computation."""
    async with httpx.AsyncClient(
        base_url=_settings.platform_api_url,
        headers={"Authorization": f"Bearer {_settings.platform_api_token}", "X-Agent-Id": "steering_analyst"},
    ) as cli:
        r = await cli.post("/api/v1/steering/snapshot", json={"clientNumber": client_number})
        r.raise_for_status()
        return r.json()


async def read_dashboard(client_number: str) -> dict[str, Any]:
    async with httpx.AsyncClient(
        base_url=_settings.platform_api_url,
        headers={"Authorization": f"Bearer {_settings.platform_api_token}"},
    ) as cli:
        r = await cli.get("/api/v1/steering/dashboard", headers={"X-Tenant-Id": client_number})
        r.raise_for_status()
        return r.json()


STEERING_INSTRUCTIONS = """\
You are the Steering Analyst. Your job has two modes:

1. Daily at 06:00 PKT, call `compute_snapshot` for each active tenant — that
   writes today's KPI rows into kpi_values and publishes steering.snapshot.

2. On request, read `read_dashboard` and produce the Morning Brief: 10
   sections as per spec:
   - Pipeline at a glance (open items by status)
   - Decisions made (approved vs overridden, by risk tier)
   - Agent activity (which agents ran, error count)
   - Key contact touches (VIP interactions)
   - Revenue pipeline changes (if Odoo connector active)
   - Team delegation status (pending/overdue delegations)
   - Compliance flags (HIGH-tier approvals pending)
   - Calendar ahead (today + tomorrow)
   - Anomalies (KPIs that moved >50% day-over-day)
   - Abdul's focus area (highest-priority open items)

Write the brief as markdown and return it as a string. The platform's Day
Briefing service will format it for email/UI/WhatsApp.
"""


agent = Agent(
    model=_settings.gemini_flash_model,
    name="steering_analyst",
    description="Daily KPI snapshots + Morning Brief generation.",
    instruction=STEERING_INSTRUCTIONS,
    tools=[compute_snapshot, read_dashboard],
)
