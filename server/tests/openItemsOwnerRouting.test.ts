import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fix 2026-07-10 — "ask status of EXIM" routed to the WRONG person.
// EXIM is delegated to Muhammad Yousaf (who has a WhatsApp number), but
// the brain proposed messaging Asad — the recently-discussed contact.
// Root cause: the open-items reasoning block named the delegatee but
// gave reasoning no routable candidate id, so a "ping the owner" ask
// couldn't bind the right person and substituted from the recent
// candidates. Fix: resolve each delegatee name → contact entity and
// embed delegatee_candidateId + reachability in the block.

const findManyOpenItems = vi.fn();
const findManyEntities = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    openItem: { findMany: (...a: any[]) => findManyOpenItems(...a) },
    entity: { findMany: (...a: any[]) => findManyEntities(...a) },
  },
}));

import { buildOpenItemsBlockForReasoning } from '../src/services/knowledge/brainComposer';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildOpenItemsBlockForReasoning — owner routing', () => {
  it('binds a delegatee name to its contact candidateId + reachability', async () => {
    findManyOpenItems.mockResolvedValue([
      { id: 'oi_exim', title: 'EXIM solution', status: 'DELEGATED', priority: 'medium', dueDate: null, delegateeName: 'Muhammad Yousaf', delegateeEmail: null, metadata: {}, delegationFollowupCount: 0, createdAt: new Date('2026-07-01') },
    ]);
    findManyEntities.mockResolvedValue([
      { id: 'ent_yousaf', name: 'Muhammad Yousaf', phone: '+923028000553', email: null },
    ]);

    const block = await buildOpenItemsBlockForReasoning(2, 'TMC-0001');
    expect(block).toContain('title="EXIM solution"');
    expect(block).toContain('delegated_to="Muhammad Yousaf"');
    // The routable id — this is what stops the wrong-recipient substitution.
    expect(block).toContain('delegatee_candidateId=ent_yousaf');
    // Yousaf has a phone but no email → whatsapp only.
    expect(block).toContain('delegatee_reachable=whatsapp');
    expect(block).not.toContain('delegatee_reachable=whatsapp+email');
  });

  it('marks the delegatee UNRESOLVED when the name has no contact (must ask, not substitute)', async () => {
    findManyOpenItems.mockResolvedValue([
      { id: 'oi_x', title: 'Mystery task', status: 'DELEGATED', priority: 'low', dueDate: null, delegateeName: 'Ghost Person', delegateeEmail: null, metadata: {}, delegationFollowupCount: 0, createdAt: new Date('2026-07-01') },
    ]);
    findManyEntities.mockResolvedValue([]); // no matching contact

    const block = await buildOpenItemsBlockForReasoning(2, 'TMC-0001');
    expect(block).toContain('delegated_to="Ghost Person"');
    expect(block).toContain('delegatee_candidateId=UNRESOLVED');
  });

  it('shows whatsapp+email when the contact has both', async () => {
    findManyOpenItems.mockResolvedValue([
      { id: 'oi_y', title: 'Budget review', status: 'DELEGATED', priority: 'high', dueDate: null, delegateeName: 'Asad Ahmed Taj', delegateeEmail: null, metadata: {}, delegationFollowupCount: 0, createdAt: new Date('2026-07-01') },
    ]);
    findManyEntities.mockResolvedValue([
      { id: 'ent_asad', name: 'Asad Ahmed Taj', phone: '+923226288256', email: 'asad.ahmed@tmcltd.com' },
    ]);

    const block = await buildOpenItemsBlockForReasoning(2, 'TMC-0001');
    expect(block).toContain('delegatee_candidateId=ent_asad');
    expect(block).toContain('delegatee_reachable=whatsapp+email');
  });

  it('omits delegatee fields entirely for a non-delegated item', async () => {
    findManyOpenItems.mockResolvedValue([
      { id: 'oi_solo', title: 'Personal note', status: 'NEW', priority: 'low', dueDate: null, delegateeName: null, delegateeEmail: null, metadata: {}, delegationFollowupCount: 0, createdAt: new Date('2026-07-01') },
    ]);
    // No delegatee names → entity lookup should be skipped entirely.
    const block = await buildOpenItemsBlockForReasoning(2, 'TMC-0001');
    // Assert on the ITEM LINE, not the whole block — the header line
    // legitimately mentions delegatee_candidateId as an instruction.
    const itemLine = block.split('\n').find((l) => l.includes('title="Personal note"')) ?? '';
    expect(itemLine).toContain('title="Personal note"');
    expect(itemLine).not.toContain('delegated_to');
    expect(itemLine).not.toContain('delegatee_candidateId');
    expect(findManyEntities).not.toHaveBeenCalled();
  });

  it('returns empty string when there are no open items', async () => {
    findManyOpenItems.mockResolvedValue([]);
    expect(await buildOpenItemsBlockForReasoning(2, 'TMC-0001')).toBe('');
  });

  it('batches ONE entity lookup across many delegated items (no N+1)', async () => {
    findManyOpenItems.mockResolvedValue([
      { id: 'a', title: 'A', status: 'DELEGATED', priority: 'low', dueDate: null, delegateeName: 'Muhammad Yousaf', delegateeEmail: null, metadata: {}, delegationFollowupCount: 0, createdAt: new Date() },
      { id: 'b', title: 'B', status: 'DELEGATED', priority: 'low', dueDate: null, delegateeName: 'Asad Ahmed Taj', delegateeEmail: null, metadata: {}, delegationFollowupCount: 0, createdAt: new Date() },
    ]);
    findManyEntities.mockResolvedValue([
      { id: 'ent_yousaf', name: 'Muhammad Yousaf', phone: '+92', email: null },
      { id: 'ent_asad', name: 'Asad Ahmed Taj', phone: '+92', email: 'a@b.com' },
    ]);
    await buildOpenItemsBlockForReasoning(2, 'TMC-0001');
    expect(findManyEntities).toHaveBeenCalledTimes(1);
    const arg = findManyEntities.mock.calls[0]![0] as any;
    expect(arg.where.name.in).toEqual(expect.arrayContaining(['Muhammad Yousaf', 'Asad Ahmed Taj']));
  });
});
