/**
 * DEF-245 — a WhatsApp LID never enters the phone column.
 *
 * 2026-08-25. The owner sent three Contacts screenshots without describing the fault, which was
 * sufficient: two rows for Hamna Latif Bhutta, SIX for Muhammad Yousuf, two for Asad Ahmed
 * sharing one email. Then: "the contacts are not being Self Pruning".
 *
 * The Hamna half is created at this write path. Her WhatsApp LID — `255043747987458@lid`,
 * confirmed verbatim in the production log — reached the database as `+255043747987458` and sat
 * in `phone`. Her real number is `+923134199294`; the feed carries her 19× on the LID and once on
 * the real number, so they are provably one human who could never match herself.
 *
 * Measured across the book: 26 of 773 contacts held a LID-shaped phone, one of them the tenant's
 * own number filed under the name "Nexeo". `whatsapp-lid-activity-rejected` stands at SEVEN
 * occurrences and every earlier fix guarded a READ path. This is the write path nobody guarded.
 *
 * The rule under test is deliberately RELOCATE, not reject: a value in `waLid` is visible and
 * reversible; a discarded one is neither. The length test is a heuristic — E.164 permits 15
 * digits — so the assertions below pin both edges, including that a normal 12-digit Pakistani
 * number is untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: { entity: { create: (...a: any[]) => create(...a) } },
}));

import { createEntity } from '../src/services/entityService';

const dataOf = () => create.mock.calls[0][0].data;

describe('DEF-245 — a LID is filed as a LID, never as a phone', () => {
  beforeEach(() => { create.mockReset(); create.mockResolvedValue({ id: 'e1' }); });

  const make = (phone: string | null) =>
    createEntity('TMC-0001', 2, { entityType: 'contact', name: 'Hamna ABAP TMC', phone } as any);

  it("does not store Hamna's LID as her phone number", async () => {
    await make('+255043747987458');
    expect(dataOf().phone).toBeNull();
    expect(dataOf().waLid).toBe('255043747987458');
  });

  it('RELOCATES rather than discards — the value survives where it can be seen', async () => {
    await make('+255043747987458');
    expect(dataOf().waLid).toContain('255043747987458');
  });

  it('leaves a normal +92 number completely alone', async () => {
    await make('+923134199294');
    expect(dataOf().phone).toBe('+923134199294');
    expect(dataOf().waLid).toBeNull();
  });

  it('leaves the tenant number shape alone at 12 digits', async () => {
    await make('+923474937298');
    expect(dataOf().phone).toBe('+923474937298');
  });

  it('handles a contact with no phone at all', async () => {
    await make(null);
    expect(dataOf().phone).toBeNull();
    expect(dataOf().waLid).toBeNull();
  });

  it('strips punctuation when filing the LID, so it stores digits only', async () => {
    await make('+2550 4374-7987458');
    expect(dataOf().waLid).toBe('255043747987458');
    expect(dataOf().phone).toBeNull();
  });
});
