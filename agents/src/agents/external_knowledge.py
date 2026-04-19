"""External Knowledge — RAG queries against tenant KB + TMC Context + KNOW APIs."""
from __future__ import annotations

from typing import Any

import httpx
from google.adk.agents import Agent  # type: ignore[import-untyped]

from ..config import get_settings

_settings = get_settings()


async def query_knowledge_base(client_number: str, query: str, top_k: int = 5) -> dict[str, Any]:
    """Hybrid search across tenant's uploaded KB + domain knowledge."""
    async with httpx.AsyncClient(
        base_url=_settings.platform_api_url,
        headers={"Authorization": f"Bearer {_settings.platform_api_token}"},
    ) as cli:
        r = await cli.post(
            "/api/v1/knowledge/search",
            json={"clientNumber": client_number, "query": query, "topK": top_k},
        )
        r.raise_for_status()
        return r.json()


async def query_tmc_context(query: str) -> dict[str, Any]:
    """Query TMC's internal context API (employees, projects, policies).

    Returns structured results from TMC Context. Falls back gracefully
    if the endpoint is not yet configured.
    """
    if not _settings.tmc_context_api_url:
        return {"skipped": True, "reason": "TMC Context API URL not configured", "query": query}

    async with httpx.AsyncClient(
        base_url=_settings.tmc_context_api_url,
        headers={"Authorization": f"Bearer {_settings.tmc_context_api_key}"},
        timeout=30.0,
    ) as cli:
        try:
            r = await cli.post("/search", json={"query": query, "limit": 10})
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError as exc:
            return {"error": str(exc), "source": "tmc_context", "query": query}


async def query_know(query: str) -> dict[str, Any]:
    """Query the KNOW industry/market knowledge API.

    Returns structured results from KNOW. Falls back gracefully
    if the endpoint is not yet configured.
    """
    if not _settings.know_api_url:
        return {"skipped": True, "reason": "KNOW API URL not configured", "query": query}

    async with httpx.AsyncClient(
        base_url=_settings.know_api_url,
        headers={"Authorization": f"Bearer {_settings.know_api_key}"},
        timeout=30.0,
    ) as cli:
        try:
            r = await cli.post("/search", json={"query": query, "limit": 10})
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError as exc:
            return {"error": str(exc), "source": "know", "query": query}


EXTERNAL_INSTRUCTIONS = """\
You are the External Knowledge agent. You answer questions that require reference
material beyond the OpenItem / DecisionLog scope.

Routing logic:
1. First try `query_knowledge_base` (tenant KB — SOPs, playbooks, domain docs).
2. If the answer requires TMC-specific context (employees, projects, policies)
   fall through to `query_tmc_context`.
3. If it requires industry/market intel, fall through to `query_know`.
4. Synthesize results into a single answer. Cite sources by `id` so Abdul can
   verify.
"""


agent = Agent(
    model=_settings.gemini_flash_model,
    name="external_knowledge",
    description="Retrieves from tenant KB + TMC Context + KNOW; synthesizes answers.",
    instruction=EXTERNAL_INSTRUCTIONS,
    tools=[query_knowledge_base, query_tmc_context, query_know],
)
