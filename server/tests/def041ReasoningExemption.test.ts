/**
 * DEF-041 — a false statement reached a real person under the owner's name.
 *
 * 2026-08-05, 14:07 PKT. Brain told the owner:
 *
 *     "My apologies for the misunderstanding, Sir. I will delegate all four
 *      unassigned items to Hamna Latif Bhutta now."
 *
 * It delegated nothing. It then emailed Hamna, from basit.ahmed@tmcltd.com:
 * "These items have been delegated to you: …". Four minutes later, asked to
 * list Hamna's items, it correctly answered that she has none.
 *
 * ROOT CAUSE — not a missing guard. The guard existed, was reached, and was
 * skipped. `validateBeforeRender` ran (brainAskRoutes.ts:164, on the WhatsApp
 * path too), and its empty-promise rule was disabled by:
 *
 *     const emptyPromiseEligible = !sourceIsReasoning && !hasStructuredState;
 *
 * `sourceIsReasoning` is true for the DEFAULT path (reasoning, since f8ff5a1),
 * so the rule was off in production while its unit tests stayed green — they
 * call claimsCompletion() directly and never exercise the validator.
 *
 * The exemption had a real motivation (2026-05-22: a valid clarifying question
 * was overwritten). But that case, and every other it named, is already covered
 * by the two conditions on either side of it — structured state, or a dispatch
 * that actually succeeded. The path check was redundant, and the redundancy is
 * what shipped a lie.
 *
 * THE RULE THIS FILE ENFORCES: judge the STATE of the turn, never the code path
 * that produced it. A path-shaped exemption silently widens every time someone
 * adds a path.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { validateBeforeRender } from '../src/services/knowledge/responseValidator';
import { EMPTY_PROMISE_RE } from '../src/services/knowledge/brainComposer';

const base = {
  citedPageIds: [] as string[],
  gaps: [] as string[],
  sources: [] as Array<{ type: string; id: any; snippet: string }>,
};

/** The exact sentence Brain sent the owner, verbatim from the transcript. */
const THE_LIE = 'My apologies for the misunderstanding, Sir. I will delegate all '
  + 'four unassigned items to Hamna Latif Bhutta now.';

describe('DEF-041 — a promise with no dispatch is blocked on EVERY path', () => {
  it('catches the exact production sentence on the reasoning path', () => {
    const out = validateBeforeRender({
      ...base,
      answer: THE_LIE,
      action: null,
      actionResult: null,
      source: 'reasoning', // the default path — this is what was exempt
    } as any);

    expect(out.ok, 'the sentence that was emailed to a colleague must not pass').toBe(false);
    expect(out.violations.map((v) => v.rule)).toContain('empty_promise');
  });

  it('catches it on the legacy path too — the fix is path-independent', () => {
    const out = validateBeforeRender({
      ...base, answer: THE_LIE, action: null, actionResult: null, source: 'legacy',
    } as any);
    expect(out.ok).toBe(false);
  });

  it('blocks a past-tense fabrication as well as a future promise', () => {
    for (const answer of [
      'I have delegated all four items to Hamna.',
      'These items have been delegated to you.',
      'Done — delegated to Hamna Latif Bhutta.',
    ]) {
      const out = validateBeforeRender({
        ...base, answer, action: null, actionResult: null, source: 'reasoning',
      } as any);
      expect(out.ok, `must block: ${answer}`).toBe(false);
    }
  });
});

describe('DEF-041 — the false positives the exemption existed to prevent stay prevented', () => {
  it('a clarifying question is NOT blocked (the 2026-05-22 regression)', () => {
    const out = validateBeforeRender({
      ...base,
      answer: 'Which Yousaf should I delegate this to, Sir?',
      action: null,
      actionResult: { ok: false, message: 'clarification_needed' },
      source: 'reasoning',
    } as any);
    expect(out.ok).toBe(true);
  });

  it('a preview awaiting confirmation is NOT blocked', () => {
    const out = validateBeforeRender({
      ...base,
      answer: 'Delegate "ShireMe Recruiting Portal Application Testing" to Hamna Latif Bhutta',
      action: null,
      actionResult: { ok: false, message: 'preview_required' },
      source: 'reasoning',
    } as any);
    expect(out.ok).toBe(true);
  });

  it('a dispatch that actually succeeded is NOT blocked', () => {
    const out = validateBeforeRender({
      ...base,
      answer: 'Delegated "Vision Metric Integration" to Hamna Latif Bhutta.',
      action: null,
      actionResult: { ok: true, artifactId: 'art_1', message: 'delegated' },
      source: 'reasoning',
    } as any);
    expect(out.ok).toBe(true);
  });

  it('bracketed system markers from failed plans are NOT blocked', () => {
    for (const message of ['plan_invalid: missing target', 'plan_persist_failed', 'schema_violation: bad slot']) {
      const out = validateBeforeRender({
        ...base,
        answer: '[action_plan validation failed]',
        action: null,
        actionResult: { ok: false, message },
        source: 'reasoning',
      } as any);
      expect(out.ok, `must not block marker: ${message}`).toBe(true);
    }
  });
});

describe('DEF-041 — the path-shaped exemption must not come back', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'knowledge', 'responseValidator.ts'), 'utf8');
  // Strip comments first — this file's own explanation names the old
  // expression, and prose has matched its own assertion four times in this repo.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('there is exactly ONE empty-promise regex, owned by brainComposer', () => {
    // The validator used to define its own, weaker copy under a comment
    // claiming the two were in sync. They were not, and the weaker one was the
    // one on the live path — it matched neither sentence in the 14:07 incident.
    expect(
      CODE,
      'responseValidator must IMPORT EMPTY_PROMISE_RE, never redefine it. '
      + 'Two implementations of a guard means one real guard and one fiction.',
    ).not.toMatch(/(?:const|let|var)\s+EMPTY_PROMISE_RE\s*=/);
    expect(CODE).toMatch(/import\s*\{[^}]*EMPTY_PROMISE_RE[^}]*\}\s*from/);
  });

  it('the canonical regex covers the two forms that actually escaped', () => {
    // Regression on the shapes, not just the plumbing: "I will …" (future
    // promise) and passive voice (the email body sent to Hamna).
    expect(EMPTY_PROMISE_RE.test('I will delegate all four unassigned items to Hamna Latif Bhutta now.')).toBe(true);
    expect(EMPTY_PROMISE_RE.test('These items have been delegated to you.')).toBe(true);
  });

  it('eligibility is decided by turn state, not by result.source', () => {
    const line = CODE.match(/const emptyPromiseEligible\s*=.*/)![0];
    expect(line).toContain('hasStructuredState');
    expect(
      line,
      'Re-introducing a source/path check here disables the rule on whichever '
      + 'path happens to be default. DEF-041 is what that costs.',
    ).not.toMatch(/sourceIsReasoning|result\.source/);
  });
});
