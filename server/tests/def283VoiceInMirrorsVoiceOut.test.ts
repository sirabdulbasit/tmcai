/**
 * DEF-283 — deck tag: `Asked for a voice note and got a text reply, or was
 * told audio was impossible for a made-up reason`.
 *
 * CL-047: a VOICE NOTE, correctly transcribed — `Heard: "Through a voice note,
 * tell me all its details."` — was answered in TEXT. The DEF-256 contract had
 * always promised the default ("Null means the channel's default: a voice
 * message gets a voice reply"), but nothing at the sendReply chokepoint
 * implemented it: the voice-in mirror lived only inside each TRANSPORT's
 * replyFn — `protection-with-two-implementations` on the live messaging path,
 * and any path or transport without the mirror answers a voice note in text.
 *
 * The fix moves the default to the ONE chokepoint every reply passes
 * (DEF-102's argument): the model's explicit judgement outranks; a silent
 * model + a voice input mirrors to voice; a silent model + typed input stays
 * text. It DECIDES nothing new — the policy is DEF-256's own stated default —
 * it moves the execution to where it cannot be forgotten.
 *
 * These are labelled SOURCE PINS (the def256 gate-1 pattern for this private
 * chokepoint): the behavioural halves — TTS synthesis, the voice sender, the
 * fail-open — are executed by the def256 suite; what DEF-283 adds is the
 * derivation rule, pinned here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const inbound = readFileSync(
  join(__dirname, '../src/services/whatsapp/WhatsAppInbound.ts'), 'utf8',
);

describe('DEF-283 — the channel default is enforced at the chokepoint, once', () => {
  it('a silent model + a VOICE input mirrors the reply to voice', () => {
    // Mutation: removing the mirror (effectiveDelivery = delivery) dies here.
    expect(inbound).toMatch(/params\.messageType === 'voice'\s*\? \{ medium: 'voice' \}\s*: null/);
  });

  it('the MODEL judgement outranks the mirror — an explicit directive is used verbatim', () => {
    expect(inbound).toMatch(/delivery\?\.medium === 'voice'\s*\? delivery\s*:/);
  });

  it('a silent model + a TYPED input stays text — the mirror never fires speculatively', () => {
    // The ternary's only voice-minting arm is the messageType check; the
    // fall-through is null. Pin the null so a later "default to voice"
    // widening cannot ship silently.
    const start = inbound.indexOf('const effectiveDelivery');
    expect(start).toBeGreaterThan(-1);
    const decl = inbound.slice(start, inbound.indexOf('let voiceDelivered', start));
    expect(decl).toContain(': null');
    expect(decl).not.toContain("'text'");
  });

  it('the executing branch reads the DERIVED delivery, not the raw argument', () => {
    expect(inbound).toContain("if (effectiveDelivery?.medium === 'voice')");
    expect(inbound).toContain('textToVoiceNote(clean, effectiveDelivery.languageCode)');
  });

  it('the per-transport mirrors are demoted to fallback, not removed — a chokepoint TTS fault still reaches replyFn', () => {
    // Fail-open shape (executed by the def256 suite): voiceDelivered=false
    // falls through to params.replyFn, whose own mirror is the second chance.
    expect(inbound).toContain('let voiceDelivered = false');
    expect(inbound).toContain('} else if (params.replyFn) {');
  });
});

describe('DEF-283 — the transcription path preserves the voice fact the mirror depends on', () => {
  it("WebjsProvider sets messageType 'voice' alongside inputWasVoice and passes it through", () => {
    const provider = readFileSync(
      join(__dirname, '../src/services/whatsapp/WebjsProvider.ts'), 'utf8',
    );
    expect(provider).toMatch(/messageType = 'voice';\s*\n\s*inputWasVoice = true;/);
  });
});
