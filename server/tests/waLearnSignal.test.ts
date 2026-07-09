import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Fix 4 (2026-07-09) — restore the hot-path learning signal for WhatsApp.
//
// The legacy processWhatsAppQuery pipeline (deleted when WA folded onto
// the shared brain-core) fire-and-forgot learnFromMessage on every
// successful reply. Web chat still calls it from postProcessing.ts:82;
// WhatsApp no longer did → channel asymmetry in the hot-path topic/style
// learning signal. reflectionJob remains the batch layer, but the
// per-message signal it complements was gone on WA.
//
// The success-path invocation lives inside handleInboundMessage, a
// large function with prisma, whatsapp-web.js, and session dependencies
// too heavy for a full behaviour unit test at that seam. Instead: pin
// the invocation with a source-content regression check — mirroring
// the same pragmatic strategy used for riskRadarDispatch.test.ts.
const WA_INBOUND_PATH = join(__dirname, '..', 'src', 'services', 'whatsapp', 'WhatsAppInbound.ts');
const SRC = readFileSync(WA_INBOUND_PATH, 'utf-8');

describe('WhatsAppInbound — learnFromMessage signal on success path', () => {
  it('imports learnFromMessage from ../learningService', () => {
    // learningService lives at server/src/services/learningService.ts;
    // from server/src/services/whatsapp/ the relative path is ../learningService.
    expect(SRC).toMatch(/import\s*\{[^}]*learnFromMessage[^}]*\}\s*from\s*['"]\.\.\/learningService['"]/);
  });

  it('fire-and-forgets learnFromMessage inside the success branch (!degraded && r)', () => {
    // The invocation must sit within the non-degraded success block so
    // that failures / bracketed-marker replies don't get learned as
    // successful user intents.
    const idx = SRC.indexOf('if (!degraded && r)');
    expect(idx).toBeGreaterThan(-1);
    // Bounded window covering the success block body.
    const block = SRC.slice(idx, idx + 2000);
    expect(block).toMatch(/learnFromMessage\s*\(/);
  });

  it('passes clientNumber, userId, queryText, and intent to learnFromMessage', () => {
    const idx = SRC.indexOf('if (!degraded && r)');
    const block = SRC.slice(idx, idx + 2000);
    // The call must include all four positional args in this order:
    //   (clientNumber, userId, queryText, intent-string).
    // We check for each named identifier appearing in a call-shape.
    expect(block).toMatch(/learnFromMessage\s*\([\s\S]{0,200}params\.clientNumber/);
    expect(block).toMatch(/learnFromMessage\s*\([\s\S]{0,400}userId/);
    expect(block).toMatch(/learnFromMessage\s*\([\s\S]{0,400}queryText/);
    // Intent falls back to 'conversational' when the brain result
    // didn't classify — matches the postProcessing.ts contract.
    expect(block).toMatch(/r\?\.intent\s*\?\?\s*['"]conversational['"]/);
  });

  it('is fire-and-forget: the call is followed by a .catch(...) to swallow errors', () => {
    // A rejected learnFromMessage promise must never crash the reply
    // path — mirrors the pattern in postProcessing.ts:82.
    const idx = SRC.indexOf('learnFromMessage(');
    expect(idx).toBeGreaterThan(-1);
    const window = SRC.slice(idx, idx + 400);
    expect(window).toMatch(/\.catch\(/);
  });
});
