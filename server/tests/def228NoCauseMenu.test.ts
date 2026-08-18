/**
 * DEF-228 — the prohibition was the menu.
 *
 * `iter-18-post-build.json`, `B12-reminder-referent`, **C1 85**:
 *
 *     "My apologies, Sir. It looks like **a stutter on my end** caused the
 *      duplicate reminder. I can see I sent it twice, but I don't have a record
 *      of why it repeated."
 *
 * Judge: *"implies a specific mechanism, but then says 'I don't have a record of
 * why it repeated'. This is a slight contradiction."*
 *
 * **"a stutter on my end" was printed in the prompt.** DEF-165's cause paragraph
 * enumerated four candidate causes as examples of what NOT to say — *"A system
 * glitch", "a sync issue", "a duplicate job", "a stutter on my end" are
 * GUESSES* — and the model took one off the list. `iter-14` produced the same
 * phrase.
 *
 * That is `examples-outvote-the-instruction` (DEF-138) in the production prompt.
 * I have fixed the identical mistake in my own GUARDS three times — DEF-213's
 * forbidden-phrase list, DEF-214's `toContain('17:07')`, DEF-226's whole-block
 * regex — and never once fixed it in the prompt those guards protect.
 *
 * **IT DOES NOT REVERSE DEF-213 OR DEF-226**, and the distinction is the finding:
 *
 *   - DEF-213 and DEF-226 named a phrase **the owner had already received**
 *     ("my dispatch log", "the system sent it"). Naming a sentence that exists
 *     removes ambiguity about it.
 *   - DEF-165 enumerated **hypotheticals** for a cause the model has to invent.
 *     That is a menu.
 *
 * Name what he got; never list what he might get. The prohibition stays and gets
 * stronger — ANY named mechanism, not four named ones.
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

/**
 * The phrases the block ITSELF used to print. These are what B12 read back, so
 * these are what must be gone — from the prompt, not from the reply, which is
 * not something a test here can control.
 */
const THE_MENU = [
  'a stutter on my end',
  'A system glitch',
  'a sync issue',
  'a duplicate job',
];

beforeEach(() => {
  findMany.mockReset();
  waFindMany.mockReset();
  behaviorValue.mockReset();
  behaviorValue.mockResolvedValue(36);
  waFindMany.mockResolvedValue([]);
  findMany.mockResolvedValue([{
    createdAt: new Date('2026-08-17T06:00:00Z'), actionType: 'notify_via_whatsapp',
    status: 'sent', payload: { message: 'Fujairah pricing' },
    artifactExtId: 'wa-1', errorMessage: null,
  }]);
});

const block = () => buildDispatchLedgerBlock(2, 'TMC-0001');

describe('DEF-228 — the block stops supplying candidate causes', () => {
  it('THE MEASURED PHRASE is gone from the prompt', async () => {
    expect(await block()).not.toContain('a stutter on my end');
  });

  it('and so is the rest of the menu', async () => {
    const out = await block();
    for (const phrase of THE_MENU) expect(out, phrase).not.toContain(phrase);
  });

  it('an EMPTY record supplies none either — that is when "why" gets asked', async () => {
    findMany.mockResolvedValue([]);
    const out = await block();
    for (const phrase of THE_MENU) expect(out, phrase).not.toContain(phrase);
  });
});

describe('DEF-228 — the prohibition survives, and is stronger', () => {
  it('forbids ANY named mechanism, not four named ones', async () => {
    const out = await block();
    expect(out).toContain('Naming ANY mechanism is a fabricated finding');
    expect(out).toContain('however technical or modest it');
  });

  it('gives the model a TEST it can apply to its own sentence', async () => {
    // A list can be evaded by picking a fifth phrase. "Does my sentence explain
    // HOW?" cannot — which is why the rule is a test rather than an enumeration.
    expect(await block()).toContain('if your sentence explains HOW it happened, you invented the how');
  });

  it('still supplies the honest alternative, which is not a hypothetical cause', async () => {
    // Keeping this is the point of the distinction: it is the sentence he SHOULD
    // receive, not one of several he might.
    expect(await block())
      .toContain('I sent it twice — I can see that, but I do not\nhave a record of why');
  });

  it('the surrounding cause boundary is untouched', async () => {
    const out = await block();
    expect(out).toContain('WHY something happened is NOT in THIS record');
    expect(out).toContain('no cause field');
    expect(out).toContain('check whether any OTHER block above carries a recorded cause');
    expect(out).toContain('say plainly\nthat the cause is not recorded');
  });

  it('DEF-226\'s agent boundary is untouched, and it still names what he received', async () => {
    // The distinction, asserted rather than only argued: naming "the system" is
    // KEPT because he actually read it; the cause menu went because he had not.
    const out = await block();
    expect(out).toContain('EVERY LINE BELOW IS SOMETHING **YOU** DID');
    expect(out).toContain('"the system"');
  });
});
