/**
 * DEF-371 — the person-reference rule reaches the reasoning prompt EXACTLY ONCE
 * (`protection-with-two-implementations` — the residue Codex it-83 named, LOW #2).
 *
 * DEF-366 routed CORE_CONVERSATIONAL_RULES (whose rule 8 IS
 * PERSON_REFERENCE_RULE) into the live reasoning prompt, while
 * `reasoningCompose` kept its own unconditional hand-wire of the same rule —
 * so every live turn printed it twice. The legacy path already guards this
 * doubling (`statesPersonReferenceRule`, brainComposer); DEF-371 puts the SAME
 * guard on the reasoning path: the standalone add survives only as the
 * fallback for a caller whose prompt does not already state the rule.
 *
 * Two deliveries that cannot disagree and cannot stack — asserted on REAL
 * output (the def248 lesson: pin the path, not the constant), plus a source
 * pin so an unconditional re-add goes red instead of quietly doubling again.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { buildReasoningSystemPrompt } from '../src/services/knowledge/brainComposer';
import { personReferenceRuleBlock } from '../src/services/knowledge/reasoningCompose';
import { PERSON_REFERENCE_RULE, statesPersonReferenceRule } from '../src/services/knowledge/personReference';

// The marker statesPersonReferenceRule itself keys on — counting it counts the rule.
const MARKER = 'NO GENDER IS RECORDED FOR ANYONE';
const occurrences = (s: string): number => s.split(MARKER).length - 1;

const PREAMBLE = 'PERSONA-PREAMBLE-SENTINEL';
const TENANT_RULES = '# Standing instructions\n- [policy] **Evening hold** — Never send email after 6pm';

describe('DEF-371 — rule 8 lands once on the live reasoning path', () => {
  it('the LIVE shape: a DEF-366-built prompt already states the rule, so the fallback adds nothing', () => {
    const live = buildReasoningSystemPrompt(PREAMBLE, TENANT_RULES);
    expect(statesPersonReferenceRule(live)).toBe(true);
    expect(personReferenceRuleBlock(live)).toBe('');
    expect(occurrences(live + personReferenceRuleBlock(live))).toBe(1);
  });

  it('a BARE caller (the def223 guarantee) still gets the rule — exactly once', () => {
    const bare = `${PREAMBLE}\n\nno rules here`;
    const assembled = bare + personReferenceRuleBlock(bare);
    expect(occurrences(assembled)).toBe(1);
    expect(assembled).toContain(PERSON_REFERENCE_RULE);
  });

  it('the fallback cannot stack: once the rule is in, a second pass adds nothing', () => {
    const bare = PREAMBLE;
    const once = bare + personReferenceRuleBlock(bare);
    expect(personReferenceRuleBlock(once)).toBe('');
  });
});

describe('DEF-371 — the wiring, pinned in source so a re-add goes red', () => {
  const rc = fs.readFileSync(
    path.join(__dirname, '../src/services/knowledge/reasoningCompose.ts'), 'utf8',
  );

  it('the decision-contract template builds through the guard, not a bare interpolation', () => {
    expect(rc).toContain('`${input.systemPrompt}${personReferenceRuleBlock(input.systemPrompt)}');
  });

  it('ONE reference to the rule in the whole module — an unconditional second add fails here', () => {
    expect(rc.match(/\$\{PERSON_REFERENCE_RULE\}/g)).toHaveLength(1);
  });

  it('one predicate, both paths: the reasoning guard is the SAME function the legacy path uses', () => {
    expect(rc).toMatch(/import \{ PERSON_REFERENCE_RULE, statesPersonReferenceRule \} from '\.\/personReference'/);
    const composer = fs.readFileSync(
      path.join(__dirname, '../src/services/knowledge/brainComposer.ts'), 'utf8',
    );
    expect(composer).toMatch(/if \(!statesPersonReferenceRule\(coreRules\)\) parts\.push\(PERSON_REFERENCE_RULE\);/);
  });
});
