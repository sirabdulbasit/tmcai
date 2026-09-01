/**
 * DEF-272 — writing the alias the owner just gave us.
 *
 * The ask (`def269SenderAliasAsk.test.ts`) fires ONCE per identity and never repeats, so this
 * write is the owner's only chance to name that person. Two consequences drive every test here:
 *
 *  - a swallowed write failure reported as success is a lie with no second attempt behind it —
 *    BLD-011's recorded lesson, from the day an error handler returned zeroes while 2.4M rows
 *    were deleted: *"an error handler returning a success is claiming a fact"*;
 *  - a wrong binding is DURABLE and misroutes that person indefinitely (DEF-162), so rebinding
 *    a contact who already answers to a different `@lid` must be refused, not overwritten.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
const update = vi.fn();
const create = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    entity: {
      findFirst: (...a: any[]) => findFirst(...a),
      update: (...a: any[]) => update(...a),
      create: (...a: any[]) => create(...a),
    },
  },
}));

import { applySideEffect } from '../src/services/brainPrompts/promptReplyHandler';

const SIDE = {
  kind: 'wa_sender_alias_capture',
  data: { waLid: '487846228094@lid', clientNumber: 'TMC-0001', ownerUserId: 2 },
};

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
  update.mockResolvedValue({});
  create.mockResolvedValue({});
});

describe('DEF-272 — the alias write', () => {
  it('aliases the contact the owner already has, rather than making a second one', async () => {
    findFirst.mockResolvedValue({ id: 'ent_9', metadata: { role: 'QA' } });
    const r = await applySideEffect(SIDE, 'Hamna Latif Bhutta', null);
    expect(r.status).toBe('applied');
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    // and it MERGES — an alias write must not wipe what else that contact carries
    expect(update.mock.calls[0][0].data.metadata).toEqual({ role: 'QA', waLid: '487846228094@lid' });
  });

  it('creates a contact when there is none, carrying NO phone number', async () => {
    const r = await applySideEffect(SIDE, 'Numair', null);
    expect(r.status).toBe('applied');
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data.name).toBe('Numair');
    expect(data.metadata.waLid).toBe('487846228094@lid');
    // DEF-121: the transport withheld the number and a fabricated one looks actionable.
    expect(data.phone).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('+487846228094');
  });

  it('reports FAILED when the write throws — never a false success', async () => {
    // The owner is asked once. Saying "applied" here leaves the sender anonymous forever while
    // telling him they are named, and nothing will ever ask again.
    create.mockRejectedValue(new Error('db down'));
    const r = await applySideEffect(SIDE, 'Numair', null);
    expect(r.status).toBe('failed');
    expect(r.detail).toBe('alias_write_failed');
  });

  it('reports FAILED when the update throws, for the same reason', async () => {
    findFirst.mockResolvedValue({ id: 'ent_9', metadata: {} });
    update.mockRejectedValue(new Error('db down'));
    const r = await applySideEffect(SIDE, 'Hamna', null);
    expect(r.status).toBe('failed');
    expect(r.detail).toBe('alias_write_failed');
  });

  it('refuses to REBIND a contact who already answers to a different @lid', async () => {
    // DEF-162: a wrong identity bind is durable and misroutes that person indefinitely. Silently
    // overwriting would un-name whoever the old alias belonged to.
    findFirst.mockResolvedValue({ id: 'ent_9', metadata: { waLid: '255043747987458@lid' } });
    const r = await applySideEffect(SIDE, 'Hamna', null);
    expect(r.status).toBe('failed');
    expect(r.detail).toBe('contact_has_a_different_wa_identity');
    expect(update).not.toHaveBeenCalled();
  });

  it('is idempotent when the SAME alias is written again', async () => {
    findFirst.mockResolvedValue({ id: 'ent_9', metadata: { waLid: '487846228094@lid' } });
    const r = await applySideEffect(SIDE, 'Hamna', null);
    expect(r.status).toBe('applied');
  });

  it('treats "skip" as declined, and does not create a contact called skip', async () => {
    for (const answer of ['skip', 'Skip', 'no', 'not sure', "don't know"]) {
      vi.clearAllMocks();
      findFirst.mockResolvedValue(null);
      const r = await applySideEffect(SIDE, answer, null);
      expect(r.detail, answer).toBe('declined');
      expect(create, answer).not.toHaveBeenCalled();
    }
  });

  it('refuses a paragraph — a contact named after a sentence is worse than anonymity', async () => {
    const r = await applySideEffect(SIDE, 'x'.repeat(120), null);
    expect(r.status).toBe('failed');
    expect(r.detail).toBe('answer_not_a_name');
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses to write anything when the side effect carries no identity', async () => {
    const r = await applySideEffect({ kind: 'wa_sender_alias_capture', data: {} }, 'Hamna', null);
    expect(r.status).toBe('failed');
    expect(r.detail).toBe('missing_lid');
    expect(create).not.toHaveBeenCalled();
  });

  it('scopes the lookup and the write to the tenant — invariant #1', async () => {
    await applySideEffect(SIDE, 'Numair', null);
    expect(findFirst.mock.calls[0][0].where.clientNumber).toBe('TMC-0001');
    expect(create.mock.calls[0][0].data.clientNumber).toBe('TMC-0001');
  });
});
