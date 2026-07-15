"""Feed Curator — subscribes to feed.raw, dedups, normalizes, promotes to OpenItem."""
from __future__ import annotations

from typing import Any

from google.adk.agents import Agent  # type: ignore[import-untyped]

from ..config import get_settings
from ..platform_client import PlatformClient

_settings = get_settings()


async def promote_feed_to_open_item(
    client_number: str,
    feed_event_id: str,
    title: str,
    item_type: str,
    priority: str = "medium",
    entity_id: str | None = None,
    description: str | None = None,
    archetype: str | None = None,
) -> dict[str, Any]:
    """Create an OpenItem from a feed event + mark the feed row processed.

    `archetype` is one of the 6 v15 values (reply_needed, delegate, inform_only,
    schedule_meeting, review_risk, acknowledge). Call `classify_archetype` first
    for non-obvious cases.
    """
    p = PlatformClient()
    try:
        payload = {
            "title": title,
            "description": description,
            "type": item_type,
            "priority": priority,
            "entityId": entity_id,
            "sourceFeedEventId": feed_event_id,
        }
        if archetype:
            payload["archetype"] = archetype
        item = await p.create_open_item(client_number, payload)
        await p.mark_feed_processed(feed_event_id, client_number, open_item_id=item.get("id"))
        return {"openItemId": item.get("id"), "feedEventId": feed_event_id, "archetype": archetype}
    finally:
        await p.close()


async def classify_archetype(
    client_number: str,
    source_type: str,
    event_type: str | None = None,
    sender_email: str | None = None,
    subject: str | None = None,
    snippet: str | None = None,
    body: str | None = None,
    vip: bool = False,
) -> dict[str, Any]:
    """Call the platform's deterministic archetype classifier. Cheap — no LLM cost.

    Returns {archetype, confidence, signals, suggestedItemType}. Use as the
    first pass; only fall back to in-context reasoning if confidence < 0.7.
    """
    p = PlatformClient()
    try:
        return await p.classify_archetype(
            client_number,
            {
                "sourceType": source_type,
                "eventType": event_type,
                "senderEmail": sender_email,
                "subject": subject,
                "snippet": snippet,
                "body": body,
                "vip": vip,
            },
        )
    finally:
        await p.close()


async def skip_feed_event(client_number: str, feed_event_id: str, reason: str) -> dict[str, Any]:
    """Mark a feed event as skipped (noise, already addressed, etc.)."""
    p = PlatformClient()
    try:
        await p.mark_feed_processed(feed_event_id, client_number)
        return {"feedEventId": feed_event_id, "reason": reason}
    finally:
        await p.close()


CURATOR_INSTRUCTIONS = """\
You are the Feed Curator. You receive raw feed events (Gmail, WhatsApp, Chat,
Calendar, Tasks) and decide whether each should become an OpenItem.

For each event:
1. Read the payload (sender, subject, body, metadata).
2. Deduplicate against existing open items by subject / thread — caller already
   did a content-hash dedup at ingestion time, but you do a semantic dedup.
3. Classify the archetype by calling `classify_archetype` FIRST. Use its
   suggestion unless confidence < 0.7 — in that case reason in-context.
4. Derive item_type: email | task | delegation | alert. Use the classifier's
   suggestedItemType when available.
5. Decide priority: critical | high | medium | low. Default medium.
6. If the event is noise (spam, promotional, already-handled) call
   `skip_feed_event` with a brief reason.
7. Otherwise call `promote_feed_to_open_item` with `archetype=<classifier result>`
   to materialize the OpenItem.

Never invoke action handlers yourself — promoting to an open item is enough.
Triage Analyst takes over from there.
"""


agent = Agent(
    model=_settings.gemini_flash_model,
    name="feed_curator",
    description="Promotes raw feed events to scored OpenItems.",
    instruction=CURATOR_INSTRUCTIONS,
    tools=[promote_feed_to_open_item, skip_feed_event, classify_archetype],
)
