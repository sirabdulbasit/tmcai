/**
 * DEF-256 — `fabricated-status` (denial arm, archive tag `capability-fabrication`),
 * 7th recorded occurrence. CIRCLING, so the fix is structural.
 *
 * 2026-08-31 05:53 PKT, WhatsApp, typed: "can you give me voice note in urdu?"
 *   → "I can only reply in English text. I can't generate audio replies in any
 *      language right now"
 *   → "The components I use for generating speech don't have support for Urdu yet"
 *
 * Both sentences are false. `textToVoiceNote()` has synthesised Urdu through the
 * Google TTS `ur-IN-Standard-A` voice since it was written. Brain denied a
 * capability it has and invented a mechanism for the denial.
 *
 * It was not lying so much as cornered. THREE gates, none of them the model's
 * judgement, made the true answer unreachable:
 *   1. voice-out was hardwired to voice-in — `webhookRoutes` builds a
 *      voice-capable `replyFn` only when `inputWasVoice`, so a TYPED ask had no
 *      path to TTS at all;
 *   2. the reasoning JSON contract had no delivery field, so a model that wanted
 *      to send audio had no way to say so;
 *   3. the persona language pin was written as an absolute ("ALWAYS ENGLISH —
 *      NON-NEGOTIABLE"), forbidding the Urdu text the Urdu voice needs.
 *
 * The structural fix moves the delivery decision to the MODEL and leaves code to
 * execute it. No keyword list anywhere decides who gets voice.
 *
 * What this suite pins, in the order the failure happened:
 *   1. the model can now SAY it (reply_delivery survives the real parser)
 *   2. only 'voice' is a directive — junk is dropped, never obeyed
 *   3. THE DENIAL WAS FALSE: the Urdu voice is real and reachable with the exact
 *      languageCode the model now emits — the behavioural heart of this suite
 *   4. the prompt contract names the capability, so the model cannot be cornered
 *      into denying it again
 *   5. the chokepoint executes the judgement and fails OPEN to text
 *   6. the language pin is a default with an explicit per-turn override
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Capture what voice config textToVoiceNote actually asks Google for. This is
// the assertion that falsifies the owner-visible denial: the request either
// names an Urdu voice or it does not.
const synthesizeSpeech = vi.fn();
vi.mock('@google-cloud/text-to-speech', () => ({
  TextToSpeechClient: class {
    synthesizeSpeech(...args: any[]) { return synthesizeSpeech(...args); }
  },
}));

import { parseReasoningOutput } from '../src/services/knowledge/reasoningCompose';
import { textToVoiceNote } from '../src/services/voiceService';

const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf-8');

/** A minimal well-formed reasoning envelope; each test varies only what it tests. */
function envelope(extra: Record<string, unknown>) {
  return JSON.stringify({
    decision: 'answer',
    answer_text: 'جی سر، یہ رہا آپ کا وائس نوٹ۔',
    confidence: 0.95,
    rationale: 'explicit voice-note request',
    ...extra,
  });
}

describe('DEF-256 · the model can express a delivery judgement', () => {
  it('carries reply_delivery voice + languageCode through the real parser', () => {
    const parsed = parseReasoningOutput(envelope({
      reply_delivery: { medium: 'voice', languageCode: 'ur-PK' },
    }));
    expect(parsed).not.toBeNull();
    expect(parsed!.replyDelivery).toEqual({ medium: 'voice', languageCode: 'ur-PK' });
  });

  it('treats an absent reply_delivery as null — the channel default, not voice', () => {
    // Silence must never be read as a voice directive, or every reply becomes audio.
    const parsed = parseReasoningOutput(envelope({}));
    expect(parsed!.replyDelivery).toBeNull();
  });

  it('accepts voice with no languageCode — the answer text carries the language', () => {
    const parsed = parseReasoningOutput(envelope({ reply_delivery: { medium: 'voice' } }));
    expect(parsed!.replyDelivery).toEqual({ medium: 'voice', languageCode: undefined });
  });

  it('drops an empty/whitespace languageCode rather than passing it to the synthesiser', () => {
    const parsed = parseReasoningOutput(envelope({
      reply_delivery: { medium: 'voice', languageCode: '   ' },
    }));
    expect(parsed!.replyDelivery).toEqual({ medium: 'voice', languageCode: undefined });
  });

  it('DROPS a medium it does not implement instead of obeying it', () => {
    // The model is not a trusted command source for transports that do not exist.
    for (const medium of ['carrier-pigeon', 'sms', 'video', '', null, 42]) {
      const parsed = parseReasoningOutput(envelope({ reply_delivery: { medium } }));
      expect(parsed!.replyDelivery, `medium=${String(medium)}`).toBeNull();
    }
  });
});

