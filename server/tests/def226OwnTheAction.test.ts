/**
 * DEF-226 — "the system sent you a duplicate" — Brain disowning its own action.
 *
 * The regression guard fired on `B12-reminder-referent`, **C8 100 → 80**, and the
 * judge named it exactly:
 *
 *   > "Brain speaks as itself, but the reference to 'the system' creating the
 *   >  duplicate feels like it's trying to distance itself from the action,
 *   >  rather than owning it as the user's assistant."
 *
 * The reply: *"It looks like **the system** sent you a duplicate reminder…"* —
 * after three consecutive runs in which the same case said, in the first person,
 * *"I sent the reminder twice."*
 *
 * **The mechanism is in the block, not in the model.** The dispatch record
 * renders subjectless event lines — `- 08-17 12:04 ✓ WhatsApped: …` — and a
 * model reading a log of events can narrate them in the third person without
 * ever making a false statement.
 *
 * DEF-165 put the CAUSE boundary in this block rather than in the rulebook, on
 * the finding that *"a constraint placed next to the data outranks one placed in
 * a rulebook"*. This is the AGENT boundary and it belongs in the same place for
 * the same reason. They are different questions: DEF-165's paragraph forbids
 * naming "a system glitch" as the CAUSE and says nothing about who performed the
 * action, which is why the block could carry it and still ship this reply.
 *
 * Because the header quotes the phrases it forbids, every assertion below reads
 * the block's OWN prose deliberately — a guard that regexed the whole block for
 * "the system" would match the prohibition and pass with the rule deleted. That
 * is DEF-213's list and DEF-214's `toContain('17:07')`, twice learned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.hoisted(() => vi.fn());
const waFindMany = vi.hoisted(() => vi.fn());
const behaviorValue = vi.hoisted(() => vi.fn());

vi.mock('../src/db/prisma', () => ({
  default: {
    brainActionArtifact: { findMany },
    whatsAppMessage: { findMany: waFindMany },
  },
}));
vi.mock('../src/services/behaviorConfig', () => ({ getBehaviorValue: behaviorValue }));
vi.mock('../src/utils/logger', () => ({
  default: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildDispatchLedgerBlock } from '../src/services/knowledge/dispatchLedgerService';

/** B12's own shape: the same reminder, twice. */
const TWICE = [
  {
    createdAt: new Date('2026-08-17T06:00:00Z'), actionType: 'notify_via_whatsapp',
    status: 'sent', payload: { message: 'Send the revised Fujairah pricing to Latif' },
    artifactExtId: 'wa-1', errorMessage: null,
  },
  {
    createdAt: new Date('2026-08-17T06:12:00Z'), actionType: 'notify_via_whatsapp',
    status: 'sent', payload: { message: 'Send the revised Fujairah pricing to Latif' },
    artifactExtId: 'wa-2', errorMessage: null,
  },
];

beforeEach(() => {
  findMany.mockReset();
  waFindMany.mockReset();
  behaviorValue.mockReset();
  behaviorValue.mockResolvedValue(36);
  waFindMany.mockResolvedValue([]);
  findMany.mockResolvedValue(TWICE);
});

/** The header only — everything before the first rendered row. */
const headerOf = (block: string) => {
  const firstRow = block.search(/^- \d\d-\d\d /m);
  return firstRow === -1 ? block : block.slice(0, firstRow);
};

describe('DEF-226 — the record names its actor', () => {
  it('says every line is something YOU did', async () => {
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(headerOf(block)).toContain('EVERY LINE BELOW IS SOMETHING **YOU** DID');
    expect(headerOf(block)).toContain('There is no other actor in this record');
  });

  it('names the four disowning phrases, so the rule can forbid what it means', async () => {
    // DEF-213: a rule that cannot say the thing it forbids is a weaker rule.
    const header = headerOf(await buildDispatchLedgerBlock(2, 'TMC-0001'));
    for (const p of ['"the system"', '"an automated process"', '"a background job"', '"the platform"']) {
      expect(header, p).toContain(p);
    }
  });

  it('gives the replacement, not only the prohibition', async () => {
    const header = headerOf(await buildDispatchLedgerBlock(2, 'TMC-0001'));
    expect(header).toContain('Say "I sent it", never "the system sent it"');
    expect(header).toContain("I sent it twice, and I don't know why");
  });

  it('says WHY it is wrong — inaccuracy, not manners', async () => {
    const header = headerOf(await buildDispatchLedgerBlock(2, 'TMC-0001'));
    expect(header).toContain('disowns your own action');
    expect(header).toContain('it is inaccuracy');
  });
});

describe('DEF-226 — it is a NEW boundary, not a reword of DEF-165', () => {
  it('the CAUSE paragraph is intact and still forbids inventing a reason', async () => {
    // DEF-165's rule is about why something happened. It said nothing about who
    // did it, which is exactly why the block could carry it and still ship "the
    // system sent you a duplicate".
    const header = headerOf(await buildDispatchLedgerBlock(2, 'TMC-0001'));
    expect(header).toContain('WHY something happened is NOT in THIS record');
    expect(header).toContain('the cause is not recorded');
    // DEF-228 SUPERSEDED the third assertion. It pinned the four-item menu of
    // example causes — and `iter-18` measured the model taking "a stutter on my
    // end" straight off it. The PROHIBITION is what this test defends, and it is
    // stronger now: any named mechanism, not four named ones.
    expect(header).toContain('Naming ANY mechanism is a fabricated finding');
    expect(header, 'the menu is gone').not.toContain('a stutter on my end');
  });

  it('the AGENT rule comes BEFORE the cause rule — who, then why', async () => {
    const header = headerOf(await buildDispatchLedgerBlock(2, 'TMC-0001'));
    expect(header.indexOf('EVERY LINE BELOW IS SOMETHING'))
      .toBeLessThan(header.indexOf('WHY something happened is NOT'));
  });
});

describe('DEF-226 — the rule ships whether or not there is anything to own', () => {
  it('an EMPTY record still carries it', async () => {
    // "Did you send it?" on a quiet day is exactly when a model reaches for a
    // vague third-party phrasing, so the rule must not be attached to the rows.
    findMany.mockResolvedValue([]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('EVERY LINE BELOW IS SOMETHING **YOU** DID');
    expect(block).toContain('(no actions dispatched in the last 36 hours)');
  });

  it('a FAILED read degrades to the empty record rather than losing the block', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('EVERY LINE BELOW IS SOMETHING **YOU** DID');
  });

  it('the rows themselves are unchanged — this adds a rule, it does not reformat evidence', async () => {
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    const rows = block.split('\n').filter((l) => /^- \d\d-\d\d /.test(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('WhatsApped');
    expect(rows[0]).toContain('id=wa-1');
  });
});
