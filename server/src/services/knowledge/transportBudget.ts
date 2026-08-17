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

/**
 * DEF-195 (Codex iteration-2 HIGH #2) — a body is a SEQUENCE of segments, not
 * "a head, the first list, and an opaque tail".
 *
 * The previous parser stopped permanently at the first blank line after the
 * first list, which is wrong for the shape the owner actually receives most
 * often: a Day Brief with Calendar bullets, a blank line, Email bullets,
 * another blank line, Open Items bullets. Everything after the first section
 * became undroppable `tail`, so fitting either deleted Calendar facts merely
 * for occurring FIRST, or gave up and character-trimmed the whole body —
 * losing the block guarantee this module exists to provide.
 *
 * Now every line lands in exactly one segment:
 *
 *   - `item`  — a bullet plus everything belonging to it: wrapped text, a URL,
 *               a quotation, and any DEEPER bullet (a child travels with its
 *               parent rather than being orphaned).
 *   - `prose` — anything else, including blank lines and section headings.
 *
 * Only `item` segments are droppable, and they are dropped from the END, so
 * removal is positional and explainable rather than "whichever list came
 * first". Prose is never dropped — except a heading left with nothing beneath
 * it, which would otherwise read as an empty section.
 */
type Segment =
  | { kind: 'prose'; lines: string[] }
  | { kind: 'item'; lines: string[] };

/**
 * A section heading, for the one prose case that must not survive alone.
 *
 * The WhatsApp-rendered form is `*Calendar:*` — `stripMarkdown` turns a
 * markdown heading into a bold line — so the emphasis markers come off before
 * the colon test. The first version of this checked `endsWith(':')` on the raw
 * line and therefore matched no real Day Brief heading at all, which the
 * empty-section test caught.
 */
function isHeadingLike(seg: Segment): boolean {
  if (seg.kind !== 'prose') return false;
  const t = seg.lines.join(' ').trim().replace(/^[*_~]+|[*_~]+$/g, '').trim();
  return t.length > 0 && t.endsWith(':');
}

function parseSegments(lines: readonly string[]): Segment[] {
  const segments: Segment[] = [];
  let openItemIndent: number | null = null;

  for (const line of lines) {
    const indent = itemIndent(line);

    if (indent !== null) {
      if (openItemIndent !== null && indent > openItemIndent) {
        // A deeper bullet belongs to the item above it.
        segments[segments.length - 1].lines.push(line);
        continue;
      }
      segments.push({ kind: 'item', lines: [line] });
      openItemIndent = indent;
      continue;
    }

    if (line.trim() === '') {
      // A blank line closes the current item run and is itself prose, so
      // section boundaries survive and the NEXT list is parsed too.
      openItemIndent = null;
      segments.push({ kind: 'prose', lines: [line] });
      continue;
    }

    if (openItemIndent !== null) {
      // Wrapped continuation of the open item.
      segments[segments.length - 1].lines.push(line);
      continue;
    }
    segments.push({ kind: 'prose', lines: [line] });
  }

  return segments;
}

/**
 * Render a retained set of segments, inserting the removal mark exactly where
 * content was dropped, and shedding a heading that no longer has any item
 * under it.
 */
function renderSegments(segments: readonly Segment[], dropFrom: number, mark: string): string {
  const kept: Array<{ seg: Segment; index: number }> = [];
  let markInserted = false;
  const out: string[] = [];

  segments.forEach((seg, index) => {
    if (seg.kind === 'item' && index >= dropFrom) {
      if (!markInserted) { kept.push({ seg: { kind: 'prose', lines: [mark] }, index }); markInserted = true; }
      return;
    }
    kept.push({ seg, index });
  });

  // A heading with no retained item before the next heading (or the end) would
  // announce an empty section, so it goes with its items.
  const survives = kept.map(({ seg }, i) => {
    if (!isHeadingLike(seg)) return true;
    for (let j = i + 1; j < kept.length; j++) {
      if (kept[j].seg.kind === 'item') return true;
      if (isHeadingLike(kept[j].seg)) return false;
    }
    return false;
  });

  kept.forEach(({ seg }, i) => { if (survives[i]) out.push(...seg.lines); });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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

  const segments = parseSegments(text.split('\n'));
  const itemIdx = segments.reduce<number[]>((acc, s, i) => (s.kind === 'item' ? [...acc, i] : acc), []);

  // Two or more items is what makes "a list that lost items" meaningful. One
  // oversized bullet is prose as far as this decision goes.
  if (itemIdx.length >= 2) {
    // The mark records that something was removed. A glyph, not a sentence:
    // the COUNT travels in `omittedItems` for a caller that owns a sanctioned
    // owner-facing boundary (this module never speaks in Brain's voice).
    const MARK = '\u2026';
    // Drop from the END, keeping at least one item, so removal is positional
    // and never "whichever section happened to come first".
    for (let keep = itemIdx.length - 1; keep >= 1; keep--) {
      const dropFrom = itemIdx[keep];
      const candidate = renderSegments(segments, dropFrom, MARK);
      if (candidate.length <= max) {
        return { body: candidate, truncated: true, omittedItems: itemIdx.length - keep };
      }
    }
  }

  // Prose alone exceeds the budget (or there is no list): prose trimming is the
  // only honest option left, and it never cuts mid-word.
  return { body: trimProse(text, max), truncated: true, omittedItems: 0 };
}
