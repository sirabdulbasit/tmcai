"""MyOS Wiki Scribe — maintains each user's personal wiki.

Triggered by Pub/Sub push on open-item-events (status=CLOSED) and
decision-recorded. Runs per-user: every tool call is scoped by
(client_number, user_id). See agents/src/brain/wiki/SCHEMA.md for the
operating manual that's loaded verbatim as this agent's system prompt.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from google.adk.agents import Agent  # type: ignore[import-untyped]

from ..config import get_settings
from ..platform_client import PlatformClient

_settings = get_settings()

_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "brain" / "wiki" / "SCHEMA.md"
try:
    _SCHEMA_TEXT = _SCHEMA_PATH.read_text(encoding="utf-8")
except Exception:  # noqa: BLE001
    _SCHEMA_TEXT = "SCHEMA.md missing — refuse to operate."


# ─── Tools (all user-scoped) ───────────────────────────────────────


async def upsert_wiki_page(
    client_number: str,
    user_id: int,
    page_type: str,
    title: str,
    body: str,
    confidence: float = 0.7,
    source_feed_event_id: str | None = None,
    source_open_item_id: str | None = None,
    source_decision_log_id: str | None = None,
    outbound_links_json: str = "[]",
) -> dict[str, Any]:
    """Upsert a wiki page in the specified user's wiki.

    Storage (Notion or Postgres) is chosen automatically by the platform based
    on whether the user has a connected Notion integration.

    `outbound_links_json` is a JSON array of {toTitle, toPageType, linkType?}
    objects describing cross-references to other wiki pages.
    """
    import json as _json

    try:
        outbound = _json.loads(outbound_links_json) if outbound_links_json else []
    except _json.JSONDecodeError:
        outbound = []

    source_ids = []
    if source_feed_event_id:
        source_ids.append({"feedEventId": source_feed_event_id})
    if source_open_item_id:
        source_ids.append({"openItemId": source_open_item_id})
    if source_decision_log_id:
        source_ids.append({"decisionLogId": source_decision_log_id})

    p = PlatformClient()
    try:
        return await p.wiki_upsert_page(
            client_number=client_number,
            user_id=user_id,
            page_type=page_type,
            title=title,
            body=body,
            confidence=confidence,
            source_ids=source_ids,
            outbound_links=outbound,
            actor="wiki_scribe",
        )
    finally:
        await p.close()


async def read_wiki_page(client_number: str, user_id: int, page_id: str) -> dict[str, Any]:
    """Fetch one wiki page's full body + metadata."""
    p = PlatformClient()
    try:
        return await p.wiki_read_page(client_number, user_id, page_id)
    finally:
        await p.close()


async def query_wiki_index(
    client_number: str,
    user_id: int,
    question: str,
    limit: int = 5,
) -> dict[str, Any]:
    """Search the user's wiki index for pages most likely to contain context
    relevant to `question`. Returns up to `limit` candidates."""
    p = PlatformClient()
    try:
        return await p.wiki_query_index(client_number, user_id, question, limit)
    finally:
        await p.close()


async def link_pages(
    client_number: str,
    user_id: int,
    from_page_id: str,
    to_page_id: str,
    link_type: str = "related",
) -> dict[str, Any]:
    """Record a cross-reference edge between two pages in the user's wiki."""
    p = PlatformClient()
    try:
        return await p.wiki_link_pages(client_number, user_id, from_page_id, to_page_id, link_type)
    finally:
        await p.close()


async def read_raw_source(client_number: str, feed_event_id: str) -> dict[str, Any]:
    """Fetch a raw feed_event row. Used to gather context before summarising."""
    p = PlatformClient()
    try:
        return await p.read_feed_event(client_number, feed_event_id)
    finally:
        await p.close()


async def refresh_wiki_index(client_number: str, user_id: int) -> dict[str, Any]:
    """Re-render the user's MyOS Index page from current wiki state. Call at
    the end of every ingest cycle."""
    p = PlatformClient()
    try:
        return await p.wiki_refresh_index(client_number, user_id)
    finally:
        await p.close()


async def append_wiki_log(
    client_number: str,
    user_id: int,
    kind: str,
    title: str,
    details: str | None = None,
) -> dict[str, Any]:
    """Append a chronicle entry to the user's MyOS Log page.

    kind must be one of 'ingest', 'query', or 'lint'. Keep title short (<120 chars).
    """
    p = PlatformClient()
    try:
        return await p.wiki_append_log(client_number, user_id, kind, title, details)
    finally:
        await p.close()


CURATOR_PROMPT = (
    _SCHEMA_TEXT
    + "\n\n---\n\n"
    + """You are wiki_scribe — the MyOS Wiki maintainer.

Every invocation carries exactly one (client_number, user_id) context. You
must never cross tenant or user boundaries.

Your workflow on each trigger:

1. Read the incoming event (OpenItem CLOSED / decision recorded / feed_event
   promoted). Identify the user_id from event attributes.
2. Follow the ingest workflow in §5 of SCHEMA.md above.
3. Always produce 3-5 meaningful cross-references per page — prefer fewer,
   higher-quality links over many weak ones.
4. Call `upsert_wiki_page` once per page touched. Typical ingest touches
   5-15 pages.
5. Never silently overwrite contradicting facts — flag per §7.
6. Tag your confidence per §14. Pages with confidence < 0.5 should not be
   written (the platform rejects them anyway).

You are not conversational. You act. You return a short summary of pages
touched when you are done.
"""
)


agent = Agent(
    model=_settings.gemini_flash_model,
    name="wiki_scribe",
    description="Maintains per-user Memex wikis — Notion-backed or Postgres fallback.",
    instruction=CURATOR_PROMPT,
    tools=[
        upsert_wiki_page,
        read_wiki_page,
        query_wiki_index,
        link_pages,
        read_raw_source,
        refresh_wiki_index,
        append_wiki_log,
    ],
)
