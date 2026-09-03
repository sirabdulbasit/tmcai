/**
 * DEF-288 — answer the message that arrived, not a question sitting in context.
 *
 * TWO OCCURRENCES IN TWO DAYS, and the second one (2026-09-03 18:02, CL-053) is why this is a
 * structural fix rather than another patch:
 *
 *   He quoted Brain's own reminder — "Just a reminder that your task 'Provide leadership and
 *   commercial support for TMC projects' is now overdue. Shall I mark it as done, chase the
 *   delegatee, or push the date forward for you?" — and asked:  "from where you get it?"
 *
 *   Brain replied:  "I haven't taken any action on that task yet; I'd need to verify the status
 *   first."
 *
 * That answers the QUOTED question ("shall I mark it as done?"), not his. The day before, "from
 * where you get this?" got "I haven't done that yet; I'll need to check the project's status
 * first", and "Hi" got "I haven't done anything yet, but if you want me to check for previous
 * results first, just say 'go ahead'".
 *
 * ROOT CAUSE — an absence, not a bug. DEF-267(b) added the `[replying to: "..."]` marker to the
 * turn so the model could ground pronouns, and never added a rule saying what the marker MEANS.
 * So a quoted block that ends in a question reads as the question to answer. Confirmed by
 * searching the whole prompt surface: before this fix, nothing anywhere described the marker.
 *
 * THE DATA WAS NEVER MISSING, which is the part worth keeping straight. `open_items.source_feed`
 * is populated on 336 of 336 rows, this item carries `source_feed='gchat'` with a message ref
 * and a 2026-08-29 creation date, and `brainComposer` already renders `source=… source_ref=…`
 * into the block. Brain had the answer in front of it and answered a different question. This is
 * NOT DEF-260 (provenance not stored) recurring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const composer = readFileSync(
  join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf-8');

/** The core rules block, which every intent receives. */
function coreRules(): string {
  const start = composer.indexOf('const CORE_CONVERSATIONAL_RULES');
  expect(start).toBeGreaterThan(0);
  const end = composer.indexOf('const OUTPUT_SHAPE_RULES', start);
  expect(end).toBeGreaterThan(start);
  return composer.slice(start, end);
}

describe('DEF-288 — the quoted block is a referent, not the question', () => {
  it('the core rules say what the replying-to marker means', () => {
    // The marker shipped in DEF-267(b) with no rule attached. That absence is the defect.
    const rules = coreRules();
    expect(rules).toContain('replying to');
    expect(rules).toMatch(/referent, never the question/i);
  });

  it('states explicitly that a question inside the quote was Brain\'s own', () => {
    // Without this the model has no way to tell "Shall I mark it as done?" — its own words,
    // quoted back — from something it is being asked.
    const rules = coreRules();
    expect(rules).toMatch(/that question was YOURS to HIM/);
  });

  it('says what "from where you get it" is actually asking for', () => {
    // Provenance, which the block already carries as source= / source_ref=. Naming the
    // question type is what turns an available fact into the right answer.
    const rules = coreRules();
    expect(rules).toMatch(/PROVENANCE/);
  });

  it('lives in the CORE rules, which every intent receives', () => {
    // Not in a factual-only or action-only branch: the failing turns were conversational.
    const rules = coreRules();
    expect(rules).toContain('always apply');
    expect(rules.indexOf('referent, never the question')).toBeGreaterThan(0);
  });
});

describe('DEF-288 — a queued question is not the question either', () => {
  it('covers the second route: an outstanding question of Brain\'s own', () => {
    // The same failure reached him through the prompt queue rather than a quote, on the same
    // day. One rule for one class, or the half that is not covered recurs.
    const rules = coreRules();
    expect(rules).toMatch(/Any other question in your context is not/i);
  });

  it('says a greeting gets a greeting', () => {
    // "Hi" -> "I haven't done anything yet, but if you want me to check for previous results
    // first, just say go ahead" is the instance this clause names.
    expect(coreRules()).toMatch(/A greeting gets a greeting/);
  });

  it('allows the outstanding question to be asked AFTER, not instead', () => {
    // Suppressing Brain's own questions entirely would trade this defect for the missed-ask
    // defect he also reported. The rule reorders; it does not silence.
    expect(coreRules()).toMatch(/ask it AFTER answering what he actually said/);
  });
});

describe('DEF-288 — the provenance really is available to answer with', () => {
  it('the open-items block renders source_feed and source_ref', () => {
    // If this ever stops being true, the rule above would be asking the model to answer from
    // data it does not have, and the honest answer would change. Asserted so the two stay
    // coupled.
    expect(composer).toContain('sourceFeed: true, sourceRef: true');
    expect(composer).toContain('source=${r.sourceFeed}');
  });
});
