import { describe, it, expect, vi, beforeEach } from 'vitest';

// 2026-07-14 — Basit: "don't create duplicate records of contacts."
// The Asad saga: THREE rows for one man (name+.ai-email, name-less
// .com row, name+phone row) because no writer deduped by NAME — a
// known person appearing with a second identifier minted a new row.
//
// Policy now enforced at the writers:
//   - exactly ONE existing contact with the IDENTICAL full name
//     (case-insensitive) → attach the new identifier to THAT row:
//     empty slot filled, conflicting slot preserved in
//     metadata.altEmails / altPhones. NO new row.
//   - zero or 2+ exact-name matches → create (ambiguity is never
//     guessed away; two different "Ali Khan"s stay separate).

const entityFindMany = vi.fn();
const entityFindUnique = vi.fn();
const entityUpdate = vi.fn(async () => ({}));

vi.mock('../src/db/prisma', () => ({
  default: {
    entity: {
      findMany: (...a: any[]) => entityFindMany(...a),
      findUnique: (...a: any[]) => entityFindUnique(...a),
      update: (...a: any[]) => entityUpdate(...a),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'new_row' })),
    },
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));

import { findContactByExactName, attachIdentifierToContact } from '../src/services/knowledge/personIdentityService';

const ASAD = { id: 'ent_asad', name: 'Asad Ahmed Taj', email: 'asad.ahmed@tmcltd.com', phone: '+923474937298' };

beforeEach(() => {
  vi.clearAllMocks();
  entityFindMany.mockResolvedValue([]);
  entityFindUnique.mockResolvedValue(null);
});

describe('findContactByExactName — the merge-or-create decision', () => {
  it('returns the single exact-name match', async () => {
    entityFindMany.mockResolvedValue([ASAD]);
    const r = await findContactByExactName('TMC-0001', 'Asad Ahmed Taj');
    expect(r?.id).toBe('ent_asad');
    // Case-insensitive equality, contact-type only, capped at 2.
    const where = entityFindMany.mock.calls[0]![0].where;
    expect(where.name).toEqual({ equals: 'Asad Ahmed Taj', mode: 'insensitive' });
    expect(where.entityType).toBe('contact');
  });

  it('refuses to guess when TWO contacts share the exact name (ambiguity → null)', async () => {
    entityFindMany.mockResolvedValue([ASAD, { ...ASAD, id: 'ent_other_asad' }]);
    expect(await findContactByExactName('TMC-0001', 'Asad Ahmed Taj')).toBeNull();
  });

  it('returns null for no match / short names', async () => {
    expect(await findContactByExactName('TMC-0001', 'Al')).toBeNull(); // <3 chars
    entityFindMany.mockResolvedValue([]);
    expect(await findContactByExactName('TMC-0001', 'Nobody Here')).toBeNull();
  });
});

describe('attachIdentifierToContact — merge, never duplicate', () => {
  it('fills an EMPTY email slot directly (becomes primary)', async () => {
    entityFindUnique.mockResolvedValue({ email: null, phone: '+92300', metadata: {} });
    await attachIdentifierToContact('ent_1', { email: 'new@x.com' });
    const data = entityUpdate.mock.calls[0]![0].data;
    expect(data.email).toBe('new@x.com');
  });

  it('preserves a CONFLICTING email as metadata.altEmails (the Asad .ai/.com case)', async () => {
    entityFindUnique.mockResolvedValue({ email: 'asad.ahmed@tmcltd.ai', phone: null, metadata: {} });
    await attachIdentifierToContact('ent_asad', { email: 'asad.ahmed@tmcltd.com' });
    const data = entityUpdate.mock.calls[0]![0].data;
    expect(data.email).toBeUndefined(); // primary untouched
    expect(data.metadata.altEmails).toEqual(['asad.ahmed@tmcltd.com']);
  });

  it('does not duplicate an altEmail already recorded', async () => {
    entityFindUnique.mockResolvedValue({
      email: 'a@x.com', phone: null,
      metadata: { altEmails: ['b@x.com'] },
    });
    await attachIdentifierToContact('ent_1', { email: 'B@X.com' }); // case-insensitive
    const data = entityUpdate.mock.calls[0]![0].data;
    expect(data.metadata).toBeUndefined(); // nothing to add
  });

  it('fills an empty phone slot / preserves a conflicting one as altPhones', async () => {
    entityFindUnique.mockResolvedValue({ email: 'a@x.com', phone: null, metadata: {} });
    await attachIdentifierToContact('ent_1', { phone: '+92300' });
    expect(entityUpdate.mock.calls[0]![0].data.phone).toBe('+92300');

    vi.clearAllMocks();
    entityFindUnique.mockResolvedValue({ email: 'a@x.com', phone: '+92300', metadata: {} });
    await attachIdentifierToContact('ent_1', { phone: '+92311' });
    expect(entityUpdate.mock.calls[0]![0].data.metadata.altPhones).toEqual(['+92311']);
  });

  it('vanished row → no-op, never throws', async () => {
    entityFindUnique.mockResolvedValue(null);
    await expect(attachIdentifierToContact('gone', { email: 'x@y.com' })).resolves.toBeUndefined();
    expect(entityUpdate).not.toHaveBeenCalled();
  });
});
