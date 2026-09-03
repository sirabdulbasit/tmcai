/**
 * DEF-222 — DEF-221's rule was attached to evidence, so it shipped only when
 * the evidence did. `protection-with-two-implementations`.
 *
 * DEF-221 predicted its own falsifier: *"a reply still calls a contact 'he' or
 * 'she'."* The next scored run fired it. `iter-12-post-build.json`:
 *
 *     B11-capability-limit  "…or I can give you HER number if you'd like."
 *     B01-did-you-send      "…two overdue items delegated to HER"
 *
 * The scores went UP — B11 C5 90→95, C6 90→100, C4 85→90; B07 C4 85→90 with the
 * "Hamna Latif Bhutta feels formal" complaint gone — so the fix worked where it
 * arrived. **It did not arrive on those two turns**, and the reason is in the
 * code rather than in the model:
 *
 *   - the candidates block ships only when `isActionTurn || intent === 'factual'`
 *   - the open-items block only when `isActionTurn || day_brief || factual`
 *   - `looksLikeImperative` matches a leading verb from a fixed list, and
 *     `place` is not in it
 *
 * So B07 — *"Tell me what is outstanding with Hamna…"* — is an action turn and
 * got the rule. B11 — *"Can you place a WhatsApp call to Latif for me?"* — and
 * B01 — *"Did you send that message to Hamna?"* — are not, and did not. The
 * first test below pins that classification, because it is the whole diagnosis
 * and a future edit to the verb list would change it silently.
 *
 * The fix is placement, not wording: a rule about how to WRITE is an invariant
 * of the output, not a footnote on a data block. It now rides with the core
 * conversational rules, which ship on every turn including the casual prompt.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  PERSON_REFERENCE_RULE,
  statesPersonReferenceRule,
} from '../src/services/knowledge/personReference';

const composer = (() => {
  const raw = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/services/knowledge/brainComposer.ts'), 'utf8');
  // Comments stripped: a guard must read code, not prose about it (DEF-195).
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
})();

/**
 * `looksLikeImperative`, lifted verbatim from the composer so the diagnosis is
 * checked against the REAL predicate rather than my memory of it. The function
 * is module-private, so the guard below asserts these regexes are still the ones
 * in the source — an edit there fails here rather than quietly invalidating the
 * three classifications this file rests on.
 */
const LEADING = /^(add|delegate|send|schedule|reschedule|postpone|remind|snooze|draft|reply|create|forward|mark|close|cancel|delete|remove|update|change|book|set|email|ask|chase|follow|tell|note|log|move|push|shift|invite)\b/;
const BODY = /\b(please|kindly|can you|could you)\s+(add|delegate|send|schedule|reschedule|postpone|remind|snooze|draft|reply|create|forward|mark|close|cancel|delete|remove|update|change|book|set\s+up|email|ask|chase|follow up|tell|note|log|move|push|shift|invite)\b/;
const imperative = (q: string) => LEADING.test(q.trim().toLowerCase()) || BODY.test(q.trim().toLowerCase());

describe('DEF-222 — the diagnosis, pinned', () => {
  it('the copied predicate IS the one in the composer', () => {
    // Without this, the three classifications below could go on asserting a rule
    // the source no longer has.
    expect(composer).toContain(LEADING.source.replace(/^\^/, '^'));
    expect(composer).toContain(BODY.source);
  });

  it('B11 and B01 are NOT action turns — which is why the rule never reached them', () => {
    expect(imperative('Can you place a WhatsApp call to Latif for me?'),
      '"place" is not in the verb list').toBe(false);
    expect(imperative('Did you send that message to Hamna?'),
      'a question about a past send is not an imperative').toBe(false);
  });

  it('B07 IS one — and B07 is the case where the fix visibly worked', () => {
    expect(imperative('Tell me what is outstanding with Hamna, and which of those are already overdue.'))
      .toBe(true);
  });

  it('the two blocks that used to carry the rule are still conditional', () => {
    // Not a defect — evidence blocks SHOULD be conditional. The defect was
    // hanging an invariant off them.
    expect(composer).toMatch(/if \(candidatesBlock && \(isActionTurn \|\| intent === 'factual'\)\)/);
    expect(composer).toMatch(/if \(openItemsBlock && \(isActionTurn \|\| intent === 'day_brief' \|\| intent === 'factual'\)\)/);
  });
});

describe('DEF-222 — the rule now ships on every turn', () => {
  it('is part of the core conversational rules, by reference not by copy', () => {
    // Anchored on the INTERPOLATION, not on the rule being the last line of the template.
    // The original pattern required a closing backtick-semicolon straight after rule 8, which
    // was only ever true because rule 8 happened to end the block; DEF-288 added rules 9 and 10
    // after it and this went red without anything about rule 8 changing. What matters is that
    // the rule arrives BY REFERENCE — one definition, interpolated — rather than pasted, which
    // is the drift DEF-222 exists to prevent.
    expect(composer).toMatch(/^8\. \$\{PERSON_REFERENCE_RULE\}$/m);
    const start = composer.indexOf('const CORE_CONVERSATIONAL_RULES');
    const rules = composer.slice(start, composer.indexOf('const OUTPUT_SHAPE_RULES', start));
    expect(rules).toContain('${PERSON_REFERENCE_RULE}');
  });

  it('the CASUAL prompt gets it too — a small-talk turn can still name someone', () => {
    // `buildCasualPrompt` interpolates the constant directly, so rule 8 travels
    // with it. Asserted because that prompt deliberately strips almost
    // everything, and "almost" is where a rule goes missing.
    expect(composer).toMatch(/function buildCasualPrompt\([\s\S]{0,400}\$\{CORE_CONVERSATIONAL_RULES\}/);
  });

  it('survives a DB prompt-block override — the failure mode DEF-221 had, in a new costume', () => {
    // `core_conversational_rules` is overridable from `prompt_blocks`. A tenant
    // row written before rule 8 existed would silently drop it: the rule present
    // in the source and absent from the prompt, which is exactly what happened
    // to DEF-221 for a different reason.
    expect(composer).toMatch(
      /const coreRules = ruleBlock\('core_conversational_rules', CORE_CONVERSATIONAL_RULES\);/);
    expect(composer).toMatch(
      /if \(!statesPersonReferenceRule\(coreRules\)\) parts\.push\(PERSON_REFERENCE_RULE\);/);
  });

  it('the re-attachment is CONDITIONAL, so the default prompt does not say it twice', () => {
    // The predicate answers both cases, so this asserts the behaviour rather
    // than the source line: the shipped constant satisfies it, an overriding
    // block that omits the rule does not.
    expect(statesPersonReferenceRule(PERSON_REFERENCE_RULE)).toBe(true);
    expect(statesPersonReferenceRule('# Core conversational rules (always apply)\n1. Be nice.'))
      .toBe(false);
  });

  it('the evidence blocks no longer carry it — one placement, not two', () => {
    expect(composer, 'open-items block').not.toMatch(/referenceRule/);
    const resolver = fs.readFileSync(
      path.resolve(__dirname, '..', 'src/services/knowledge/contactResolver.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(resolver).not.toMatch(/PERSON_REFERENCE_RULE/);
    expect(resolver, 'refer_to is DATA and stays with the candidate').toContain('refer_to=');
  });
});
