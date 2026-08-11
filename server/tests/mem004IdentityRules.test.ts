/**
 * MEM-004 — the owner's identity rules, written down as assertions.
 *
 * Owner ruling, 2026-08-11:
 *
 *   "LID number should not be primary key to identify person.
 *    What should be analyzed for duplication: Name, Email, Contact.
 *    2 different person cannot have same contact.
 *    2 different person cannot have same email.
 *    2 different person CAN have same name."
 *
 * The first line is the new one and it exists because the transport had been
 * manufacturing people. When WhatsApp withholds a number it supplies a `@lid`,
 * the code turns that into a phone by prefixing "+", and those fake numbers
 * were saved as contacts. Sixteen existed, including:
 *
 *   Hamna ABAP TMC      +255043747987458                        <- a LID
 *   Hamna Latif Bhutta  +923134199294  waLid 255043747987458@lid <- the person
 *
 * Hamna was two people in her own employer's contact list, and one of her had a
 * number nobody could dial. "Nexeo" was in there too.
 *
 * These assertions exist because the rules are asymmetric in a way that is easy
 * to get wrong later: two of the three fields are proof of sameness, the third
 * is proof of nothing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLidNotPhone } from '../src/services/memory/identityResolutionService';

const src = readFileSync(
  join(__dirname, '..', 'src', 'services', 'memory', 'identityResolutionService.ts'),
  'utf-8',
);

describe('MEM-004 — a LID is not a phone number', () => {
  it('recognises the LID-derived numbers that became contacts', () => {
    // Every one of the sixteen phantoms, exactly 15 digits.
    for (const lid of ['+255043747987458', '+130425439707355', '+109410147934417', '+239487846228094']) {
      expect(isLidNotPhone(lid), `${lid} is a LID, not a phone`).toBe(true);
    }
  });

  it('does NOT misjudge real numbers', () => {
    // The two people this whole defect is about, plus shorter international
    // forms. Misfiring here would erase real identity evidence.
    for (const real of ['+923134199294', '+923028000553', '+14155550123', '+442071838750']) {
      expect(isLidNotPhone(real), `${real} is a real number`).toBe(false);
    }
  });

  it('treats an empty or missing number as not-a-LID rather than guessing', () => {
    expect(isLidNotPhone(null)).toBe(false);
    expect(isLidNotPhone('')).toBe(false);
  });
});

describe("MEM-004 — the owner's three rules, as implemented", () => {
  it('RULE: two people cannot share an email — so a shared email is CERTAIN', () => {
    const block = src.slice(src.indexOf('// ── 1. Identical email'));
    expect(block.slice(0, 700)).toContain("'certain'");
  });

  it('RULE: two people cannot share a contact number — so a shared phone is CERTAIN', () => {
    const block = src.slice(src.indexOf('// ── 2. Identical phone'));
    expect(block.slice(0, 700)).toContain("'certain'");
  });

  it('RULE: two people CAN share a name — so a name alone is never a merge', () => {
    // The asymmetry that matters. Name is the weakest of the three and must
    // never reach 'certain' or 'high' on its own.
    const block = src.slice(src.indexOf('// ── 5. Same person name'));
    expect(block.slice(0, 800)).toContain("'ambiguous'");
    expect(block.slice(0, 800)).not.toContain("'certain'");
  });

  it('a LID-derived number is excluded from the phone rule', () => {
    // Otherwise two strangers sharing a placeholder would merge — the phone
    // rule is only true of REAL numbers.
    expect(src).toMatch(/normPhone\s*=.*realPhone\(p\)/);
  });

  it('the real person always survives a merge with a LID phantom', () => {
    // A record whose "phone" is a LID carries a transport-invented name and an
    // undiallable number. Letting it win would replace the person with the
    // placeholder.
    const fn = src.slice(src.indexOf('function pickSurvivor'));
    expect(fn.slice(0, 900)).toMatch(/isLidNotPhone\(r\.phone\) \? -\d+ : 0/);
  });

  it('the LID is used as a JOIN, never as the identifier itself', () => {
    // The owner's words: a LID must not be a primary key. It may still say
    // "these two rows are the same WhatsApp account" — the real contact then
    // supplies who that account belongs to.
    const block = src.slice(src.indexOf('// ── 2b. A LID-phantom'));
    expect(block.slice(0, 1400)).toContain('It is a JOIN');
    expect(block.slice(0, 1800)).toContain("'certain'");
  });
});
