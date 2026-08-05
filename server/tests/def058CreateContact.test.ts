/**
 * DEF-058 — Brain narrated a capability it did not have.
 *
 * 2026-08-05 18:21. The owner: "Note Arjamand Bano is my friend her contact is
 * +923044219317". Brain: "Sir, I've created a contact for your friend Arjamand
 * Bano with the number you provided. I've also added a note to her profile."
 *
 * Nothing was created. There was no create_contact action — not in the schema,
 * not in the dispatcher, not in the registry. The claim was guaranteed false
 * the moment it was made.
 *
 * One minute later, asked to message her: "Sir, I don't have Arjamand Bano in
 * your contacts list." That one was true. Brain did not contradict itself so
 * much as tell the truth after fabricating.
 *
 * Two failures, both fixed here:
 *   1. The capability was missing. A model that believes it can do something is
 *      more dangerous than one that cannot, because the refusal never comes.
 *   2. The empty-promise guard could not see it — "created" was absent from an
 *      enumerated verb list that has now been extended after the fact three
 *      times, each time the day after a real fabrication reached the owner.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  normaliseAction, EMPTY_PROMISE_RE, COMPOSER_DISPATCHED_TYPES,
  IMMEDIATE_INTERNAL_ACTION_TYPES, actionReachesACounterpart,
} from '../src/services/knowledge/brainComposer';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('DEF-058 — the capability now exists', () => {
  it('create_contact is a dispatchable composer type', () => {
    expect(COMPOSER_DISPATCHED_TYPES.has('create_contact')).toBe(true);
  });

  it('is seeded in the action registry — the parity lock caught this', () => {
    const seed = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'scripts', 'seedActionDefinitions.ts'), 'utf8');
    expect(seed).toContain("type: 'create_contact'");
    expect(seed).toContain("handlerFunction: 'createEntity'");
  });

  it('the owner\'s exact sentence normalises into a real action', () => {
    const a = normaliseAction({
      type: 'create_contact', name: 'Arjamand Bano', phone: '+923044219317',
      note: 'special respected friend',
    });
    expect(a).not.toBeNull();
    expect(a!.type).toBe('create_contact');
    expect((a as any).phone).toBe('+923044219317');
  });

  it('refuses a contact with no way to reach them', () => {
    // A name with neither email nor phone is a note, not a contact — and
    // unreachable rows are exactly the debris that grew the list to 620.
    expect(normaliseAction({ type: 'create_contact', name: 'Someone' })).toBeNull();
    expect(normaliseAction({ type: 'create_contact', phone: '+92300' })).toBeNull();
  });

  it('saving a contact contacts nobody, so it applies immediately', () => {
    expect(IMMEDIATE_INTERNAL_ACTION_TYPES.has('create_contact')).toBe(true);
    expect(actionReachesACounterpart({ type: 'create_contact', name: 'X' } as any)).toBe(false);
  });

  it('refuses when the identifier already belongs to someone (DEF-051)', () => {
    // The collision check that would have stopped the two Hamna rows existing.
    const branch = CODE.slice(CODE.indexOf("case 'create_contact': {"));
    const body = branch.slice(0, branch.indexOf("case 'update_contact'"));
    expect(body).toContain('already belongs to');
    expect(body).toMatch(/entity\.findFirst/);
    expect(body).toMatch(/ok:\s*false/);
  });

  it('new contacts are user-scoped, never tenant-visible by default', () => {
    const branch = CODE.slice(CODE.indexOf("case 'create_contact': {"));
    const body = branch.slice(0, branch.indexOf("case 'update_contact'"));
    expect(body).toMatch(/scope: 'user'/);
  });
});

describe('DEF-058 — the guard can see the claim now', () => {
  it('catches the verbatim fabrication', () => {
    expect(EMPTY_PROMISE_RE.test("I've created a contact for your friend Arjamand Bano")).toBe(true);
  });

  it('catches the sibling phrasings of the same claim', () => {
    for (const claim of [
      'I have saved her number.',
      "I've noted that down.",
      'I have recorded her details.',
      'I will create the contact now.',
    ]) {
      expect(EMPTY_PROMISE_RE.test(claim), claim).toBe(true);
    }
  });

  it('still ignores innocuous prose', () => {
    expect(EMPTY_PROMISE_RE.test('Would you like me to create a contact for her?')).toBe(false);
    expect(EMPTY_PROMISE_RE.test('She created the report last week.')).toBe(false);
  });
});
