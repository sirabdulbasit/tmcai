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
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

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
