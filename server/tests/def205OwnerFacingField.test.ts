/**
 * DEF-205 — ONE field is owner-facing, and it is the same one on every decision.
 *
 * THE FIRED REGRESSION. `B11-capability-limit` C8 fell 100 -> 80. The reply
 * opened *"The user asked to place a WhatsApp call, which is a capability I do
 * not have. I am offering valid alternatives…"* — the judge: *"introduces a
 * subtle but noticeable self-referential distance, making it sound like Brain is
 * describing the interaction to a third party or logging an event, rather than
 * directly conversing with the user."*
 *
 * The content was correct. The VOICE was wrong, and not by accident: on a
 * decline the owner was handed `decline_reason` verbatim
 * (`reasoningCompose.applyDispatch.ts:53`), a field the contract describes as
 * "one-line honest reason" — an internal note ABOUT the turn. Only `answer_text`
 * is described as "the user-visible reply". Two fields could each become his
 * reply and only one was ever specified as his: the output contract's own
 * `protection-with-two-implementations`.
 *
 * Guards read code with comments stripped (DEF-195), except where the assertion
 * is deliberately about the CONTRACT TEXT the model is given — that text is the
 * mechanism here, not commentary on it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const p = (rel: string) => path.resolve(__dirname, '..', rel);
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const dispatchCode = strip(fs.readFileSync(p('src/services/knowledge/reasoningCompose.applyDispatch.ts'), 'utf8'));
const contractRaw = fs.readFileSync(p('src/services/knowledge/reasoningCompose.ts'), 'utf8');

describe('DEF-205 — the decline reply comes from the owner-facing field', () => {
  it('prefers answerText over declineReason', () => {
    // Mutation: reverting to `result.declineReason || ...` restores the exact
    // B11 defect — an internal note handed to the owner as his reply.
    expect(dispatchCode).toMatch(/answer:\s*result\.answerText \|\| result\.declineReason \|\|/);
    expect(dispatchCode).not.toMatch(/answer:\s*result\.declineReason \|\|/);
  });

  it('keeps declineReason as a fallback, so an old-shaped decision still says something true', () => {
    // Not removed: a decider that filled only the old field must not fall
    // through to the bracketed marker, which would be a regression in honesty.
    expect(dispatchCode).toMatch(/result\.declineReason/);
  });

  it('still ends at a bracketed system marker, never hardcoded English', () => {
    // AGENTS.md §2.4 / feedback_no_hardcoded_brain_replies: owner-facing text is
    // LLM-generated or a bracketed marker. Mutation: replacing the marker with a
    // plain sentence dies here.
    expect(dispatchCode).toMatch(/\[declined: no reason captured from decider\]/);
  });
});

describe('DEF-205 — the contract tells the model which field he reads', () => {
  it('marks answer_text as THE ONLY owner-facing field, required on decline', () => {
    expect(contractRaw).toMatch(/THE ONLY OWNER-FACING FIELD/);
    expect(contractRaw).toMatch(/Required for decision=answer AND decision=decline/);
  });

  it('marks decline_reason INTERNAL and says he never sees it', () => {
    // Mutation: restoring "<one-line honest reason>" leaves the model free to
    // write a note and have it delivered as prose.
    expect(contractRaw).toMatch(/INTERNAL one-line note on why you declined/);
    expect(contractRaw).toMatch(/he never sees this; do not write it as a reply/);
    expect(contractRaw).not.toMatch(/"decline_reason": "<one-line honest reason>"/);
  });

  it('shows the model the wrong voice next to the right one', () => {
    // The judge caught a register failure, so the contract now contrasts them
    // rather than describing the rule abstractly.
    expect(contractRaw).toMatch(/never "The user asked to place a call/);
    expect(contractRaw).toMatch(/describes the conversation from outside it/);
  });

  it('stops listing decline_reason as one of the mutually-exclusive OUTPUT fields', () => {
    // It is no longer an alternative to answer_text — it accompanies it.
    expect(contractRaw).toMatch(/Exactly ONE of \{action, action_plan, question, answer_text\} is non-null/);
    expect(contractRaw).not.toMatch(/Exactly ONE of \{action, action_plan, question, answer_text, decline_reason\}/);
  });

  it('describes the decline intent in second person, not about him', () => {
    // The old text — "the user asked for something genuinely impossible" — is
    // the register the model copied into the reply.
    expect(contractRaw).not.toMatch(/\*\*decline\*\*: the user asked for something genuinely impossible/);
    expect(contractRaw).toMatch(/\*\*decline\*\*: he asked for something genuinely impossible/);
  });
});
