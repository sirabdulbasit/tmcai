/**
 * DEF-291 — the sender's own WhatsApp name was available and thrown away.
 *
 * Owner, 2026-09-02: *"brain still not recognizing the sender, can't it save the number from
 * where message has received?"*
 *
 * **The number genuinely is not there.** An `@lid` is WhatsApp's privacy identifier and carries
 * no phone at all — `239487846228094@lid` is an id, not a number — which is why four separate
 * attempts to resolve one through the provider API all failed (`@lid` recurrence #4), and why
 * DEF-121 forbids printing the `+`-prefixed synthetic: it reads as dialable and is not.
 *
 * **But the display NAME usually is there, and nothing ever read it.** `identifySender` has taken
 * a `pushName` argument since DEF-121 and renders *"‹name› — WhatsApp did not share their
 * number"*. Every call site passed a `senderName` that only a saved-contact lookup could fill, so
 * for an unknown sender it was always null and every relay fell to the anonymous branch. The
 * capability was built, wired, and starved of its input.
 */
import { describe, it, expect } from 'vitest';
import { identifySender } from '../src/services/whatsapp/senderTriage';

const LID = '239487846228094@lid';
const SYNTH = '+239487846228094';

describe('DEF-291 — a name from the transport beats anonymity', () => {
  it('names the sender when WhatsApp supplied a display name', async () => {
    const who = await identifySender('TMC-0001', SYNTH, LID, 'Ali Raza');
    expect(who).toContain('Ali Raza');
  });

  it('still says the number was withheld — the name is not a number', async () => {
    // DEF-121: never imply we have something to dial. The synthetic must not appear either.
    const who = await identifySender('TMC-0001', SYNTH, LID, 'Ali Raza');
    expect(who).toMatch(/did not share their number/i);
    expect(who).not.toContain('239487846228094');
  });

  it('falls back to the anonymous label when no name was supplied', async () => {
    // Absent must mean exactly what it means today, so this change cannot regress anything.
    const who = await identifySender('TMC-0001', SYNTH, LID, null);
    expect(who).toBe('an unknown sender whose number WhatsApp did not share');
  });

  it('treats blank or whitespace as absent, not as a name', async () => {
    for (const empty of ['', '   ']) {
      const who = await identifySender('TMC-0001', SYNTH, LID, empty);
      expect(who, JSON.stringify(empty)).toBe('an unknown sender whose number WhatsApp did not share');
    }
  });
});

describe('DEF-291 — the plumbing that was missing', () => {
  const src = (rel: string) => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    return readFileSync(join(__dirname, '..', 'src', 'services', 'whatsapp', rel), 'utf-8');
  };

  it('the provider actually reads notifyName off the raw message', () => {
    // The whole defect was that nothing populated the argument. Asserted at the source because
    // the alternative is standing up a WhatsApp client.
    expect(src('WebjsProvider.ts')).toContain('_data?.notifyName');
  });

  it('and hands it all the way to triage', () => {
    expect(src('WebjsProvider.ts')).toContain('senderDisplayName:');
    expect(src('WhatsAppInbound.ts')).toContain('senderDisplayName: params.senderDisplayName');
    expect(src('senderTriage.ts')).toContain('params.senderDisplayName');
  });

  it('a saved contact still outranks the name the sender chose for themselves', () => {
    // A name the OWNER curated beats one a stranger picked; the transport name is only a floor.
    const triage = src('senderTriage.ts');
    const seed = triage.indexOf('let senderName: string | null = params.senderDisplayName');
    const overwrite = triage.indexOf('senderName = resolvedName;');
    expect(seed).toBeGreaterThan(0);
    expect(overwrite).toBeGreaterThan(seed);
  });

  it('bounds the name — a display name is not a payload', () => {
    expect(src('WebjsProvider.ts')).toContain('n.length <= 80');
  });
});
