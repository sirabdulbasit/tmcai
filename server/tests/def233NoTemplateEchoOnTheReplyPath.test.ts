/**
 * DEF-233 — a model that echoes is a template with a bill attached.
 *
 * Owner, 2026-08-19: "the way brain respond to me, feels like not through LLM" and then
 * "don't use any template string, always respond through model."
 *
 * He was right about the feeling and the code explains it. The marker-voice path DOES call
 * the model — 305 successful calls in 14 days, zero failures — but it hands over a finished
 * curated sentence with the instruction "say what it says", and the model returned that
 * sentence BYTE-FOR-BYTE 19 times out of 21. Indistinguishable from a template on his
 * screen, and more expensive.
 *
 * What is deliberately NOT changed: the curated sentence remains the only source of FACT.
 * That is the anti-fabrication guarantee this file has been fighting for since DEF-169 —
 * letting the model invent what happened is the defect class, not the fix. Only the phrasing
 * is the model's to choose.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const callLLM = vi.fn();
vi.mock('../src/services/llmRouter', () => ({ callLLM: (...a: any[]) => callLLM(...a) }));

const CURATED = "I didn't run anything just now, so I can't tell you it's done."
  + ' Let me check what has already happened before I act — say "go ahead" and I\'ll verify first.';

describe('DEF-233 — echoRatio', () => {
  it('scores a verbatim copy as a full echo', async () => {
    const { echoRatio } = await import('../src/services/knowledge/markerVoice');
    expect(echoRatio(CURATED, CURATED)).toBe(1);
  });

  it('scores a genuine rewrite low, even though the facts survive', async () => {
    const { echoRatio } = await import('../src/services/knowledge/markerVoice');
    const rewrite = 'Nothing went out on my side a moment ago. Before I touch your open items,'
      + ' let me confirm which of them are still there.';
    expect(echoRatio(CURATED, rewrite)).toBeLessThan(0.5);
  });

  it('is not fooled by punctuation or capitalisation changes', async () => {
    const { echoRatio } = await import('../src/services/knowledge/markerVoice');
    const cosmetic = CURATED.replace(/,/g, '').replace(/—/g, '-').toUpperCase();
    expect(echoRatio(CURATED, cosmetic)).toBeGreaterThanOrEqual(0.85);
  });
});

describe('DEF-233 — the reply path retries an echo', () => {
  beforeEach(() => { callLLM.mockReset(); });

  it('retries once when the model copies the sentence back, and uses the rewrite', async () => {
    const rewrite = 'Nothing actually went out a moment ago, Sir. Let me look at what is still'
      + ' on your list before I remove anything.';
    callLLM
      .mockResolvedValueOnce({ text: CURATED, provider: 'gemini' })   // the echo
      .mockResolvedValueOnce({ text: rewrite, provider: 'gemini' });  // the retry
    const { renderMarkerInBrainVoice } = await import('../src/services/knowledge/markerVoice');
    const out = await renderMarkerInBrainVoice(CURATED, { userMessage: 'yes delete all' });
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(out).toBe(rewrite);
    // The retry must be told WHY it is being asked again, or it repeats itself.
    expect(String(callLLM.mock.calls[1][0])).toMatch(/copied the marker's wording/i);
  });

  it('does NOT retry a SHORT curated phrase — there is no other way to say it', async () => {
    // "Got it — noted." has two content words, so any acknowledgement scores as a full echo.
    // Retrying it buys a second model call for a phrase with no alternative form, on every
    // single acknowledgement Brain makes.
    callLLM.mockResolvedValue({ text: 'Got it, noted that down.', provider: 'gemini' });
    const { renderMarkerInBrainVoice } = await import('../src/services/knowledge/markerVoice');
    const out = await renderMarkerInBrainVoice('Got it — noted.', {});
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(out).toBe('Got it, noted that down.');
  });

  it('does NOT retry when the model already spoke in its own words', async () => {
    const good = 'Nothing ran a moment ago — let me check your list first.';
    callLLM.mockResolvedValueOnce({ text: good, provider: 'gemini' });
    const { renderMarkerInBrainVoice } = await import('../src/services/knowledge/markerVoice');
    const out = await renderMarkerInBrainVoice(CURATED, {});
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(out).toBe(good);
  });

  it('keeps a second echo rather than shipping silence', async () => {
    // The fact is still true. A vague fallback or an empty reply is worse than a
    // plainly-worded truth, which is the whole lesson of the 77 markers stripped to silence.
    callLLM.mockResolvedValue({ text: CURATED, provider: 'gemini' });
    const { renderMarkerInBrainVoice } = await import('../src/services/knowledge/markerVoice');
    const out = await renderMarkerInBrainVoice(CURATED, {});
    expect(out).toBe(CURATED);
    expect(out).not.toBe('');
  });

  it('falls back to plain wording when the model is unavailable — never throws', async () => {
    callLLM.mockRejectedValue(new Error('provider down'));
    const { renderMarkerInBrainVoice } = await import('../src/services/knowledge/markerVoice');
    const out = await renderMarkerInBrainVoice('[no action dispatched]', {});
    expect(out).toBeTruthy();
    expect(out).not.toContain('[');
  });

  it('the system prompt demands the model rebuild the sentence, not copy it', async () => {
    callLLM.mockResolvedValueOnce({ text: 'Nothing ran; let me check.', provider: 'gemini' });
    const { renderMarkerInBrainVoice } = await import('../src/services/knowledge/markerVoice');
    await renderMarkerInBrainVoice(CURATED, {});
    const sys = String(callLLM.mock.calls[0][0]);
    expect(sys).toMatch(/YOUR OWN WORDS/);
    // And the fact-only guarantee must survive the change.
    expect(sys).toMatch(/ONLY source of fact/i);
  });
});
