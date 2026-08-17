/**
 * DEF-194 — one transport policy, no words added, whole blocks only.
 *
 * Remediation of Codex's iteration-1 review of DEF-193. His three findings,
 * each with the test that would have caught it:
 *
 *   CRITICAL — `(+N more not shown)` was deterministic owner-facing English on
 *   a live messaging path (AGENTS.md §2.4 permits owner-facing Brain text only
 *   when LLM-generated or carried as a bracketed system marker). It is gone;
 *   the count now leaves as structured data and a test asserts the body
 *   contains no words this layer invented.
 *
 *   HIGH — an "item" was the line starting with `•`, so a wrapped bullet lost
 *   its head and left its continuation behind as an orphan while the count
 *   claimed a whole item had gone. Items are now semantic BLOCKS: continuation
 *   lines, URLs, quotations and deeper sub-bullets travel with their parent.
 *
 *   CARRIED HIGH — the ACTUAL chokepoint, `WhatsAppInbound.sendReply`, had its
 *   own blind `slice(0, 3900)` with a bare `...` and no list semantics, so the
 *   previous fix was true of `channelRenderer` and irrelevant to the owner's
 *   real traffic. Both call one policy now, and the parity test below fails if
 *   either grows its own slicing again.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fitToTransport, WA_TRANSPORT_MAX_CHARS } from '../src/services/knowledge/transportBudget';
import { renderForChannel } from '../src/services/knowledge/channelRenderer';

const MAX = WA_TRANSPORT_MAX_CHARS;
const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

function wa(answer: string): string {
  return renderForChannel(
    { answer, citedPageIds: [], gaps: [], sources: [], action: null, actionResult: null } as any,
    'whatsapp',
  ).body;
}

/** A list whose items WRAP — Codex's exact falsifier for the block model. */
function wrappedList(items: number): string {
  const head = 'Today I have sent several messages on your behalf.\n\nHere is the full list:';
  const blocks = Array.from({ length: items }, (_, i) => [
    `• *0${(i % 9) + 1}:16:* Overdue notification #${i + 1} for the ShireMe portal`,
    `  https://tracker.example.com/item/${i + 1}`,
    `  "Still waiting on the vendor," they said.`,
  ].join('\n'));
  return `${head}\n${blocks.join('\n')}`;
}

describe('DEF-194 — the transport layer adds no words (Codex CRITICAL)', () => {
  it('an omitted list carries NO invented English — the count comes back as data', () => {
    const fit = fitToTransport(wrappedList(400));

    expect(fit.truncated).toBe(true);
    expect(fit.omittedItems, 'the count is structured, for a sanctioned boundary to speak').toBeGreaterThan(0);
    // The exact string Codex ruled a §2.4 violation, and any relative of it.
    expect(fit.body).not.toContain('not shown');
    expect(fit.body).not.toMatch(/\bmore\b/i);
    expect(fit.body).not.toMatch(/\bomitted\b|\btruncated\b|\bhidden\b|\bremaining\b/i);
    expect(fit.body).not.toMatch(/\(\+\d+/);
  });

  it('the only mark the body gains is a glyph, not a sentence', () => {
    const fit = fitToTransport(wrappedList(400));
    const added = fit.body.split('\n').filter((l) => !wrappedList(400).includes(l));
    for (const line of added) {
      expect(line.trim(), `this layer invented text: ${JSON.stringify(line)}`).toBe('…');
    }
  });
});

describe('DEF-194 — items are semantic BLOCKS, not lines (Codex HIGH)', () => {
  it('a wrapped bullet is dropped WHOLE — no orphaned continuation survives', () => {
    const fit = fitToTransport(wrappedList(400));

    expect(fit.body.length).toBeLessThanOrEqual(MAX);
    const lines = fit.body.split('\n');
    // Every URL/quote line must still sit under a bullet head.
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s+(https:|")/.test(l)) {
        const parent = lines.slice(0, i).reverse().find((p) => /^\s*•/.test(p) || p.trim() === '');
        expect(parent && /^\s*•/.test(parent), `orphaned continuation at line ${i}: ${JSON.stringify(l)}`).toBe(true);
      }
    }
    // …and the count matches whole blocks, not lines.
    const keptBullets = lines.filter((l) => /^\s*•/.test(l)).length;
    expect(keptBullets + fit.omittedItems).toBe(400);
  });

  it('a deeper sub-bullet travels with its parent instead of being orphaned', () => {
    const body = ['Summary line.', '',
      ...Array.from({ length: 200 }, (_, i) => `• Parent ${i + 1} ${'x'.repeat(40)}\n  • child of ${i + 1}`),
    ].join('\n');

    const fit = fitToTransport(body);
    const lines = fit.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\s+•/.test(lines[i])) {
        expect(/^•/.test(lines[i - 1] ?? ''), `sub-bullet without its parent: ${lines[i]}`).toBe(true);
      }
    }
  });

  it('never cuts inside a line', () => {
    const fit = fitToTransport(wrappedList(400));
    const original = new Set(wrappedList(400).split('\n'));
    for (const l of fit.body.split('\n')) {
      if (l.trim() === '…' || l.trim() === '') continue;
      expect(original.has(l), `line was severed: ${JSON.stringify(l)}`).toBe(true);
    }
  });

  it('the head prose that ANSWERS the question survives', () => {
    const fit = fitToTransport(wrappedList(400));
    expect(fit.body).toContain('Today I have sent several messages on your behalf.');
  });

  it('trailing prose after the list is preserved, not swallowed with the last item', () => {
    const body = [
      'Here is what went out:',
      ...Array.from({ length: 300 }, (_, i) => `• item ${i + 1} ${'y'.repeat(30)}`),
      '',
      'Nothing else is outstanding.',
    ].join('\n');

    const fit = fitToTransport(body);
    expect(fit.body).toContain('Nothing else is outstanding.');
    expect(fit.body.length).toBeLessThanOrEqual(MAX);
  });

  it('a head that alone exceeds the budget falls back to prose trimming, never mid-word', () => {
    const head = 'This is a complete sentence about the Vision Metric integration. '.repeat(80);
    const fit = fitToTransport(`${head}\n• one\n• two`);

    expect(fit.body.length).toBeLessThanOrEqual(MAX);
    expect(fit.omittedItems, 'no item count is claimed when items were not what was dropped').toBe(0);
    const tailWord = fit.body.replace(/\s*…$/, '').trim().split(/\s+/).pop()!;
    expect(head, `mid-word cut: ${tailWord}`).toContain(tailWord);
  });
});

