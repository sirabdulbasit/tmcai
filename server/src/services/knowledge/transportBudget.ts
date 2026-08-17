/**
 * transportBudget — THE one place that decides how a body is made to fit a
 * channel's transport limit.
 *
 * ── WHY THIS MODULE EXISTS (DEF-194, Codex iteration-1 review) ──────────────
 *
 * There were two independent truncators on the WhatsApp path and they
 * disagreed about everything:
 *
 *   - `channelRenderer.fitToChannel` — list-aware, appended an English
 *     `(+N more not shown)`;
 *   - `WhatsAppInbound.sendReply` — the ACTUAL chokepoint (its own comment:
 *     *"EVERY reply to a human goes through sendReply, so every reply is
 *     rendered here and nowhere else"*), a blind `slice(0, 3900)` that could
 *     append a bare `...` and had no list semantics at all.
 *
 * That is `protection-with-two-implementations` (10 recorded occurrences) on
 * the owner's live messaging path, and it is why the previous turn's fix could
 * be true of `channelRenderer` and irrelevant to what the owner received. Both
 * call this now, and `def194OneTransportBudget.test.ts` fails if either grows
 * its own slicing again.
 *
 * ── TWO RULES, AND THEY ARE THE WHOLE DESIGN ────────────────────────────────
 *
 * **1. This layer adds NO WORDS.** Codex's iteration-1 CRITICAL, and he is
 * right: `(+N more not shown)` was deterministic owner-facing English on a live
 * messaging path, which AGENTS.md §2.4 permits only when LLM-generated or
 * carried as a bracketed system marker. Transport metadata gets no exception.
 * So the count leaves here as STRUCTURED DATA (`omittedItems`) for a caller
 * that can route it through the sanctioned boundary, and the body itself gains
 * at most an ellipsis — a glyph, not a sentence, and the same one this code
 * already used.
 *
 * **2. Shortening moves whole SEMANTIC BLOCKS, never lines and never
 * characters.** Codex's iteration-1 HIGH: the previous version defined an item
 * as "the line starting with •", so a bullet that wrapped onto a continuation
 * line — a URL, an address, a quotation, a nested sub-bullet — had its head
 * deleted while the continuation stayed behind as an orphaned fragment, with
 * the omission count claiming one whole item had gone. A fact detached from its
 * subject is `guard-destroys-the-answer` wearing a different hat.
 *
 * A BLOCK is therefore: an item line, plus every following line that belongs to
 * it — any non-blank line that is not a peer item, and any item line indented
 * DEEPER than it (a sub-bullet belongs to its parent, so dropping the parent
 * takes its children with it rather than orphaning them).
 *
 * The head prose above the list and the tail after it are structural, not
 * droppable: the head is what answers the question. Only when head+tail alone
 * exceed the budget does this fall back to prose trimming, and that is stated
 * rather than hidden.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ───────────────────────────────
 *
 * It does not repair a completeness claim. If the composer wrote "here is the
 * full list" and the list is then shortened, the claim is still false, and no
 * amount of transport cleverness can fix that from down here — the fix is for
 * composition to know the budget BEFORE it promises (Codex's directive 3).
 * That is recorded as an open limitation in DEF-194 rather than papered over.
 */

/** Meta rejects a WhatsApp body over 4096 characters; this leaves headroom. */
export const WA_TRANSPORT_MAX_CHARS = 3900;

export interface TransportFit {
  /** The body to send. Never longer than the budget. */
  body: string;
  /** True when anything at all was removed. */
  truncated: boolean;
  /**
   * How many whole list items were removed. Structured, so a caller that owns
   * a sanctioned owner-facing boundary can say so in Brain's voice; this
   * module never says it itself.
   */
  omittedItems: number;
}

/** Matches a rendered list item at any indent. Both upstream markdown
 *  strippers normalise `-`/`*` bullets to `•`. */
const ITEM_RE = /^(\s*)•/;

function itemIndent(line: string): number | null {
  const m = ITEM_RE.exec(line);
  return m ? m[1].length : null;
}

interface Parsed {
  head: string[];
  blocks: string[][];
  tail: string[];
}

/**
 * Split a body into head prose, list blocks, and trailing prose.
 *
 * A blank line after the list closes it: everything from there on is tail and
 * is preserved. A blank line INSIDE a block (before a continuation) also
 * closes the list, which is the conservative reading — it means fewer lines are
 * treated as droppable, never more.
 */
function parseBlocks(lines: readonly string[]): Parsed {
  const firstItem = lines.findIndex((l) => itemIndent(l) !== null);
  if (firstItem < 0) return { head: [...lines], blocks: [], tail: [] };

  const head = lines.slice(0, firstItem);
  const blocks: string[][] = [];
  let tailStart = lines.length;
  let baseIndent: number | null = null;

  for (let i = firstItem; i < lines.length; i++) {
    const line = lines[i];
    const indent = itemIndent(line);

    if (line.trim() === '') { tailStart = i; break; }   // blank line closes the list

    if (indent !== null && (baseIndent === null || indent <= baseIndent)) {
      // A peer item (or the first one) starts a new block.
      baseIndent = baseIndent === null ? indent : Math.min(baseIndent, indent);
      blocks.push([line]);
      continue;
    }
    // Anything else — wrapped text, a URL, a quotation, a deeper sub-bullet —
    // belongs to the block above it.
    if (blocks.length === 0) { tailStart = i; break; }
    blocks[blocks.length - 1].push(line);
  }

  return { head, blocks, tail: lines.slice(tailStart) };
}

/**
 * Prose fallback: cut at a sentence end, else a word boundary, never mid-word.
 * The ellipsis's room is reserved BEFORE the cut — the previous version
 * appended it after slicing to `max` and could return max+1 characters, which
 * is harmless against a self-imposed cap and a rejected send against a real
 * transport limit.
 */
function trimProse(s: string, max: number): string {
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
 * Fit `text` to `max` characters. See the module header for the two rules:
 * no words are added, and shortening removes whole semantic blocks.
 */
export function fitToTransport(text: string, max: number = WA_TRANSPORT_MAX_CHARS): TransportFit {
  if (!text || text.length <= max) {
    return { body: text ?? '', truncated: false, omittedItems: 0 };
  }

  const lines = text.split('\n');
  const { head, blocks, tail } = parseBlocks(lines);

  // Two or more blocks is what makes "a list that lost items" meaningful. One
  // oversized bullet is prose as far as this decision goes.
  if (blocks.length >= 2) {
    // The ellipsis marks that something was removed. A glyph, not a sentence:
    // the COUNT travels in `omittedItems` for a caller that owns a sanctioned
    // owner-facing boundary.
    const MARK = '…';
    for (let keep = blocks.length - 1; keep >= 1; keep--) {
      const kept = [
        ...head,
        ...blocks.slice(0, keep).flat(),
        MARK,
        ...tail,
      ];
      const candidate = kept.join('\n').trim();
      if (candidate.length <= max) {
        return { body: candidate, truncated: true, omittedItems: blocks.length - keep };
      }
    }
  }

  // Head+tail alone exceed the budget (or there is no list): prose trimming is
  // the only honest option left, and it never cuts mid-word.
  return { body: trimProse(text, max), truncated: true, omittedItems: 0 };
}
