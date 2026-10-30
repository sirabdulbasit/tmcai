/**
 * DEF-149 `instruction-as-preference` — the live classify path finally
 * carries the boundary: an instruction to ACT is never a note to file.
 *
 * The owner, 2026-08-12 (R-1, twice): "Chase her again" → "I've made a note
 * of that." An imperative to act was routed to `record_preference`; the
 * receipt was correct for that action — the action was wrong, and the chase
 * never happened. OPEN since 08-12. The nightly distiller's prompt learned
 * the lesson (DEF-348); the LIVE compose path — where the owner actually hit
 * it — stayed untouched until now.
 *
 * The class fix is model-governed, per the 2026-08-19 ruling and the DEF-333
 * rule-1a precedent (thrice reviewed SOUND): judgment text at the two places
 * the model DECIDES, no code guard. A code filter over imperative verbs would
 * be `detector-is-a-list-of-sentences` and would block genuinely explicit
 * "remember X" asks — the measured 42% class. The executor is untouched: an
 * explicit preference still stores unimpeded.
 *
 * Under test (the def333 pin pattern — the rules are template literals, so
 * source assertions pin exactly what the model receives):
 *  - rule 1b lives in CORE_CONVERSATIONAL_RULES (always-on, every surface),
 *    not an intent-specific block;
 *  - it names the verbatim owner case and forbids the filing receipt;
 *  - the record_preference ACTION GUIDANCE (the selection point) carries
 *    must-NOT-fire examples including the verbatim "chase her again";
 *  - the positive examples are NOT weakened — explicit preferences still fire.
 *
 * ITERATION-83 CORRECTION (Codex review, verdict WEAK): the blocks pinned
 * above feed only `assembleSystemPrompt` — the LEGACY path. The LIVE path is
 * `reasoningCompose`, whose prompt is persona + tenant rules + a DB-driven
 * action registry, and it read NONE of this. The remediation is two-sided and
 * the second describe block pins it where the live model actually looks:
 *  - the always-on half now rides `buildReasoningSystemPrompt` (DEF-366: one
 *    rule source, both paths, by construction);
 *  - the selection-point half now lives in the `record_preference` registry
 *    DESCRIPTION (seedActionDefinitions, upserted by type at every server
 *    start), rendered into the live prompt by the real `renderActionsBlock`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildReasoningSystemPrompt } from '../src/services/knowledge/brainComposer';
import { renderActionsBlock } from '../src/services/knowledge/reasoningCompose';
import { ACTIONS } from '../src/scripts/seedActionDefinitions';

const raw = fs.readFileSync(
  path.join(__dirname, '../src/services/knowledge/brainComposer.ts'),
  'utf8',
);

const coreStart = raw.indexOf('const CORE_CONVERSATIONAL_RULES = `');
const coreEnd = raw.indexOf('`;', coreStart);
const core = raw.slice(coreStart, coreEnd);

const guidanceStart = raw.indexOf('- **record_preference — capture user-stated preferences durably.**');
const guidanceEnd = raw.indexOf('\n- **', guidanceStart + 10);
const guidance = raw.slice(guidanceStart, guidanceEnd === -1 ? guidanceStart + 3000 : guidanceEnd);

describe('DEF-149 — rule 1b: an instruction to ACT is never a note to file', () => {
  it('lives inside CORE_CONVERSATIONAL_RULES (always-on, every surface), not an intent-specific block', () => {
    expect(coreStart).toBeGreaterThan(-1);
    expect(core).toContain('An instruction to ACT is never a note to file');
  });

  it('names the verbatim owner case, commands acting this turn, and forbids the filing receipt', () => {
    expect(core).toContain('chase her again');
    expect(core).toContain('emitting the matching action');
    expect(core).toContain("I've made a note of that");
    expect(core).toContain('a note means it will never happen');
  });

  it('draws the preference boundary by durability, not a verb list', () => {
    // the rule teaches the DISTINCTION (standing rule vs command) — the same
    // durability framing the gated nightly path uses — rather than enumerating
    // forbidden verbs for code to match
    expect(core).toContain('ONLY for how he wants things done as a standing rule');
    expect(core).toContain('a verb aimed at the world is an instruction');
  });

  it('the record_preference ACTION GUIDANCE (the selection point) carries must-NOT-fire examples with the verbatim case', () => {
    expect(guidanceStart).toBeGreaterThan(-1);
    expect(guidance).toContain('Examples that must NOT fire');
    expect(guidance).toContain('chase her again');
    expect(guidance).toContain('never file the command');
  });

  it('the positive examples are NOT weakened — explicit preferences still fire', () => {
    expect(guidance).toContain('remember I sign off as Best regards');
    expect(guidance).toContain('email_max_age_days');
    // and the executor path is untouched: recordExplicitMemory still reachable
    const executors = fs.readFileSync(
      path.join(__dirname, '../src/services/knowledge/internalActionExecutors.ts'), 'utf8',
    );
    expect(executors).toContain('executeRecordPreference');
    expect(executors).toContain('recordExplicitMemory');
  });
});

describe('DEF-149 — the boundary reaches the LIVE path (iteration-83 remediation of the WEAK review)', () => {
  it('the always-on half rides the real reasoning prompt builder (DEF-366), not only the legacy constant', () => {
    const live = buildReasoningSystemPrompt('persona-preamble', '');
    expect(live).toContain('An instruction to ACT is never a note to file');
    expect(live).toContain('chase her again');
    expect(live).toContain("I've made a note of that");
  });

  it('the live SELECTION POINT — record_preference\'s registry description — carries the boundary and the verbatim case', () => {
    const row = ACTIONS.find((a) => a.type === 'record_preference');
    expect(row).toBeTruthy();
    expect(row!.description).toContain('STANDING RULE');
    expect(row!.description).toContain('chase her again');
    expect(row!.description).toContain('filing receipt');
    expect(row!.description).toContain('a verb aimed at the world is an instruction');
  });

  it('the REAL renderer carries the description into the registry block the live model reads', () => {
    const row = ACTIONS.find((a) => a.type === 'record_preference')!;
    const block = renderActionsBlock([row]);
    expect(block).toContain('**record_preference**');
    expect(block).toContain('chase her again');
    expect(block).toContain('never reply with a filing receipt');
  });

  it('the positive selection path is NOT weakened — standing-rule language still names when to fire', () => {
    const row = ACTIONS.find((a) => a.type === 'record_preference')!;
    expect(row!.description).toContain('I prefer');
    expect(row!.description).toContain('remember that I sign off as Best regards');
    // and the schema is untouched, so an explicit preference still validates
    expect(row!.schema?.required).toEqual(['key', 'value']);
  });
});
