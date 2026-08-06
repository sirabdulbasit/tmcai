/**
 * channelRenderer — formats a ComposeResult for the channel the user
 * is on. The composer runs ONCE per turn (same reasoning, same actions,
 * same retrieval); only the prose layer differs.
 *
 * Per user 2026-05-16: "brain chat at web and brain chat at whatsapp
 * should be the same, only the difference is whatsapp will consist
 * of to the point response (lesser in text), where web will provide
 * detail and can create dashboard."
 *
 * Channels:
 *   - 'web'      → pass-through. Full markdown answer, cites array,
 *                  gaps array, action and actionResult attached.
 *                  Frontend renders markdown + optional dashboard
 *                  panel directive.
 *   - 'whatsapp' → compress. Strip markdown formatting, drop cites
 *                  and gaps from the prose, hard-cap length, single
 *                  short paragraph. Panel directives are dropped
 *                  entirely (WA can't render them).
 *
 * Brain-rule:
 *   - The compression is content-preserving wherever possible —
 *     it doesn't summarise (that would change meaning), it strips
 *     formatting and trims length only.
 *   - When trimming, prefer the first paragraph (which is usually
 *     the answer's headline) over the trailing context.
 *   - "(no response)" placeholders pass through unchanged so the
 *     user can see Brain produced nothing rather than silently
 *     getting an empty WA message.
 */
import type { ComposeResult, ComposedAction } from './brainComposer';

export type Channel = 'web' | 'whatsapp';

/** Hard cap on a single WA message. WhatsApp accepts up to 4096
 *  but anything over ~1000 starts to feel like a memo on a phone.
 *  Day Brief specifically asks the LLM to stay ≤ 800; this cap is
 *  the renderer's safety net for non-brief replies that grew. Was 600
 *  — too tight, truncated mid-content on the day brief (calendar +
 *  2 emails, then "..."). Raised to 1000 to match the format rule
 *  ceiling with headroom. Per Basit 2026-05-20: WA brief was missing
 *  WhatsApp + Open Items + closing line because trim cut the message
 *  in the middle of the email section. */
const WA_MAX_CHARS = 1000;

/** Compress markdown to plain text suitable for WhatsApp.
 *  Removes: backtick-fenced code blocks, inline code, bold/italic
 *  markers, headers, blockquote prefixes, bullet markers.
 *  Preserves: line breaks (collapsed to single newlines), URLs in
 *  plain form (WhatsApp auto-linkifies them), the order of content. */
