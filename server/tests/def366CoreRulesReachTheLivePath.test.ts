/**
 * DEF-366 — ONE rule source, BOTH paths (`protection-with-two-implementations`,
 * §3 count 10 — the DEF-222/223/248/149 recurrence closed at the class).
 *
 * Four times a rule was written into CORE_CONVERSATIONAL_RULES and the owner
 * never met it: the constant feeds `assembleSystemPrompt` — the LEGACY path,
 * which runs only when BRAIN_USE_REASONING='never'. The live path
 * (`reasoningCompose`) was handed persona preamble + tenant rules alone, so
 * rule 8 (DEF-222), tenant rules (DEF-248) and finally rule 1b (DEF-149,
 * reviewed WEAK for exactly this) each had to be wired across BY HAND — and
 * the next rule missed again.
 *
 * The fix is construction, not another hand-wire: the live system prompt is
 * built by `buildReasoningSystemPrompt`, which includes the SAME
 * CORE_CONVERSATIONAL_RULES constant the legacy path reads. These tests
 * assert on the REAL builder's output — the def248 lesson: a source-pin on
 * the constant passes while the live path drops it, so pin the path.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildReasoningSystemPrompt } from '../src/services/knowledge/brainComposer';

const PREAMBLE = 'PERSONA-PREAMBLE-SENTINEL';
const TENANT_RULES = '# Standing instructions\n- [policy] **Evening hold** — Never send email after 6pm';

describe('DEF-366 — core rules reach the live reasoning prompt by construction', () => {
  const prompt = buildReasoningSystemPrompt(PREAMBLE, TENANT_RULES);

  it('carries rule 1b (DEF-149) — the instruction/preference boundary the owner actually hit', () => {
    expect(prompt).toContain('An instruction to ACT is never a note to file');
    expect(prompt).toContain('chase her again');
    expect(prompt).toContain("I've made a note of that");
  });

  it('carries the WHOLE block — 1a (DEF-333), 9 (DEF-288), 10 — not one hand-picked rule', () => {
    expect(prompt).toContain('consume the answer, never deflect');
    expect(prompt).toContain('A quoted message is a referent, never the question');
    expect(prompt).toContain('A greeting gets a greeting');
  });

  it('persona leads, tenant rules survive, and an empty rules block drops nothing else', () => {
    expect(prompt.startsWith(PREAMBLE)).toBe(true);
    expect(prompt).toContain('Never send email after 6pm');
    const bare = buildReasoningSystemPrompt(PREAMBLE, '');
    expect(bare.startsWith(PREAMBLE)).toBe(true);
    expect(bare).toContain('An instruction to ACT is never a note to file');
  });

  it('THE WIRING: the live call site builds its prompt through the builder, and reasoningCompose puts it at the top', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/services/knowledge/brainComposer.ts'), 'utf8',
    );
    const site = src.indexOf('const reasoningSystemPrompt = buildReasoningSystemPrompt(');
    expect(site).toBeGreaterThan(-1);
    const windowAfter = src.slice(site, site + 300);
    expect(windowAfter).toContain('personaForReasoning.systemPreamble');
    expect(windowAfter).toContain('reasoningRulesBlock');
    // the second link of the chain: the final live prompt is forged as
    // `${input.systemPrompt}` + contracts + registry, so what the builder
    // produced is what the model reads
    const rc = fs.readFileSync(
      path.join(__dirname, '../src/services/knowledge/reasoningCompose.ts'), 'utf8',
    );
    expect(rc).toContain('`${input.systemPrompt}');
  });
});
