"""External Knowledge — RAG queries against tenant KB + TMC Context + KNOW APIs."""
from __future__ import annotations

from typing import Any

import httpx
from google.adk.agents import Agent  # type: ignore[import-untyped]

from ..config import get_settings
from ..platform_client import PlatformClient

_settings = get_settings()


async def query_user_wiki(
    client_number: str,
    user_id: int,
    question: str,
    limit: int = 5,
) -> dict[str, Any]:
    """Search the querying user's personal wiki — the first retrieval layer.

    Pages here have already been synthesized from raw sources by wiki_scribe.
    Prefer this over KB/TMC/KNOW for anything the user should already know.
    """
    p = PlatformClient()
    try:
        return await p.wiki_query_index(client_number, user_id, question, limit)
    finally:
        await p.close()


async def read_user_wiki_page(client_number: str, user_id: int, page_id: str) -> dict[str, Any]:
    """Read one wiki page's full body for the querying user."""
    p = PlatformClient()
    try:
        return await p.wiki_read_page(client_number, user_id, page_id)
    finally:
        await p.close()


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

Routing priority (most personal to least personal):
1. FIRST try `query_user_wiki` (the asking user's personal Memex wiki — pages
   already synthesized by wiki_scribe from their own sources). Read 2-3 of the
   top matches via `read_user_wiki_page`. If the user's wiki gives a direct
   answer, return it citing page titles.
2. If wiki coverage is thin, try `query_knowledge_base` (tenant KB — SOPs,
   playbooks, domain docs).
3. If that's also insufficient, try `query_tmc_context` (TMC-specific context:
   employees, projects, policies).
4. If it requires industry/market intel, use `query_know`.
5. Synthesize into a single answer. Always cite sources (wiki page titles or
   KB/TMC/KNOW record ids) so the user can verify.

Privacy: the wiki is per-user. Never call query_user_wiki with another user's
user_id. Never cite or quote content from another user's wiki.
"""


agent = Agent(
    model=_settings.gemini_flash_model,
    name="external_knowledge",
    description="Retrieves from user wiki + tenant KB + TMC Context + KNOW; synthesizes answers.",
    instruction=EXTERNAL_INSTRUCTIONS,
    tools=[
        query_user_wiki,
        read_user_wiki_page,
        query_knowledge_base,
        query_tmc_context,
        query_know,
    ],
)