function stripMarkdown(s: string): string {
  if (!s) return s;
  let out = s;
  // Fenced code blocks — replace with the code content unfenced.
  out = out.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, '$1');
  // Inline code — drop the backticks, keep the content.
  out = out.replace(/`([^`]+)`/g, '$1');
  // DEF-072 — TRANSLATE emphasis to WhatsApp markup, don't discard it.
  //
  // WhatsApp has its own syntax: *bold*, _italic_, ```mono```. The old code
  // dropped every marker, so a section header arrived as an ordinary sentence
  // and a scannable brief became a wall of text. Markdown's `**bold**` does
  // render literally on WA and had to go — but converting is what was needed,
  // not deleting.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  out = out.replace(/__([^_\n]+)__/g, '*$1*');
  // Single-underscore italics map straight across; single-asterisk italics are
  // already WhatsApp bold, so they are left alone rather than guessed at.
  // Headers become a bold line — the only heading WhatsApp has.
  out = out.replace(/^#{1,6}\s+(.*)$/gm, '*$1*');
  // Blockquote prefix.
  out = out.replace(/^>\s+/gm, '');
  // Bullets — convert "- " / "* " / "1. " to "• " for readability on WA.
  out = out.replace(/^\s*[-*]\s+/gm, '• ');
  out = out.replace(/^\s*\d+\.\s+/gm, '• ');
  // Inline markdown links [text](url) → text (url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // Collapse 3+ newlines to 2 (paragraph breaks stay), trim trailing space
  // on lines, drop leading/trailing whitespace.
  out = out.replace(/\n{3,}/g, '\n\n');
  out = out.split('\n').map((l) => l.replace(/\s+$/g, '')).join('\n').trim();
  return out;
}

/** Trim to a hard char limit while preserving meaning. Cuts at the
 *  nearest sentence end before the cap when possible; otherwise at
 *  word boundary. Appends "…" only when actually truncated. */
function trimToLimit(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  // Find the last sentence-ending punctuation before max.
  const head = s.slice(0, max);
  const lastSentence = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? '),
    head.lastIndexOf('.\n'),
    head.lastIndexOf('!\n'),
    head.lastIndexOf('?\n'),
  );
  if (lastSentence > max * 0.5) {
    // Cut at sentence boundary — keeps the last punctuation mark.
    return head.slice(0, lastSentence + 1).trim() + ' …';
  }
  // Fall back to word boundary.
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace > max * 0.5) {
    return head.slice(0, lastSpace).trim() + ' …';
  }
  // Hard cut.
  return head.trim() + '…';
}

export interface RenderedForChannel {
  /** The body to display on the channel. WhatsApp gets plain text;
   *  web gets the original markdown. */
  body: string;
  /** Action emitted by composer, if any. Channels handle this
   *  differently — web shows inline buttons, WA shows a follow-up
   *  question or relies on pending-memory to resolve. */
  action: ComposedAction | null;
  /** Optional dashboard panel directive (web only). Dropped for WA. */
  panel?: PanelDirective | null;
  /** Cites and gaps — surfaced inline on web, omitted on WA. */
  cites: string[];
  gaps: string[];
}

/** Dashboard panel directive — the right-side render contract for web.
 *  Composer emits one of these when the answer benefits from a
 *  structured view (a table, a calendar strip, a contact card). */
export type PanelDirective =
  | { kind: 'open_items_list'; title: string; itemIds: string[] }
  | { kind: 'contact_card'; title: string; entityPageId: string }
  | { kind: 'calendar_week'; title: string; eventIds: string[] }
  | { kind: 'deal_summary'; title: string; dealPageId: string }
  | { kind: 'custom_table'; title: string; columns: string[]; rows: Array<Record<string, string | number | null>> };

/** Adapter for ComposeResult → channel-formatted output. */
export function renderForChannel(
  result: ComposeResult,
  channel: Channel,
  panel?: PanelDirective | null,
): RenderedForChannel {
  if (channel === 'web') {
    // Pass-through. Frontend renders markdown + cites + panel.
    return {
      body: result.answer,
      action: result.action ?? null,
      panel: panel ?? null,
      cites: result.citedPageIds ?? [],
      gaps: result.gaps ?? [],
    };
  }
  // WhatsApp: compress.
  const stripped = stripMarkdown(result.answer);
  // If the composer attached a SUCCESSFUL action_result message
  // (e.g. "Added X to your open items"), prefer that as the WA body —
  // it's the user-facing confirmation, terse by design. Critical:
  // ok===true gate. Without it, internal sentinel messages from
  // failed-action guards (e.g. 'empty_promise_blocked') leak verbatim
  // to the user as their reply. Observed 2026-05-20: Basit asked
  // "any open item?" → factual query → no action emitted → empty-
  // promise guard mis-fired → renderer surfaced the sentinel string
  // instead of the answer Brain had already composed.
  const sourceText = result.actionResult?.ok === true && result.actionResult.message?.trim()
    ? result.actionResult.message
    : stripped;
  const body = trimToLimit(sourceText, WA_MAX_CHARS);
  return {
    body,
    action: result.action ?? null,
    // Drop panel entirely on WA — no place to render it. Web-only.
    panel: null,
    // Cites/gaps don't surface inline on WA prose. They still exist
    // on the composer result for audit/logging.
    cites: [],
    gaps: [],
  };
}