describe('DEF-256 · the denied capability is REAL and reachable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/nonexistent/creds.json');
    synthesizeSpeech.mockResolvedValue([{ audioContent: Buffer.from('OggS-fake-audio') }]);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('routes ur-PK — the exact code the model now emits — to a real Urdu voice', async () => {
    // "The components I use for generating speech don't have support for Urdu yet"
    // was false when it was said. This is the assertion that says so.
    const buf = await textToVoiceNote('This is the reply the owner asked to hear.', 'ur-PK');
    expect(buf).toBeInstanceOf(Buffer);
    const [req] = synthesizeSpeech.mock.calls[0];
    expect(req.voice.name).toBe('ur-IN-Standard-A');
    expect(req.voice.languageCode).toBe('ur-IN');
  });

  it('routes Urdu SCRIPT to the Urdu voice even with no languageCode hint', async () => {
    // The answer text carries the language; the hint is only a hint.
    const buf = await textToVoiceNote('جی سر، یہ رہا آپ کا وائس نوٹ۔ کام مکمل ہو گیا ہے۔');
    expect(buf).toBeInstanceOf(Buffer);
    expect(synthesizeSpeech.mock.calls[0][0].voice.name).toBe('ur-IN-Standard-A');
  });

  it('still uses the English voice when no Urdu is requested or present', async () => {
    await textToVoiceNote('Everything is on track for tomorrow morning.', 'en-US');
    expect(synthesizeSpeech.mock.calls[0][0].voice.name).toBe('en-US-Neural2-F');
  });

  it('returns null rather than throwing when TTS fails — so the reply can fall back', async () => {
    synthesizeSpeech.mockRejectedValue(new Error('quota exhausted'));
    await expect(textToVoiceNote('Something worth hearing.', 'ur-PK')).resolves.toBeNull();
  });
});

describe('DEF-256 · gate 2 — the prompt contract names the capability', () => {
  const rc = read('services', 'knowledge', 'reasoningCompose.ts');

  it('declares the reply-delivery contract and its JSON field', () => {
    expect(rc).toContain('# Reply-delivery contract');
    expect(rc).toContain('"reply_delivery"');
  });

  it('tells the model the Urdu voice EXISTS, so denial is never the honest answer', () => {
    // The specific fabrication is quoted in the prompt as a thing not to say.
    expect(rc).toMatch(/never tell the user you .*can't generate audio/i);
    expect(rc).toMatch(/Urdu/);
  });

  it('tells the model not to set delivery speculatively', () => {
    expect(rc).toContain('Do not set it speculatively');
  });
});

describe('DEF-256 · gate 1 — the chokepoint executes it, and fails open', () => {
  const inbound = read('services', 'whatsapp', 'WhatsAppInbound.ts');

  it('branches on the MODEL judgement, not on whether the input was voice', () => {
    expect(inbound).toContain("delivery?.medium === 'voice'");
  });

  it('synthesises with the model languageCode and sends through the tenant sender', () => {
    expect(inbound).toContain('textToVoiceNote(clean, delivery.languageCode)');
    expect(inbound).toContain('sendTenantWhatsAppVoiceNote');
  });

  it('guards every failure mode so a reply is never lost to a TTS or media fault', () => {
    // Fail OPEN: the text transports below stay reachable unless voice truly went out.
    expect(inbound).toContain('let voiceDelivered = false');
    expect(inbound).toContain('if (voiceDelivered) {');
    // The whole voice attempt sits inside a try/catch that only warns. Bound the
    // block to the voice attempt itself — it ends where the text transports begin.
    const start = inbound.indexOf("if (delivery?.medium === 'voice')");
    const end = inbound.indexOf('if (voiceDelivered) {', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = inbound.slice(start, end);
    expect(block).toMatch(/catch \(err: any\) \{[\s\S]{0,300}log\.warn\(/);
    // Nothing in the voice attempt may propagate — a TTS or media fault must
    // leave the reply to the text paths below, never bubble out of sendReply.
    expect(block).not.toContain('throw');
  });

  it('sends the readable copy only when a voice bubble really went out', () => {
    // sendTenantWhatsAppVoiceNote already falls back to text itself (see
    // tenantWhatsappVoiceFallback.test.ts); a second copy would double-send.
    expect(inbound).toContain("voice.deliveredAs === 'voice'");
  });
});

describe('DEF-256 · gate 3 — the language pin is a default, not an absolute', () => {
  const persona = read('services', 'knowledge', 'brainPersonaService.ts');

  it('grants an explicit per-turn override of the standing reply language', () => {
    expect(persona).toContain('Explicit request overrides the language rule');
  });

  it('forbids claiming the language cannot be spoken — the fabrication itself', () => {
    expect(persona).toMatch(/NEVER refuse the request/);
    expect(persona).toMatch(/fabricating a limitation/);
  });
});
