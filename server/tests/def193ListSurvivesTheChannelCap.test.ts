/**
 * DEF-193 — the channel cap stops falsifying the answer.
 *
 * Benchmark B10, "What have you sent on my behalf today?", answered with
 * "Here is the full list:" then nine bullets then a bare "…". The judge scored
 * C6 80: *"starts by promising a 'full list' and then ends with an ellipsis,
 * indicating that the list is not actually complete"*, and C1 90 for the same
 * contradiction. The answer was TRUE when the composer wrote it; a
 * character-counting cut at the render boundary made it false.
 *
 * This is `guard-destroys-the-answer` at the renderer, and it is CIRCLING: the
 * same defect is recorded in the cap's own comment — 600 severed the day brief
 * mid-section, Basit reported it, and it was raised to 1000. It recurred at
 * 1000. So the mechanism changes rather than the number:
 *
 *   1. the renderer enforces the TRANSPORT limit (Meta's 4096, with headroom),
 *      not a taste-based brevity cap it has no information to apply;
 *   2. shortening drops WHOLE items and states the omission count, so no
 *      sentence is left asserting a completeness the body lost.
 */
import { describe, it, expect } from 'vitest';
import { renderForChannel } from '../src/services/knowledge/channelRenderer';

function wa(answer: string): string {
  return renderForChannel(
    { answer, citedPageIds: [], gaps: [], sources: [], action: null, actionResult: null } as any,
    'whatsapp',
  ).body;
}

/** B10's real shape: a completeness claim, then a bulleted list. */
function listAnswer(itemCount: number, itemBody = 'Overdue notification for "ShireMe Recruiting Portal Application Testing"'): string {
  const head = 'Today, August 17th, I have sent several WhatsApp messages on your behalf.\n\nHere is the full list:';
  const items = Array.from({ length: itemCount }, (_, i) => `• *0${(i % 9) + 1}:16:* ${itemBody} #${i + 1}.`);
  return `${head}\n${items.join('\n')}`;
}

describe('DEF-193 — B10\'s answer is no longer severed by the renderer', () => {
  it('a B10-shaped answer OVER the old cap now passes through WHOLE — no ellipsis, every item intact', () => {
    const answer = listAnswer(12);
    expect(answer.length, 'over the old 1000-char guillotine, which is what severed B10')
      .toBeGreaterThan(1000);

    const body = wa(answer);

    expect(body, 'nothing was truncated').not.toContain('…');
    expect(body).not.toContain('not shown');
    expect(body).toContain('#12.');          // the last item survived
    expect(body).toContain('Here is the full list:');
  });

  it('a list that genuinely exceeds the transport limit loses WHOLE items, never half of one', () => {
    const body = wa(listAnswer(400)); // far past 3900 chars

    expect(body.length).toBeLessThanOrEqual(3900);
    const itemLines = body.split('\n').filter((l) => l.startsWith('•'));
    expect(itemLines.length).toBeGreaterThan(0);
    for (const line of itemLines) {
      expect(line, `item cut mid-content: ${JSON.stringify(line)}`).toMatch(/#\d+\.$/);
    }
  });

  it('the omission is COUNTED, not implied by a bare ellipsis', () => {
    const body = wa(listAnswer(400));

    expect(body).toMatch(/\(\+\d+ more not shown\)$/);
    expect(body, 'the misleading bare ellipsis is gone from list truncation').not.toContain('…');

    const shown = body.split('\n').filter((l) => l.startsWith('•')).length;
    const claimed = Number(/\(\+(\d+) more not shown\)/.exec(body)![1]);
    expect(shown + claimed, 'the count is arithmetically true, not decorative').toBe(400);
  });

  it('the prose that ANSWERS the question is never what gets dropped', () => {
    const body = wa(listAnswer(400));
    expect(body).toContain('I have sent several WhatsApp messages on your behalf');
  });

  it('the notice asks nothing of the owner and promises no follow-up (invariant #5)', () => {
    const body = wa(listAnswer(400));
    const notice = /\(\+\d+ more not shown\)/.exec(body)![0];
    expect(notice).not.toMatch(/\bI(?:'| w|’)|\bwill\b|\breply\b|\bask\b|\blet me\b/i);
  });

  it('long PROSE with no list keeps the conventional sentence-boundary ellipsis', () => {
    // An ellipsis after a complete sentence says "there was more" and asserts
    // nothing false, so this behaviour is deliberately unchanged.
    const sentence = 'This is a complete sentence about the Vision Metric integration. ';
    const body = wa(sentence.repeat(120));

    expect(body.length).toBeLessThanOrEqual(3900);
    expect(body).toContain('…');
    expect(body).not.toContain('not shown');
    expect(body.replace(/\s*…$/, '').trim().endsWith('.'), 'cut at a sentence end').toBe(true);
  });

  it('a single bullet is not treated as a list that lost items', () => {
    const body = wa(`Here is what I found:\n• ${'x'.repeat(4200)}`);
    expect(body.length).toBeLessThanOrEqual(3900);
    expect(body).not.toContain('not shown');
  });

  it('web is untouched — the cap is a WhatsApp transport concern only', () => {
    const answer = listAnswer(400);
    const web = renderForChannel(
      { answer, citedPageIds: [], gaps: [], sources: [], action: null, actionResult: null } as any,
      'web',
    ).body;
    expect(web).toBe(answer);
  });
});
