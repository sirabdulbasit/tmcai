/**
 * DEF-248, deck half — `Asked Brain where a rule or notification came from and
 * was given an invented source`.
 *
 * Owner, verbatim: *"from where you got those rules of brain"* → *"My
 * operating rules come from my core programming."* And separately: told he had
 * *"explicitly chosen to receive this style of notification from the
 * settings"* — a choice he never made. Both inventions have the same
 * mechanism: the model holds a block of rules with NO ORIGIN STATED, so asked
 * for one it supplies a plausible one. The real provenance — `authoredBy`,
 * `createdAt`, and `originalText` (the author's verbatim sentence) — has been
 * persisted on every rule since creation and was never selected or rendered.
 *
 * DEF-199's lesson, applied to rules: honesty instructions cannot fix a join
 * that is absent from the context. So the join is performed in the ONE
 * renderer all three consumers share (legacy composer at brainComposer:3331,
 * reasoning composer at :2723, voice context), and the provenance answer is
 * licensed from it.
 */
import { describe, it, expect } from 'vitest';
import {
  renderInstructionsBlock,
  type ActiveInstructionRow,
} from '../src/services/knowledge/instructionService';

function rule(over: Partial<ActiveInstructionRow> = {}): ActiveInstructionRow {
  return {
    id: 'r1',
    title: 'Always reply in English',
    kind: 'rule' as any,
    scope: 'user' as any,
    subject: null, dueAt: null, condition: null, action: null,
    originalText: 'brain should always reply in english',
    createdAt: '2026-08-26T09:15:00.000Z',
    authoredBy: 'user:2',
    ...over,
  } as ActiveInstructionRow;
}

describe('DEF-248 — every rule carries its recorded provenance', () => {
  it('the rule line names its recorded date', () => {
    const out = renderInstructionsBlock([rule()]);
    expect(out).toContain('brain should always reply in english');
    // Mutation: dropping the provenance join dies here.
    expect(out).toContain('recorded 2026-08-26');
  });

  it('a missing date is STATED, never guessed — and stated as missing date, not missing rule', () => {
    const out = renderInstructionsBlock([rule({ createdAt: null as any })]);
    expect(out).toContain('recording date not on file');
    // The block tells the model exactly how to answer for such a row: the
    // rule is real, quote its words, say the date was not kept.
    expect(out).toMatch(/still a real,\s*recorded rule/);
    expect(out).toMatch(/say the date was not\s*kept/);
  });

  it('never renders the raw authoredBy key — a bare key invites a borrowed name (DEF-199)', () => {
    const out = renderInstructionsBlock([rule({ authoredBy: 'user:2' })]);
    expect(out).not.toContain('user:2');
  });

  it('stays empty for no rules — an absent block cannot invent anything', () => {
    expect(renderInstructionsBlock([])).toBe('');
  });
});

describe('DEF-248 — the provenance answer is licensed from the list, and the invented sources are named', () => {
  const out = renderInstructionsBlock([rule()]);

  it('states where rules come from: a person, verbatim, on a date — never core programming', () => {
    expect(out).toMatch(/every rule below was stated by a PERSON/);
    expect(out).toMatch(/the quoted sentence is the author's own words/);
    // The exact invented source he was given, named as forbidden.
    expect(out).toMatch(/None of them are\s*"core programming", system defaults/);
  });

  it('licenses the answer from THIS list — quote the rule\'s words and its recorded date', () => {
    expect(out).toMatch(/answer from THIS list: quote the rule's own words and its\s*recorded date/);
  });

  it('absence is honest: not in the list → no recorded rule, never an attributed source', () => {
    expect(out).toMatch(/say plainly that you\s*have no recorded rule for it/);
    expect(out).toMatch(/never attribute it to your programming/);
  });

  it('forbids the second invented source: claiming HE chose something no row shows', () => {
    // "The user has explicitly chosen to receive this style of notification
    // from the settings" — the other half of the deck tag.
    expect(out).toMatch(/never tell\s*him he chose or configured something unless a recorded rule or a settings block you can\s*actually see says he did/);
  });
});
