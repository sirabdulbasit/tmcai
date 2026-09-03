/**
 * DEF-293 — the internal identifier must never reach the owner.
 *
 * He has now said it twice. 2026-09-01: *"don't show me niumber like +239487846228094, this is
 * your internal number"*. 2026-09-03, looking at a table I had just put in front of him:
 * *"first column is useless for me, don't show me this anywhere, keep it for your internal
 * referencing or working — Name and Number is what is useful"*.
 *
 * DEF-269 recorded the requirement and left enforcement open, which is why it happened again.
 * This is the enforcement.
 *
 * The synthetic `'+' + lid-digits` STAYS in the database and in every internal path — it is the
 * routing token that stops an unresolved sender's replies being discarded (`@lid` recurrence #4),
 * and removing it would resurrect a much worse bug. What must stop is it reaching HIM, because it
 * is shaped like a dialable number and is not one. DEF-121: a fabricated number is worse than no
 * number, because it looks actionable.
 */
import { describe, it, expect } from 'vitest';
import { describeSender } from '../src/services/whatsapp/senderTriage';

const SYNTH = '+239487846228094';
const LID = '239487846228094@lid';
const REAL = '+923134199294';

describe('DEF-293 — the synthetic never reaches him', () => {
  it('shows the NAME alone when the id is a lid, never the synthetic', () => {
    const out = describeSender(SYNTH, 'Hamna Latif Bhutta', LID);
    expect(out).toBe('Hamna Latif Bhutta');
    expect(out).not.toContain('239487846228094');
  });

  it('says plainly that the number is withheld when there is no name either', () => {
    const out = describeSender(SYNTH, null, LID);
    expect(out).not.toContain('239487846228094');
    expect(out).toMatch(/number WhatsApp did not share/i);
  });

  it('catches it even when the caller has no raw id to check against', () => {
    // Three call sites now pass the raw id, but a future one may not. Length is the fallback:
    // a real E.164 number is ≤15 and in practice ≤12; a LID is 15.
    expect(describeSender(SYNTH, 'Hamna Latif Bhutta')).toBe('Hamna Latif Bhutta');
    expect(describeSender(SYNTH, null)).not.toContain('239487846228094');
    expect(describeSender(SYNTH, null)).toMatch(/number WhatsApp did not share/i);
  });

  it('still shows a REAL number — that is the useful half', () => {
    // His own words: "where column Name and Number is useful for me".
    expect(describeSender(REAL, 'Hamna Latif Bhutta', '923134199294@c.us'))
      .toBe('+923134199294 (Hamna Latif Bhutta)');
    expect(describeSender(REAL, null)).toBe('+923134199294');
  });

  it('shows a real number in the shapes he actually uses', () => {
    for (const n of ['+923028000553', '+923134199294', '03134199294']) {
      expect(describeSender(n, 'Someone'), n).toContain(n);
    }
  });

  it('trusts the raw id over the heuristic when both are available', () => {
    // A genuinely long real number, explicitly marked as a phone id, must still be shown.
    expect(describeSender('+123456789012345', 'Long Number', '123456789012345@c.us'))
      .toContain('123456789012345');
  });

  it('the three owner-facing call sites pass the raw id', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'whatsapp', 'senderTriage.ts'), 'utf-8');
    const calls = src.split('\n').filter((l) => l.includes('describeSender(params.fromNumber'));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c).toContain('params.rawSenderId');
  });
});
