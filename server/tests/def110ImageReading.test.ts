/**
 * DEF-110 — Brain can read an image.
 *
 * Asked four times across two days:
 *   08-08 16:27  "can you read the image if I send you any kind of image here?"
 *                -> "Honest answer, Sir: no. I can only process text and voice
 *                    notes right now, not images or other files."
 *   08-08 16:27  "So improve your capability so you can also read image if I send"
 *   08-10 16:26  "can you read the image?"
 *   08-10 16:38  "can i send image now for you read?"
 *
 * The refusal was honest and correct at the time. Everything needed already
 * existed: media download is the path voice notes arrive on, gemini-2.5-flash
 * already takes media as inlineData, and messageType already had 'image'.
 *
 * The assertions that matter are about the PROMPT, because the description is
 * fed to Brain as observed input. A vision model that speculates would inject
 * inference into a block the no-fabrication rule treats as ground truth.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const generateContent = vi.fn();
vi.mock('../src/services/genaiClient', () => ({
  getGenAI: () => ({ models: { generateContent: (...a: any[]) => generateContent(...a) } }),
}));

import { describeInboundImage, imageReadFailureMarker } from '../src/services/imageService';

const IMG = Buffer.from('fake-png-bytes');

beforeEach(() => {
  generateContent.mockReset();
  process.env.GEMINI_API_KEY = 'test-key';
  delete process.env.OPENAI_API_KEY;
});

describe('it reads an image', () => {
  it('returns the description and names the provider', async () => {
    generateContent.mockResolvedValue({ text: 'A WhatsApp thread showing three messages from Hamna.' });
    const r = await describeInboundImage(IMG, 'image/jpeg');
    expect(r.provider).toBe('gemini');
    expect(r.text).toContain('Hamna');
  });

  it('passes the image as inlineData with a clean mime type', async () => {
    generateContent.mockResolvedValue({ text: 'x' });
    await describeInboundImage(IMG, 'image/jpeg; codecs=foo');
    const call = generateContent.mock.calls[0][0];
    const parts = call.contents[0].parts;
    // Gemini rejects mime mismatches — the audio path learned this already.
    expect(parts[1].inlineData.mimeType).toBe('image/jpeg');
    expect(parts[1].inlineData.data).toBe(IMG.toString('base64'));
  });

  it('gives screenshots room — a truncated transcript is DEF-093 in a new place', async () => {
    generateContent.mockResolvedValue({ text: 'x' });
    await describeInboundImage(IMG, 'image/png');
    expect(generateContent.mock.calls[0][0].config.maxOutputTokens).toBeGreaterThanOrEqual(2000);
  });
});

describe('the prompt must not let the model speculate', () => {
  it('demands verbatim text transcription — screenshots are the common case', async () => {
    generateContent.mockResolvedValue({ text: 'x' });
    await describeInboundImage(IMG, 'image/png');
    const prompt = generateContent.mock.calls[0][0].contents[0].parts[0].text;
    expect(prompt).toMatch(/VERBATIM/);
    expect(prompt).toMatch(/names, numbers, dates and amounts exactly/i);
  });

  it('forbids inferring intent or urgency', async () => {
    generateContent.mockResolvedValue({ text: 'x' });
    await describeInboundImage(IMG, 'image/png');
    const prompt = generateContent.mock.calls[0][0].contents[0].parts[0].text;
    expect(prompt).toMatch(/Do NOT speculate about intent, urgency/i);
    expect(prompt).toMatch(/say so explicitly rather than guessing/i);
  });
});

describe('failures are honest, never invented', () => {
  it('returns empty with a reason when the provider errors', async () => {
    generateContent.mockImplementation(() => Promise.reject(new Error('vision 500')));
    const r = await describeInboundImage(IMG, 'image/png');
    expect(r.text).toBe('');
    expect(r.failureReason).toBe('unreadable');
    generateContent.mockResolvedValue({ text: 'x' });
  });

  it('reports no_provider when nothing is configured', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.USE_VERTEX_AI;
    const r = await describeInboundImage(IMG, 'image/png');
    expect(r.failureReason).toBe('no_provider');
    process.env.GEMINI_API_KEY = 'test-key';
  });

  it('never throws — an image must not take down the inbound turn', async () => {
    generateContent.mockImplementation(() => { throw new Error('boom'); });
    await expect(describeInboundImage(IMG, 'image/png')).resolves.toBeDefined();
    generateContent.mockResolvedValue({ text: 'x' });
  });

  it('failure text is a bracketed marker, not Brain prose', () => {
    // Standing rule: every Brain-surface reply is LLM-generated or a bracketed
    // system marker. answerSanitizer already renders this shape.
    for (const r of ['no_provider', 'invalid_media', 'unreadable'] as const) {
      const m = imageReadFailureMarker(r);
      expect(m.startsWith('[')).toBe(true);
      expect(m.endsWith(']')).toBe(true);
    }
  });
});

describe('the inbound wiring', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'WebjsProvider.ts'), 'utf8');

  it('lets an image past the empty-body guard, like voice', () => {
    expect(SRC).toMatch(/const isImage = message\.type === 'image'/);
    expect(SRC).toMatch(/!isVoice && !isImage && \(!message\.body/);
  });

  it('keeps the caption and leads with it — it is what the user asked', () => {
    expect(SRC).toMatch(/caption\s*\n?\s*\?\s*`\$\{caption\}/);
  });

  it('labels the description as received content, not as Brain\'s own words', () => {
    expect(SRC).toContain('[image received — contents:]');
  });

  it('reuses the existing media download rather than a second path', () => {
    // Anchored on the image BRANCH: the first DEF-110 marker is the
    // empty-body guard further up the file.
    const at = SRC.indexOf('if (isImage && message.hasMedia)');
    expect(at).toBeGreaterThan(-1);
    const block = SRC.slice(at, at + 2000);
    expect(block).toContain('downloadInboundMedia');
  });
});
