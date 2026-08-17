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
// DEF-145: the ONE definition of receipt-versus-prose, in a dependency-free
// module so this renderer does not pull the composer in at runtime.
import { receiptWins } from './answerReceiptPolicy';

export type Channel = 'web' | 'whatsapp';

/**
 * DEF-193 — TWO DIFFERENT DECISIONS used to live in this one number, and that
 * is why raising it never worked.
 *
 * The history is in the file: the cap was 600, it "truncated mid-content on
 * the day brief (calendar + 2 emails, then '...')", Basit reported the brief
 * arriving with sections missing, and it was raised to 1000. **It recurred at
 * 1000** — benchmark B10 ("What have you sent on my behalf today?") answered
 * with "Here is the full list:" followed by nine bullets and a bare "…",
 * scoring C6 80: *"starts by promising a 'full list' and then ends with an
 * ellipsis"*. Raising the number a third time is a patch on the reported
 * instance, which CLAUDE.md rule 5 forbids for a recurring class.
 *
 * The two decisions, separated:
 *
 *   1. **BREVITY is a composition decision.** How much to say belongs where
 *      the meaning is known — the composer and its format rules (Day Brief
 *      still asks for ≤ 800). The renderer has no idea which sentence matters,
 *      so a renderer that shortens for taste is guessing with a knife.
 *   2. **The TRANSPORT limit is a channel decision**, and it is the only limit
 *      the renderer actually knows: Meta rejects a body over 4096 characters
 *      (`whatsappService.ts:363`, `whatsappNotifierService.ts:99` both clamp
 *      there). That is what this constant now is, with headroom for anything
 *      appended downstream.
 *
 * So the renderer stops cutting answers for style and only guarantees the
 * message is transportable — and when it must shorten, `fitToChannel` does it
 * without falsifying the answer (see below).
 */
const WA_TRANSPORT_MAX_CHARS = 3900;

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

/** A rendered list item — `stripMarkdown` has already normalised every
 *  bullet form to "• ", so this is the one shape to recognise. */
function isItemLine(line: string): boolean {
  return /^\s*•/.test(line);
}

function lastItemIndex(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (isItemLine(lines[i])) return i;
  return -1;
}

/**
 * Prose fallback: cut at a sentence end, else a word boundary, never
 * mid-word. An ellipsis after a COMPLETE sentence is a conventional
 * "there was more" and states nothing false, which is why it survives here
 * and does not survive inside a list (see `fitToChannel`).
 */
function trimProse(s: string, max: number): string {
  // The ellipsis is part of the message, so its room is reserved BEFORE the
  // cut. The previous version appended it after slicing to `max` and could
  // return max+1 characters — harmless against the old 1000 but not against a
  // real transport limit, where one character over is a rejected send.
  const SUFFIX = ' …';
  const budget = Math.max(1, max - SUFFIX.length);
  const head = s.slice(0, budget);
  const lastSentence = Math.max(
    head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '),
    head.lastIndexOf('.\n'), head.lastIndexOf('!\n'), head.lastIndexOf('?\n'),
  );
  if (lastSentence > budget * 0.5) return head.slice(0, lastSentence + 1).trim() + SUFFIX;
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace > budget * 0.5) return head.slice(0, lastSpace).trim() + SUFFIX;
  return head.trim() + SUFFIX;
}

/**
 * DEF-193 — fit a body to the channel WITHOUT falsifying it.
 *
 * The defect this replaces was not "the cap was too small". It was that a
 * character-counting cut severed a LIST mid-item, leaving the prose above it
 * ("Here is the full list:") asserting a completeness the body no longer had.
 * A protection turned a true answer into a false one — the
 * `guard-destroys-the-answer` shape at the render boundary.
 *
 * So shortening is now structural, and it is honest about itself:
 *
 *   - **whole items only.** Trailing "• " lines are dropped entire. The owner
 *     never reads half a fact, and never reads half an item's name.
 *   - **the omission is counted, not implied.** A dropped-item body carries
 *     `(+N more not shown)` — a true statement of exactly what happened, in
 *     place of a bare "…" that silently contradicted the sentence above it.
 *     It asks nothing of the owner and promises no follow-up (invariant #5),
 *     and it is a rendering artifact in the same category as the "…" it
 *     replaces, not new Brain prose. **Flagged for the reviewer** as the one
 *     judgement call in this change: if Codex reads a parenthetical count as
 *     owner-facing deterministic prose under invariant #4, the alternative is
 *     the sanctioned marker path, which today only carries WHOLE-answer
 *     markers and would need extending.
 *   - **prose keeps the old behaviour**, because a sentence-boundary ellipsis
 *     asserts nothing untrue.
 *   - the head prose is never dropped: it is what answers the question.
 */
function fitToChannel(s: string, max: number): string {
  if (!s || s.length <= max) return s;

  const lines = s.split('\n');
  // One bullet cannot be "a list that lost items" in any meaningful sense, so
  // the structural path needs at least two.
  if (lines.filter(isItemLine).length >= 2) {
    const kept = [...lines];
    let dropped = 0;
    for (;;) {
      const notice = dropped > 0 ? `\n(+${dropped} more not shown)` : '';
      const candidate = kept.join('\n').trim() + notice;
      if (candidate.length <= max) return candidate;
      const li = lastItemIndex(kept);
      if (li < 0) break;            // no items left to drop — fall to prose
      kept.splice(li, 1);
      dropped++;
    }
  }
  return trimProse(s, max);
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
  //
  // DEF-145 — the preference is now the other way round, and this is the line
  // that actually decides what the owner reads. It used to hand the receipt to
  // WhatsApp whenever an action succeeded, which meant every successful action
  // answered the owner in field names. It is also why DEF-144 measured as a
  // no-op: that change kept Brain's prose inside `compose`, and this line put
  // the receipt straight back. B04's benchmark reply was byte-identical across
  // iterations 06 and 07 — 94 chars of `Updated "…": priority=high.` — while
  // the composer log for the same turn shows the model had said "Got it. I've
  // marked that as high priority. Still needs a due date if you have one."
  //
  // The two things the substitution was protecting both survive. The
  // `ok === true` gate stays exactly as it was, for the 2026-05-20 sentinel
  // leak described above. And `brainAnswerSurvivesReceipt` — the one shared
  // definition, in `answerReceiptPolicy` — keeps the receipt whenever the
  // prose is a marker, a stub, or makes a completion claim the outcome does
  // not support. Fail-closed: if it cannot justify the prose, the receipt wins.
  //
  // `compose` has already applied the same policy to `result.answer`, so this
  // is a second, independent chance to fall back rather than a second opinion
  // about which text is better.
  // DEF-154 — the token is bound to the RAW answer the composer verified, so the
  // binding check must be given that, not the markdown-stripped body. Passing
  // `stripped` here would fail the comparison on any answer containing markdown
  // and silently revert it to the receipt — safe, but wrong for the wrong reason.
  const sourceText = receiptWins(result.actionResult, result.answer)
    ? (result.actionResult!.message as string)
    : stripped;
  // DEF-193 — the renderer guarantees transportability, not brevity. Brevity
  // is the composer's decision, made where the meaning is known.
  const body = fitToChannel(sourceText, WA_TRANSPORT_MAX_CHARS);
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
