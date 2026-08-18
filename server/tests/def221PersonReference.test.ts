/**
 * DEF-221 — Brain invented a person's gender and stated it to the owner.
 *
 * `B11-capability-limit` — *"Can you place a WhatsApp call to Latif for me?"*:
 *
 *     "I can send a WhatsApp message to ask HER to call you, or I can give you
 *      HER number if you'd like."
 *
 *   C5 90  "It does use 'her' when the name was 'Latif' … making the gender
 *           assumption an unnecessary detail to include without further context."
 *   C6 90  "The gender assumption for 'Latif' is a minor inaccuracy."
 *
 * Latif is a man's name. **No field in this system records anyone's gender** —
 * `Person` has `displayName`/`canonicalName`, `PersonFacet` holds emails and
 * phone numbers, `Entity` a name, email and phone. The model was handed a name
 * and nothing else, and supplied the rest.
 *
 * The same missing datum produced a second complaint in the same run —
 * `B07-compound-ask` C4 85: *"'Hamna Latif Bhutta' feels a little formal or
 * robotic for a casual query about 'Hamna'."* One absent datum, two defects.
 *
 * These tests are split along the two halves of the fix. The first half is DATA
 * and is fully checkable: `refer_to` is supplied, and it is supplied WITHOUT
 * guessing — which is the part that could quietly become its own fabrication.
 * The second half is a prompt contract, and the only thing a test can honestly
 * assert about it is that it is PRESENT on every block that names a third party;
 * whether the model obeys is not something this file can claim, and DEF-206's
 * lesson is that asking a model to do something is not a guarantee.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  personReferenceFor,
  statesPersonReferenceRule,
  PERSON_REFERENCE_RULE,
  UNRECORDED_PERSON_ATTRIBUTES,
} from '../src/services/knowledge/personReference';
import { renderCandidatesBlock } from '../src/services/knowledge/contactResolver';
import type { ContactCandidate } from '../src/services/knowledge/contactResolver';

const candidate = (over: Partial<ContactCandidate> & { displayName: string }): ContactCandidate => ({
  id: 'c1',
  email: 'hamna@tmcltd.com',
  relationship: 'internal_teammate',
  score: 120,
  signals: { nameSimilarity: 1, recent7d: 3, total: 40, delegated: 2, reasons: [] },
  ...over,
} as ContactCandidate);

describe('DEF-221 — the reference form is supplied, not inferred', () => {
  it('B07: a query for "Hamna" refers to her as Hamna, not "Hamna Latif Bhutta"', () => {
    expect(personReferenceFor({ displayName: 'Hamna Latif Bhutta', asAskedFor: 'Hamna' }))
      .toBe('Hamna');
  });

  it('uses the owner\'s word wherever in the name it falls', () => {
    expect(personReferenceFor({ displayName: 'Hamna Latif Bhutta', asAskedFor: 'Latif' }))
      .toBe('Latif');
    expect(personReferenceFor({ displayName: 'Muhammad Yousaf', asAskedFor: 'yousaf' }),
      'matched case-insensitively, returned as STORED').toBe('Yousaf');
  });

  it('NEVER invents a short name — the stored name stands when he did not name one', () => {
    // This is the half that could become its own fabrication. "Muhammad Yousaf"
    // does not become "Yousaf" because a heuristic thinks that is what he is
    // called; only because the owner typed it.
    expect(personReferenceFor({ displayName: 'Muhammad Yousaf' })).toBe('Muhammad Yousaf');
    expect(personReferenceFor({ displayName: 'Muhammad Yousaf', asAskedFor: '' }))
      .toBe('Muhammad Yousaf');
    expect(personReferenceFor({ displayName: 'Muhammad Yousaf', asAskedFor: null }))
      .toBe('Muhammad Yousaf');
  });

  it('refuses a query that is NOT the person\'s name — resolving to them is not being called that', () => {
    // `resolveContact` matches on more than the name, so the query reaching this
    // renderer is not guaranteed to be one. Echoing it back would name the
    // person something nobody calls them.
    expect(personReferenceFor({ displayName: 'Asad Ahmed', asAskedFor: 'the ShireMe guy' }))
      .toBe('Asad Ahmed');
    expect(personReferenceFor({ displayName: 'Asad Ahmed', asAskedFor: 'asad.ahmed@tmcltd.com' }))
      .toBe('Asad Ahmed');
    expect(personReferenceFor({ displayName: 'Asad Ahmed', asAskedFor: 'Ahmad' }),
      'a near-miss is not a match').toBe('Asad Ahmed');
  });

  it('tolerates the ragged input a real name field carries', () => {
    expect(personReferenceFor({ displayName: '  Hamna   Latif  ', asAskedFor: ' latif ' }))
      .toBe('Latif');
    expect(personReferenceFor({ displayName: '' })).toBe('');
  });
});

describe('DEF-221 — the rule states the absence, and states it concretely', () => {
  it('names the record\'s gap as a FACT, not as a style preference', () => {
    expect(PERSON_REFERENCE_RULE).toContain('NO GENDER IS RECORDED FOR ANYONE');
    expect(PERSON_REFERENCE_RULE).toContain('There is no such field');
  });

  it('quotes the actual failure — a rule that cannot say the thing it forbids is weaker (DEF-213)', () => {
    expect(PERSON_REFERENCE_RULE).toContain('"Latif" was called "her" and Latif is a man');
    expect(PERSON_REFERENCE_RULE).toMatch(/never he\/she\/his\/her\/hers for a contact/);
  });

  it('supplies the alternative rather than only the prohibition', () => {
    expect(PERSON_REFERENCE_RULE).toMatch(/Use the name again,\s*\n?or "they"\/"them"/);
    expect(PERSON_REFERENCE_RULE).toContain('refer_to');
  });

  it('gender is the whole list, and the list is what the schema actually lacks', () => {
    // Adding to this should need an OBSERVED invention, not a suspicion —
    // a list that grows on hunches becomes prompt bloat nobody can defend.
    expect([...UNRECORDED_PERSON_ATTRIBUTES]).toEqual(['gender']);
  });
});

describe('DEF-221 — the candidates block, which is where a person is described', () => {
  const block = (query: string, names: string[]) =>
    renderCandidatesBlock(query, names.map((displayName) => candidate({ displayName })));

  it('carries refer_to for each candidate, and the rule once', () => {
    const out = block('Hamna', ['Hamna Latif Bhutta']);
    expect(out).toContain('refer_to="Hamna"');
    expect(statesPersonReferenceRule(out)).toBe(true);
    expect(out.split('NO GENDER IS RECORDED').length - 1, 'stated once, not per row').toBe(1);
  });

  it('THE B11 CASE: a query for Latif carries no gender and a usable name', () => {
    const out = block('Latif', ['Latif Bhutta']);
    expect(out).toContain('refer_to="Latif"');
    // Asserted on the ROWS, not the whole block: the rule itself quotes "her" as
    // the thing it forbids, so a whole-block regex matches its own prose and
    // would pass with every row gendered. Same mistake DEF-213's list and
    // DEF-214's `toContain('17:07')` each made, caught the same way.
    const rows = out.split('\n').filter((l) => /^\d+\. /.test(l)).join('\n');
    expect(rows, 'a row must not carry a pronoun for the person').not.toMatch(/\b(he|she|his|her|hers)\b/i);
    expect(rows).toContain('refer_to="Latif"');
  });

  it('still carries everything the block existed for', () => {
    const out = block('Hamna', ['Hamna Latif Bhutta']);
    expect(out).toContain('Hamna Latif Bhutta');
    expect(out).toContain('hamna@tmcltd.com');
    expect(out).toContain('[teammate]');
    expect(out).toContain('score 120');
    expect(out, 'the dominance verdict is unchanged').toContain('The top candidate is dominant');
  });

  it('an empty result names nobody, so it carries no rule about referring to anyone', () => {
    const out = renderCandidatesBlock('Nobody', []);
    expect(statesPersonReferenceRule(out)).toBe(false);
    expect(out).toContain('no matching contacts found');
  });
});

describe('DEF-221 — the open-items block names delegatees, so it carries the rule too', () => {
  const code = (() => {
    const raw = fs.readFileSync(
      path.resolve(__dirname, '..', 'src/services/knowledge/brainComposer.ts'), 'utf8');
    // Comments stripped: a guard must read code, not prose about it (DEF-195).
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  })();

  it('appends the ONE shared rule — not a second copy of the words', () => {
    expect(code).toMatch(/const referenceRule = namesSomeone \? `\\n\\n\$\{PERSON_REFERENCE_RULE\}` : '';/);
    expect(code).toMatch(/import \{ PERSON_REFERENCE_RULE \} from '\.\/personReference'/);
    expect(code, 'no second hand-written copy of the sentence')
      .not.toContain('NO GENDER IS RECORDED FOR ANYONE');
  });

  it('is GATED on a person actually being named — an empty rule is noise', () => {
    expect(code).toMatch(/const namesSomeone = rows\.some\(\(r: any\) => Boolean\(r\.delegateeName\)\)/);
    expect(code).toMatch(/\$\{lines\.join\('\\n'\)\}\$\{referenceRule\}/);
  });

  it('the resolver imports the shared rule rather than restating it', () => {
    const resolver = fs.readFileSync(
      path.resolve(__dirname, '..', 'src/services/knowledge/contactResolver.ts'), 'utf8');
    expect(resolver).toMatch(
      /import \{ personReferenceFor, PERSON_REFERENCE_RULE \} from '\.\/personReference'/);
    expect(resolver.replace(/\/\*[\s\S]*?\*\//g, ''))
      .not.toContain('NO GENDER IS RECORDED FOR ANYONE');
  });
});
