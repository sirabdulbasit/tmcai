/**
 * DEF-301 — the block that fixes DEF-280/282 was itself producing three wrong lines.
 *
 * DEF-293 added "what you recently ASKED him" and "item status changes you attempted" to the
 * dispatch-ledger block, and it works: rendering it against live data shows the exact referent
 * DEF-282 needed — `"Attend: TMC <> InDrive technical integration kickoff": NEW → CLOSED REFUSED
 * — recorded reason: approval required, none provided`.
 *
 * Rendering it also showed three defects in the shipped version, none of which a test would have
 * caught because they are about what the line SAYS:
 *
 *   1. The two most recent lines rendered their date as `?`. `at` was `sentAt` alone, and a
 *      prompt can be answered without ever being marked sent. Not cosmetic: the block's own
 *      referent rule is "the most recent line above is the thing he means", and an undated line
 *      cannot be ordered.
 *   2. Every prompt with no `openItemId` was rendered "you asked about an item whose title is not
 *      on record — report it as one you cannot name, never borrow a title". Most of those were
 *      never about an item; they are relayed messages. So the line asserted a false premise and
 *      argued policy inside a data row — DEF-273's exact lesson, where the prose won.
 *   3. A notification's stored `question` can be a system marker, so the block showed
 *      `[selfpruning_withdrawn: {...}]` as something Brain had asked him. He never saw those
 *      characters; the delivery path expands them into prose. The record and the conversation
 *      disagreed, and the record is what the model reasons from.
 *
 * Two wrong turns while fixing (3) are recorded in the code, because both looked right: the
 * invisible marker sentinel defeats every `[`-anchored matcher, and `isWholeMarker` excludes `]`
 * so it returns false for any marker whose JSON body contains an array.
 */
import { describe, it, expect, vi } from 'vitest';

const findMany = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: {
    brainPromptQueue: { findMany: (...a: unknown[]) => findMany('prompt', ...a) },
    itemStatusHistory: { findMany: (...a: unknown[]) => findMany('history', ...a) },
    openItem: { findMany: (...a: unknown[]) => findMany('item', ...a) },
    brainActionArtifact: { findMany: () => Promise.resolve([]) },
    $queryRawUnsafe: () => Promise.resolve([]),
  },
}));

import { buildDispatchLedgerBlock } from '../src/services/knowledge/dispatchLedgerService';
import { systemMarker } from '../src/services/knowledge/systemMarker';

const MARKER = systemMarker(
  'selfpruning_withdrawn: {"count":1,"titles":["Discuss Ghazanfer\'s off-track objectives"]}',
);

function stub(prompts: any[], history: any[] = [], items: any[] = []) {
  findMany.mockReset();
  findMany.mockImplementation((which: string) => {
    if (which === 'prompt') return Promise.resolve(prompts);
    if (which === 'history') return Promise.resolve(history);
    if (which === 'item') return Promise.resolve(items);
    return Promise.resolve([]);
  });
}

const ANSWERED = new Date('2026-09-03T09:05:00Z');
const QUEUED = new Date('2026-09-03T07:42:00Z');

describe('DEF-301 — no ledger line is undated', () => {
  it('falls back to queuedAt when the prompt was answered but never marked sent', async () => {
    stub([{
      question: 'anything', openItemId: null, sentAt: null, queuedAt: QUEUED,
      answeredAt: ANSWERED, answerText: 'ok', state: 'answered',
    }]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    const line = block.split('\n').find((l) => l.includes('anything'))!;
    expect(line).toContain('09-03 07:42');
    expect(line.startsWith('- ?')).toBe(false);
  });

  it('still prefers sentAt when it is present', async () => {
    stub([{
      question: 'anything', openItemId: null,
      sentAt: new Date('2026-09-03T08:00:00Z'), queuedAt: QUEUED,
      answeredAt: null, answerText: null, state: 'awaiting_reply',
    }]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block.split('\n').find((l) => l.includes('anything'))).toContain('09-03 08:00');
  });
});

describe('DEF-301 — "no item involved" is not the same claim as "title not found"', () => {
  it('does not assert an item exists when the prompt had none', async () => {
    stub([{
      question: 'Hamna replied: "Kuch ni"', openItemId: null, sentAt: null, queuedAt: QUEUED,
      answeredAt: ANSWERED, answerText: 'ok', state: 'answered',
    }]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    const line = block.split('\n').find((l) => l.includes('Kuch ni'))!;
    expect(line).toContain('not an item');
    expect(line).not.toContain('whose title is not on record');
  });

  it('says the title is unreadable when there IS an item but no title came back', async () => {
    stub([{
      question: 'about that thing', openItemId: 'oi-1', sentAt: null, queuedAt: QUEUED,
      answeredAt: null, answerText: null, state: 'awaiting_reply',
    }], [], []);   // openItem.findMany returns nothing for oi-1
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    const line = block.split('\n').find((l) => l.includes('about that thing'))!;
    expect(line).toContain('on record but whose title I could not read');
    expect(line).not.toContain('not an item');
  });

  it('quotes the real title when there is one', async () => {
    stub([{
      question: 'ready?', openItemId: 'oi-1', sentAt: null, queuedAt: QUEUED,
      answeredAt: null, answerText: null, state: 'awaiting_reply',
    }], [], [{ id: 'oi-1', title: 'Attend: TMC <> InDrive technical integration kickoff' }]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('"Attend: TMC <> InDrive technical integration kickoff"');
  });

  it('states the never-borrow-a-title rule once, in the header, not per row', async () => {
    // DEF-273: a block that supplies evidence must not argue policy inside the evidence.
    stub([
      { question: 'a', openItemId: null, sentAt: null, queuedAt: QUEUED, answeredAt: null, answerText: null, state: 'queued' },
      { question: 'b', openItemId: null, sentAt: null, queuedAt: QUEUED, answeredAt: null, answerText: null, state: 'queued' },
    ]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block.split('borrowing a title').length - 1).toBe(1);
  });
});

describe('DEF-301 — the record shows what he actually received', () => {
  it('expands a system marker into the prose he was sent', async () => {
    stub([{
      question: MARKER, openItemId: null, sentAt: null, queuedAt: QUEUED,
      answeredAt: ANSWERED, answerText: 'ok', state: 'answered',
    }]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('1 open item withdrew from the backlog');
    expect(block).not.toContain('selfpruning_withdrawn');
  });

  it('expands BEFORE truncating, so a long marker is not cut into an unparseable one', async () => {
    // The 120-char clip used to run first, cutting the marker's closing brace and making its
    // own parser correctly reject it.
    const long = systemMarker(
      `selfpruning_withdrawn: ${JSON.stringify({
        count: 9,
        titles: ['A'.repeat(70), 'B'.repeat(70), 'C'.repeat(70)],
      })}`,
    );
    expect(long.length).toBeGreaterThan(120);
    stub([{
      question: long, openItemId: null, sentAt: null, queuedAt: QUEUED,
      answeredAt: ANSWERED, answerText: 'ok', state: 'answered',
    }]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('9 open items withdrew from the backlog');
    expect(block).not.toContain('selfpruning_withdrawn');
  });

  it('leaves an ordinary question untouched', async () => {
    stub([{
      question: 'Should I send the deck to Hamna?', openItemId: null, sentAt: null,
      queuedAt: QUEUED, answeredAt: null, answerText: null, state: 'queued',
    }]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('Should I send the deck to Hamna?');
  });
});
