/**
 * DEF-113 — a capability that exists but is undeclared produces a fabricated NO.
 *
 * 2026-08-10. Image reading shipped at 18:0x (DEF-110). At 18:31 the owner
 * asked "have u got capability to read images?" and was told no. At 18:32:
 * "why? i asked you around 2h before to get this capability".
 *
 * The capability was live. It was simply absent from the capability registry,
 * and that registry is what the truth-table prompt is generated from — so Brain
 * answered from a table that did not know about its own new ability.
 *
 * This is the same class of false statement as a fabricated positive, and it
 * reads worse: the owner can watch the feature work while being told it does
 * not exist. Voice had the identical gap since 2026-08-04 and is declared here
 * too.
 */
import { describe, it, expect } from 'vitest';
import { NON_ACTION_CAPABILITIES, listLimitations } from '../src/services/knowledge/brainCapabilityRegistry';

const handles = () => NON_ACTION_CAPABILITIES.map((c) => c.handle);
const find = (h: string) => NON_ACTION_CAPABILITIES.find((c) => c.handle === h);

describe('input modalities are declared', () => {
  it('image reading appears in the capability list', () => {
    expect(handles()).toContain('imageService.describeInboundImage');
  });

  it('voice transcription appears too — it had the same gap', () => {
    expect(handles()).toContain('voiceService.transcribeVoiceNote');
  });

  it('each says plainly that Brain CAN do it', () => {
    for (const h of ['imageService.describeInboundImage', 'voiceService.transcribeVoiceNote']) {
      const what = find(h)!.what;
      expect(what).toMatch(/You CAN /);
      expect(what).toMatch(/Never tell the user you cannot/i);
    }
  });

  it('the image entry explains how contents arrive, so Brain can use them', () => {
    const what = find('imageService.describeInboundImage')!.what;
    expect(what).toContain('[image received — contents:]');
    expect(what).toMatch(/verbatim/i);
  });
});

describe('the limitations list does not contradict them', () => {
  it('nothing claims images or voice are unsupported', () => {
    const text = listLimitations().map((l) => `${l.label} ${l.why}`).join(' ').toLowerCase();
    expect(text).not.toMatch(/image/);
    expect(text).not.toMatch(/voice note/);
  });
});
