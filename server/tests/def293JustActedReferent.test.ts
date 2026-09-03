/**
 * DEF-293 — deck tag: `Answered a nudge, then asked which item Brain meant;
 * Brain could not name the item it had just acted on and offered unrelated
 * items` (DEF-280 + DEF-282, closed as one class).
 *
 * CL-046: he answered a due-nudge with "done"; asked "what you got it?" thirty
 * seconds later, Brain offered two unrelated items. Session 21: his "Done" was
 * refused by the transition matrix; asked "which approval?", Brain again named
 * unrelated items. Both referents were stored the whole time — the question
 * and his answer in `brain_prompt_queue`, the refusal WITH its recorded reason
 * in `item_status_history` — and neither reached the model's context. The fix
 * surfaces both in the dispatch-ledger block that BOTH composer paths already
 * read, with titles joined (DEF-199) and the referent rule beside the data
 * (DEF-165's finding).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  prompts: [] as any[],
  transitions: [] as any[],
  items: [] as any[],
  promptReadThrows: false,
  transitionReadThrows: false,
}));

vi.mock('../src/db/prisma', () => {
  const p = {
    brainActionArtifact: { findMany: async () => [] },
    whatsAppMessage: { findMany: async () => [] },
    brainPromptQueue: {
      findMany: (args: any) => {
        if (state.promptReadThrows) throw new Error('boom');   // SYNCHRONOUS throw — the DEF-274 shape
        // Scope assertions live here so every test enforces them.
        expect(args.where.clientNumber).toBe('TMC-0001');
        expect(args.where.userId).toBe(2);
        return Promise.resolve(state.prompts);
      },
    },
    itemStatusHistory: {
      findMany: (args: any) => {
        if (state.transitionReadThrows) throw new Error('boom');
        expect(args.where.clientNumber).toBe('TMC-0001');
        expect(args.where.userId).toBe(2);
        return Promise.resolve(state.transitions);
      },
    },
    openItem: {
      findMany: async (args: any) => {
        expect(args.where.clientNumber).toBe('TMC-0001');
        expect(args.where.userId).toBe(2);
        return state.items;
      },
    },
  };
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async () => 36,
}));

import { buildDispatchLedgerBlock } from '../src/services/knowledge/dispatchLedgerService';

const T = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000);

beforeEach(() => {
  state.prompts = [];
  state.transitions = [];
  state.items = [];
  state.promptReadThrows = false;
  state.transitionReadThrows = false;
});

describe('DEF-293 — what Brain just asked, and what he answered, reaches the context', () => {
  it('THE CL-046 SHAPE: the answered nudge is on record with its item, question and his answer', async () => {
    state.prompts = [{
      question: 'Did you attend the TMC <> InDrive kickoff? Let me know and I can mark it as done.',
      openItemId: 'indrive1', sentAt: T(2), answeredAt: T(1), answerText: 'done', state: 'answered',
    }];
    state.items = [{ id: 'indrive1', title: 'Attend: TMC <> InDrive kickoff' }];
    const out = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(out).toContain('"Attend: TMC <> InDrive kickoff"');
    expect(out).toContain('Did you attend the TMC <> InDrive kickoff?');
    expect(out).toMatch(/HE ANSWERED .*: "done"/);
  });

  it('an unanswered prompt renders as pending, never as answered', async () => {
    state.prompts = [{
      question: 'What deadline should I put on this?',
      openItemId: null, sentAt: T(30), answeredAt: null, answerText: null, state: 'sent',
    }];
    const out = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(out).toContain('no answer yet');
    expect(out).not.toContain('HE ANSWERED');
  });
});

describe('DEF-293 — a refused transition carries its recorded reason', () => {
  it('THE SESSION-21 SHAPE: the refusal and its reason are in front of the model', async () => {
    state.transitions = [{
      openItemId: 'indrive1', fromStatus: 'new', toStatus: 'closed',
      outcome: 'rejected', reason: 'guards failed: approval', createdAt: T(1),
    }];
    state.items = [{ id: 'indrive1', title: 'Attend: TMC <> InDrive kickoff' }];
    const out = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(out).toContain('"Attend: TMC <> InDrive kickoff": new → closed REFUSED');
    expect(out).toContain('recorded reason: guards failed: approval');
  });

  it('an accepted transition renders as done, not refused', async () => {
    state.transitions = [{
      openItemId: 'a1', fromStatus: 'new', toStatus: 'closed',
      outcome: 'accepted', reason: null, createdAt: T(5),
    }];
    state.items = [{ id: 'a1', title: 'Send the revised pricing' }];
    const out = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(out).toContain('"Send the revised pricing": new → closed ✓');
    // Scoped to the data line — the standing referent RULE legitimately names
    // "A REFUSED line", so a whole-block match would always fail.
    expect(out).not.toMatch(/→ closed REFUSED/);
  });
});

describe('DEF-293 — DEF-199 and DEF-085 disciplines hold', () => {
  it('a missing title is declared unnameable — never a bare id, never a borrowed name', async () => {
    state.transitions = [{
      openItemId: 'cmxyz123', fromStatus: 'new', toStatus: 'closed',
      outcome: 'rejected', reason: 'x', createdAt: T(1),
    }];
    state.items = []; // title join finds nothing
    const out = await buildDispatchLedgerBlock(2, 'TMC-0001');
    // DEF-301 changed the WORDING here, not the rule. The old single sentence
    // ("an item whose title is not on record — report it as one you cannot name, never borrow a
    // title") was rendered for prompts that had no item at all, so it asserted a false premise
    // and carried policy prose inside a data row. It is now two honest cases, and the
    // never-borrow rule is stated once in the header. Both halves of this test's intent survive:
    // the missing title is declared unnameable, and the bare id is still never shown.
    expect(out).toContain('on record but whose title I could not read');
    expect(out).toContain('borrowing a title');
    expect(out).not.toContain('cmxyz123');
  });

  it('a FAILED read renders unavailable — never a false "none" (and a SYNC throw is caught)', async () => {
    state.promptReadThrows = true;      // throws before any promise exists — DEF-274's exact gap
    state.transitionReadThrows = true;
    const out = await buildDispatchLedgerBlock(2, 'TMC-0001');
    // ↻ iteration 72: both records unreadable → ONE honest sentence, and
    // never the empty-fact wording that would read as a true zero.
    expect(out).toContain('neither record could be read');
    expect(out).not.toContain('you asked him nothing');
    expect(out).not.toContain('attempted no status change');
  });

  it('genuinely empty windows are stated as facts, not omitted', async () => {
    const out = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(out).toContain('you asked him nothing and attempted no status change in the last 36h');
  });
});

describe('↻ DEF-293 (iteration 72) — one time-ordered list: "most recent" is true by construction', () => {
  it('a newer transition renders ABOVE an older answered prompt — Codex LOW finding 2', async () => {
    // The reviewer's failure scenario, verbatim: "a refusal at 10:02 and a
    // prompt-answer at 10:05 both render at the top of their own block; a bare
    // \"which one?\" could resolve to the refusal if the model reads 'above'
    // positionally." One merged list makes position and recency the same
    // thing. Mutation: restoring per-type sub-blocks dies here.
    state.prompts = [{
      question: 'Did you attend the kickoff?', openItemId: 'a1',
      sentAt: T(30), answeredAt: T(20), answerText: 'done', state: 'answered',
    }];
    state.transitions = [{
      openItemId: 'b2', fromStatus: 'new', toStatus: 'closed',
      outcome: 'rejected', reason: 'approval', createdAt: T(5),
    }];
    state.items = [{ id: 'a1', title: 'Kickoff' }, { id: 'b2', title: 'Budget sign-off' }];
    const out = await buildDispatchLedgerBlock(2, 'TMC-0001');
    const refusalAt = out.indexOf('"Budget sign-off": new → closed REFUSED');
    const promptAt = out.indexOf('"Kickoff"');
    expect(refusalAt).toBeGreaterThan(-1);
    expect(promptAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeLessThan(promptAt);   // newest (5 min ago) on top
  });

  it('an answered prompt sorts by its ANSWER time — the newest fact on the exchange', async () => {
    // Asked long ago, answered seconds ago: after "done", "what you got it?"
    // means THAT exchange, so it must outrank a transition from an hour ago.
    state.prompts = [{
      question: 'Did you attend?', openItemId: 'a1',
      sentAt: T(600), answeredAt: T(1), answerText: 'done', state: 'answered',
    }];
    state.transitions = [{
      openItemId: 'b2', fromStatus: 'new', toStatus: 'closed',
      outcome: 'accepted', reason: null, createdAt: T(60),
    }];
    state.items = [{ id: 'a1', title: 'Kickoff' }, { id: 'b2', title: 'Budget sign-off' }];
    const out = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(out.indexOf('"Kickoff"')).toBeLessThan(out.indexOf('"Budget sign-off"'));
  });

  it('one readable + one unreadable record: the rows render AND the unreadable half is NAMED', async () => {
    state.transitionReadThrows = true;
    state.prompts = [{
      question: 'Did you attend?', openItemId: null,
      sentAt: T(5), answeredAt: null, answerText: null, state: 'sent',
    }];
    const out = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(out).toContain('Did you attend?');
    expect(out).toContain('the item-status-change record could not be read');
  });
});

describe('DEF-293 — the referent rule sits beside the referents', () => {
  it('licenses "the most recent line is what he means" and forbids offering unrelated items', async () => {
    const out = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(out).toMatch(/THE REFERENT IS IN THIS\s*RECORD, and the list above is NEWEST FIRST: its TOP line is the most recent thing/);
    expect(out).toMatch(/A REFUSED line is the answer to "why isn't it closed"/);
    expect(out).toMatch(/Never offer other items from elsewhere in your context\s*while a line here matches the moment/);
  });
});
