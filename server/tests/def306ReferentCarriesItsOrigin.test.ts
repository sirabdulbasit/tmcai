/**
 * DEF-306 — "from where you get it?" answered from the record, not from a window.
 *
 * The DEF-288 fix worked: he quoted a due-nudge, asked "from where you get it?", and Brain
 * answered the question he asked instead of the one inside the quote. It then got the answer
 * wrong in a new way:
 *
 *   "That's an open item I've been tracking for you. The record doesn't show where it originally
 *    came from, but I first prompted you about it being overdue on September 2nd."
 *
 * The record showed it perfectly well. THREE things were true at once, and only the third is a
 * defect in the block being tested here:
 *
 *   1. the item holds `source_feed='gchat'` with a message ref and a 2026-08-29 date
 *   2. the open-items block is a WINDOW — `take: OPEN_ITEMS_PAGE` (30), newest first — and that
 *      item ranked **63rd of 93** active items, so it was never in front of the model
 *   3. the dispatch-ledger block DID name the nudge, but resolved the item off `open_item_id`,
 *      which is NULL on `preactive_due_nudge` rows because that producer records its subject in
 *      `metadata.openItemId` and writes nothing to the column
 *
 * So the one block that knew the referent could not resolve it, and absence from context was
 * reported as absence from the record — DEF-037's class, and the shape DEF-260's own comment
 * predicted ("the answer depended on which block had run").
 *
 * Fixed by using `promptSubjectItemId` — the accessor DEF-120 wrote for exactly this, whose own
 * doc warns that a guard consulting one place "protects some producers and silently ignores
 * others" — and by carrying the item's origin on the same rows that already resolve its title.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const promptFindMany = vi.fn();
const historyFindMany = vi.fn();
const itemFindMany = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: {
    brainPromptQueue: { findMany: (...a: unknown[]) => promptFindMany(...a) },
    itemStatusHistory: { findMany: (...a: unknown[]) => historyFindMany(...a) },
    openItem: { findMany: (...a: unknown[]) => itemFindMany(...a) },
    brainActionArtifact: { findMany: () => Promise.resolve([]) },
    $queryRawUnsafe: () => Promise.resolve([]),
  },
}));

import { buildDispatchLedgerBlock } from '../src/services/knowledge/dispatchLedgerService';

const ITEM = 'cmtdupvrb001grto6etmr9bsl';
const QUEUED = new Date('2026-09-03T12:49:00Z');

/** A due-nudge exactly as `preactive_due_nudge` writes it: subject in metadata, column NULL. */
const dueNudgeRow = {
  question: 'Just a reminder that your task "Provide leadership..." is now overdue.',
  openItemId: null,
  metadata: { source: 'preactive_due_nudge', openItemId: ITEM },
  sentAt: QUEUED, queuedAt: QUEUED, answeredAt: null, answerText: null, state: 'awaiting_reply',
};

const itemRow = {
  id: ITEM,
  title: 'Provide leadership and commercial support for TMC projects',
  sourceFeed: 'gchat',
  sourceRef: 'spaces/AAQA9haLr48/messages/dVhh1Llcl-Q',
  createdAt: new Date('2026-08-29T03:59:14Z'),
};

beforeEach(() => {
  promptFindMany.mockReset();
  historyFindMany.mockReset();
  itemFindMany.mockReset();
  promptFindMany.mockResolvedValue([dueNudgeRow]);
  historyFindMany.mockResolvedValue([]);
  itemFindMany.mockResolvedValue([itemRow]);
});

describe('DEF-306 — the subject resolves even when the column is NULL', () => {
  it('names the item for a due-nudge whose id lives only in metadata', async () => {
    // Before this, the line read "nothing on the item list — this was a message or notification,
    // not an item" for a nudge that was entirely about an item.
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('"Provide leadership and commercial support for TMC projects"');
    expect(block).not.toContain('not an item');
  });

  it('looks the item up by the id found in metadata', async () => {
    await buildDispatchLedgerBlock(2, 'TMC-0001');
    const where = (itemFindMany.mock.calls[0][0] as any).where;
    expect(where.id.in).toContain(ITEM);
  });

  it('still prefers the column when the producer did set it', async () => {
    // The accessor's rule, and the safe one: the column is typed and indexed, and no row has
    // been seen where the two disagree — verified over the live table, 0 disagreements.
    promptFindMany.mockResolvedValue([{
      ...dueNudgeRow, openItemId: 'column-wins', metadata: { openItemId: 'metadata-loses' },
    }]);
    itemFindMany.mockResolvedValue([{ ...itemRow, id: 'column-wins' }]);
    await buildDispatchLedgerBlock(2, 'TMC-0001');
    const where = (itemFindMany.mock.calls[0][0] as any).where;
    expect(where.id.in).toContain('column-wins');
    expect(where.id.in).not.toContain('metadata-loses');
  });
});

describe('DEF-306 — the origin travels with the referent', () => {
  it('renders the feed the item came in on', async () => {
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('came in via gchat');
  });

  it('renders when it was first recorded', async () => {
    // "I first prompted you on September 2nd" was true and was not the answer: the item existed
    // on 2026-08-29, four days before Brain ever mentioned it.
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('first recorded 08-29');
  });

  it('renders the source reference, which is the literal answer to "from where"', async () => {
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('spaces/AAQA9haLr48');
  });

  it('says nothing rather than something empty when there is no origin', async () => {
    // An item with no recorded source must not render an empty bracket, which reads as data.
    itemFindMany.mockResolvedValue([{ ...itemRow, sourceFeed: null, sourceRef: null, createdAt: null }]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).not.toContain('came in via');
    expect(block).not.toContain('[]');
  });

  it('asks for the origin fields in the SAME query that resolves the title', async () => {
    // No second lookup: this join already runs and is bounded to ten prompts.
    await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(itemFindMany).toHaveBeenCalledTimes(1);
    const select = (itemFindMany.mock.calls[0][0] as any).select;
    expect(select).toMatchObject({ sourceFeed: true, sourceRef: true, createdAt: true });
  });
});

describe('DEF-306 — a window licenses no claim of absence', () => {
  it('the core rules forbid reporting absence from context as absence from the record', () => {
    // The other half of the defect, and the one that made a false sentence sayable at all. The
    // open-items block shows 30 of 93; the honest answer from outside that page is "I cannot see
    // it from here", never "the record doesn't show it".
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const composer = readFileSync(
      join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf-8');
    const start = composer.indexOf('const CORE_CONVERSATIONAL_RULES');
    const rules = composer.slice(start, composer.indexOf('const OUTPUT_SHAPE_RULES', start));
    expect(rules).toMatch(/windowed list licenses no claim/i);
    expect(rules).toMatch(/never evidence of absence from/i);
  });
});
