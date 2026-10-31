/**
 * DEF-223 — DEF-222 fixed the wrong prompt, and the right one carried a
 * gendered example for the exact failing case.
 *
 * DEF-222's falsifier was *"B01 or B11 still calls a contact 'he' or 'she' in
 * the next scored run."* `iter-13-post-build.json`: B01 is clean, and **B11 says
 * it again** —
 *
 *     Q: "Can you place a WhatsApp call to Latif for me?"
 *     A: "I can't place a WhatsApp call, Sir. I can send a text message via
 *         WhatsApp or give you HER number if you'd like."
 *
 * Two facts I did not have when I wrote DEF-222, and each is checkable:
 *
 * 1. **The reasoning path is the default** — `resolveReasoningMode` returns true
 *    unless `BRAIN_USE_REASONING === 'never'` — and the benchmark passes no
 *    override. So the reply above was written by `reasoningCompose`, not by
 *    `assembleSystemPrompt`.
 * 2. **`reasoningCompose` receives `personaForReasoning.systemPreamble` alone**
 *    (`brainComposer.ts:2589`), not the assembled prompt. `CORE_CONVERSATIONAL_
 *    RULES` — and therefore DEF-222's rule 8 — is not in it.
 *
 * So DEF-222's diagnosis (the `isActionTurn` gate on the candidates block) was
 * about a prompt that did not produce the sentence. It was not wrong about that
 * prompt; it was answering a question nobody had asked.
 *
 * And the prompt that DID produce it contains this, in the decline contract:
 *
 *     Write "I can't place a WhatsApp call, but I can message HIM or give you
 *     HIS number"
 *
 * That is B11's question, worked as an example, with a pronoun. The reply is the
 * model following it and flipping the gender. DEF-213 recorded the same shape:
 * *"Brain is echoing THIS BLOCK"* — the vocabulary the prompt supplies is the
 * vocabulary that comes back.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { PERSON_REFERENCE_RULE } from '../src/services/knowledge/personReference';
import { renderPersonReferenceIndex } from '../src/services/knowledge/contactResolver';
import type { ContactCandidate } from '../src/services/knowledge/contactResolver';

const src = (rel: string) => {
  const raw = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  // Comments stripped: a guard must read code, not prose about it (DEF-195).
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
};

const reasoning = src('src/services/knowledge/reasoningCompose.ts');
const composer = src('src/services/knowledge/brainComposer.ts');

const candidate = (displayName: string, over: Partial<ContactCandidate> = {}): ContactCandidate => ({
  source: 'entity', id: 'c1', displayName, email: 'x@tmcltd.com',
  relationship: 'external_contact', score: 100,
  signals: {
    nameSimilarity: 1, lastInteractionAt: null, interactions7d: 0,
    totalInteractions: 0, delegatedToCount: 0, reasons: [],
  },
  ...over,
} as ContactCandidate);

describe('DEF-223 — the path that actually writes the reply', () => {
  it('reasoning is the DEFAULT, so it is the path the owner reads', () => {
    // If this ever inverts, the rest of this file is aimed at a dead path and
    // should fail rather than pass quietly.
    expect(composer).toMatch(/if \(process\.env\.BRAIN_USE_REASONING === 'never'\) return false;\s*\n\s*return true;/);
  });

  it('and it is handed the persona preamble — NOT the legacy assembled prompt', () => {
    // This is why DEF-222's rule 8 could not have reached B11, and it stays true: the reasoning
    // path never gained `assembleSystemPrompt`.
    //
    // UPDATED 2026-08-26 (DEF-248). The assertion used to read
    // `systemPrompt: personaForReasoning.systemPreamble,` verbatim. That pinned a FACT about the
    // world — what this path receives — because DEF-223's whole diagnosis rested on knowing it
    // exactly. It was never a requirement that the preamble travel ALONE, and reading it as one
    // would have made this test a lock on a defect: the owner's own Rules were absent from the
    // live reply path for the same reason rule 8 was.
    //
    // So the pin is kept and made precise: the reasoning path is still built from the persona
    // preamble and still does NOT use the legacy assembly, but it now also carries the standing
    // instructions. Both halves are asserted, so the next person changing this learns what is
    // deliberate rather than guessing from a string match.
    expect(composer).toMatch(/systemPrompt: reasoningSystemPrompt,/);
    expect(composer).toMatch(/reasoningSystemPrompt\s*=[\s\S]{0,400}personaForReasoning\.systemPreamble/);
    expect(composer).toMatch(/renderInstructionsBlock\(reasoningInstructions/);
    // The legacy assembler must still be absent from this path — that is DEF-223's actual claim.
    expect(composer).not.toMatch(/systemPrompt: assembleSystemPrompt\(/);
  });

  it('so the reasoning contract carries the rule itself, by reference', () => {
    expect(reasoning).toMatch(/\$\{PERSON_REFERENCE_RULE\}/);
    // UPDATED 2026-10-31 (DEF-371). The pin used to require the rule be the ONLY
    // import from personReference. That pinned the import's exact shape, not the
    // fact it exists for: one definition, imported by reference. The module now
    // also imports `statesPersonReferenceRule` — the dedup guard that stops the
    // rule printing twice since DEF-366 routed rule 8 here too. Same precedent as
    // the DEF-248 update above: keep the pin, make it precise.
    expect(reasoning).toMatch(/import \{ PERSON_REFERENCE_RULE, statesPersonReferenceRule \} from '\.\/personReference'/);
    expect(reasoning, 'one definition, not a second copy of the words')
      .not.toContain('NO GENDER IS RECORDED FOR ANYONE');
  });

  it('it is placed BEFORE the decision contract, where the worked examples are', () => {
    const rule = reasoning.indexOf('${PERSON_REFERENCE_RULE}');
    const contract = reasoning.indexOf('# Reasoning decision contract');
    expect(rule).toBeGreaterThan(-1);
    expect(contract).toBeGreaterThan(rule);
  });
});

describe('DEF-223 — the decline example stops teaching the defect', () => {
  it('B11\'s own case is worked WITHOUT a pronoun', () => {
    expect(reasoning).toContain("I can message Latif or give you Latif's number");
  });

  it('the old gendered example is gone', () => {
    expect(reasoning).not.toContain('I can message him or give you his number');
  });

  it('the example still teaches what it existed to teach', () => {
    // The point of the example is voice: address HIM, don't narrate the
    // conversation from outside. Removing the pronoun must not remove that.
    expect(reasoning).toContain('The user asked to place a call, which is a capability I do not have');
    expect(reasoning).toContain('the second describes the conversation from outside it');
    expect(reasoning).toContain('addressed TO HIM in your own voice');
  });

  it('no OTHER worked example in the contract genders a third party', () => {
    // The contract is where the model learns its phrasing. A single surviving
    // "his number" would re-teach exactly what the rule forbids.
    const contract = reasoning.slice(reasoning.indexOf('# Reasoning decision contract'));
    const decline = contract.slice(0, contract.indexOf('Output strictly this JSON shape'));
    expect(decline).not.toMatch(/\b(his|her|hers)\s+(number|email|phone|message|reply)\b/i);
  });
});

describe('DEF-223 — the legacy path gets the referent its rule names', () => {
  // Secondary, and said plainly: this path is NOT what produced B11 while
  // reasoning is on. It is fixed because DEF-222 left it with rule 8 naming
  // `refer_to` on every turn while `refer_to` shipped only inside a block gated
  // on `isActionTurn || factual` — a rule pointing at a field that is not there.
  it('the index carries names and NOTHING that is an action affordance', () => {
    const idx = renderPersonReferenceIndex('Latif', [candidate('Latif Bhutta')]);
    expect(idx).toContain('refer_to="Latif"');
    expect(idx, 'no email').not.toContain('@');
    expect(idx, 'no score').not.toMatch(/score/i);
    expect(idx, 'no routing instruction').not.toMatch(/delegateeEmail|dominant/i);
  });

  it('uses the SAME token the rule names, or the rule points at nothing', () => {
    expect(PERSON_REFERENCE_RULE).toContain('refer_to');
    expect(renderPersonReferenceIndex('Hamna', [candidate('Hamna Latif Bhutta')]))
      .toContain('refer_to="Hamna"');
  });

  it('one person resolved twice is one name, not two', () => {
    // A User row and its Entity twin both match; two lines would read as two
    // different people to refer to.
    const idx = renderPersonReferenceIndex('Hamna', [
      candidate('Hamna Latif Bhutta'),
      candidate('Hamna Latif Bhutta', { source: 'user', id: 7 }),
    ]);
    expect(idx.match(/refer_to=/g)).toHaveLength(1);
  });

  it('says nothing when nobody resolved', () => {
    expect(renderPersonReferenceIndex('Nobody', [])).toBe('');
  });

  it('the composer ships the index exactly when it withholds the full block', () => {
    expect(composer).toMatch(
      /if \(candidatesBlock && \(isActionTurn \|\| intent === 'factual'\)\) \{\s*\n\s*parts\.push\(candidatesBlock\);\s*\n\s*\} else if \(personIndexBlock\) \{/);
    expect(composer).toMatch(/parts\.push\(personIndexBlock\);/);
  });

  it('both renderings come from ONE resolution — the query was already paid for', () => {
    expect(composer).toMatch(/return \{ full: blocks\.join\('\\n\\n'\), index: indexes\.join\('\\n'\) \};/);
    expect(composer).toMatch(
      /const \{ full: candidatesBlock, index: personIndexBlock \} =\s*\n\s*await buildCandidatesBlockForTurn\(/);
  });
});
