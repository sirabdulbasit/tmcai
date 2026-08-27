/**
 * The Comm image seam — image reading is a COMMUNICATION capability, not a WhatsApp feature.
 *
 * Owner, 2026-08-24: *"since i have the quickest comm is whatsapp and i am analyzing brain
 * through it, but it not limit with whatsapp it should cover all aspects of communications"*.
 *
 * The reason image reading was WhatsApp-only was never that `describeInboundImage` knew
 * anything about WhatsApp — it takes bytes and a mimetype. It was that the function had exactly
 * ONE caller in the whole codebase. `readCommImageIntoText` is the seam that stops the next
 * channel from copy-pasting the WhatsApp version, so what it guarantees is what every channel
 * will inherit. These assertions pin those guarantees, one per rule:
 *
 *   1. contents are folded into the text under the bracketed marker Brain already renders
 *   2. a caption LEADS — what the person wrote outranks what the picture contains
 *   3. a failure is SAID, never returned as empty text
 *
 * Rule 3 is the one with a real incident behind it. On the owner's own WhatsApp an unread image
 * produced an empty body, and the `length < 2` guard in the self-dictation path returned
 * silently: no reply, no marker, no log line. A bug you cannot even report is worse than a
 * refusal, so the seam must never hand back "".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateContent = vi.fn();
vi.mock('../src/services/genaiClient', () => ({
  getGenAI: () => ({ models: { generateContent: (...a: any[]) => generateContent(...a) } }),
}));

// DEF-250 turn repair — this suite shipped RED (b97225f): the two failure-path
// tests mocked Gemini but NOT the OpenAI FALLBACK `describeInboundImage` runs
// when Gemini returns empty/throws — so a REAL OpenAI client was constructed
// in a unit test and hung to the 10s timeout (SDK retries, no key). The
// fallback now fails FAST, which is exactly the state the two tests mean to
// exercise: both providers failed, the seam must still SAY so.
vi.mock('openai', () => ({
  __esModule: true,
  default: class {
    chat = { completions: { create: async () => { throw new Error('no vision provider in unit tests'); } } };
  },
}));

import { readCommImageIntoText } from '../src/services/imageService';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

describe('readCommImageIntoText — the contract every Comm channel inherits', () => {
  beforeEach(() => {
    generateContent.mockReset();
    process.env.GEMINI_API_KEY = 'test-key';
  });

  it('folds the contents in under the marker Brain already knows how to render', async () => {
    generateContent.mockResolvedValue({ text: 'A bank transfer receipt for PKR 45,000.' });
    const out = await readCommImageIntoText(PNG, 'image/png');
    expect(out).toContain('[image received — contents:]');
    expect(out).toContain('A bank transfer receipt for PKR 45,000.');
  });

  it('lets the caption LEAD, because it is what the person actually asked', async () => {
    generateContent.mockResolvedValue({ text: 'A bank transfer receipt.' });
    const out = await readCommImageIntoText(PNG, 'image/png', 'is this the one you meant?');
    expect(out.indexOf('is this the one you meant?'))
      .toBeLessThan(out.indexOf('[image received — contents:]'));
  });

  it('SAYS a failure instead of returning empty text — the silent-drop incident', async () => {
    generateContent.mockResolvedValue({ text: '' });
    const out = await readCommImageIntoText(PNG, 'image/png');
    expect(out.trim()).not.toBe('');
    expect(out).toMatch(/^\[/);            // a bracketed marker, not prose
  });

  it('says the failure even when the provider throws, and keeps the caption', async () => {
    generateContent.mockRejectedValue(new Error('vision provider exploded'));
    const out = await readCommImageIntoText(PNG, 'image/png', 'what does this say?');
    expect(out).toContain('what does this say?');
    expect(out.trim()).not.toBe('');
    expect(out).not.toContain('vision provider exploded');   // never leak provider internals
  });

  it('is channel-neutral: identical bytes give identical text regardless of caller', async () => {
    generateContent.mockResolvedValue({ text: 'An invoice.' });
    const viaWhatsapp = await readCommImageIntoText(PNG, 'image/png');
    generateContent.mockResolvedValue({ text: 'An invoice.' });
    const viaEmail = await readCommImageIntoText(PNG, 'image/png');
    expect(viaEmail).toBe(viaWhatsapp);
  });
});