describe('DEF-194 — fitting is a no-op below the budget', () => {
  it('a B10-shaped answer over the OLD 1000 cap passes through untouched', () => {
    const answer = wrappedList(8);
    expect(answer.length).toBeGreaterThan(1000);
    expect(answer.length).toBeLessThan(MAX);

    const fit = fitToTransport(answer);
    expect(fit.truncated).toBe(false);
    expect(fit.omittedItems).toBe(0);
    expect(fit.body).toBe(answer);
    expect(fit.body).not.toContain('…');
  });

  it('the renderer path agrees — and web is untouched', () => {
    const answer = wrappedList(8);
    expect(wa(answer)).not.toContain('…');
    const web = renderForChannel(
      { answer, citedPageIds: [], gaps: [], sources: [], action: null, actionResult: null } as any,
      'web',
    ).body;
    expect(web).toBe(answer);
  });

  it('every rendered body respects the transport limit', () => {
    for (const n of [2, 50, 400]) {
      expect(wa(wrappedList(n)).length).toBeLessThanOrEqual(MAX);
    }
  });
});

describe('DEF-194 — ONE implementation, asserted structurally (Codex carried HIGH)', () => {
  const RENDERER = src('services/knowledge/channelRenderer.ts');
  const CHOKEPOINT = src('services/whatsapp/WhatsAppInbound.ts');

  it('both WhatsApp truncation sites call the shared policy', () => {
    expect(RENDERER).toContain('fitToTransport');
    expect(CHOKEPOINT).toContain('fitToTransport');
  });

  it('neither site keeps its own character slicer — the drift this closes', () => {
    // The chokepoint's old body: slice(0, 3900) + a bare '...'.
    expect(CHOKEPOINT).not.toContain("clean.slice(0, 3900)");
    expect(CHOKEPOINT).not.toContain("clean += '...'");
    // The renderer's old local algorithm.
    expect(RENDERER).not.toContain('function fitToChannel');
    expect(RENDERER).not.toContain('function trimProse');
    expect(RENDERER).not.toContain('not shown');
  });

  it('the budget constant has exactly one definition', () => {
    expect(RENDERER).not.toMatch(/const WA_[A-Z_]*MAX[A-Z_]* *=/);
    expect(src('services/knowledge/transportBudget.ts'))
      .toMatch(/export const WA_TRANSPORT_MAX_CHARS = 3900/);
  });
});
