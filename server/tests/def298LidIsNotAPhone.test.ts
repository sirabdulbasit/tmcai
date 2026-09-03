/**
 * DEF-298 — the synthetic never leaves the contact accessor as a phone number.
 *
 * THIRD occurrence. The owner has said twice, in his own words, that the LID-derived number is
 * "useless for me, don't show me this anywhere". DEF-293 fixed the formatter and is deployed and
 * verified — and he was shown one again anyway, because the guard covered the FORMATTER and the
 * defect was in the DATA: 24 contact pages stored a 13+ digit LID in `metadata.phone`, residue
 * DEF-245 left when it cleaned `entities` and not these. The message he saw,
 * "+109526195949711 (Mubarak Jharna Mahandri)", is verbatim what that row held.
 *
 * `20260903_lid_is_not_a_phone` cleaned the 24 rows (verified live: 24 → 0, LID preserved under
 * `waLid`, re-run updates 0). These tests guard the other half — that no stale page, no
 * re-synthesis from stale data, and no future writer can put one in front of him through the
 * contact path, because the accessor will not hand one out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryRawUnsafe = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: { $queryRawUnsafe: (...a: unknown[]) => queryRawUnsafe(...a) },
}));

import { findScopedContactPage, findScopedContactPhonesByEmail } from '../src/services/knowledge/scopedContacts';

const SYNTHETIC = '+109526195949711';       // the one he was actually shown
const REAL = '+923134199294';               // the shape he said he wants: starts +92

describe('DEF-298 — a LID is not a phone number', () => {
  beforeEach(() => queryRawUnsafe.mockReset());

  it('does not return a LID as a contact phone', async () => {
    queryRawUnsafe.mockResolvedValue([{
      id: 'p1', title: 'Mubarak Jharna Mahandri', userId: 2, status: 'active',
      metadata: { phone: SYNTHETIC, email: 'm@x.com' }, createdAt: null, lastUpdatedAt: null,
    }]);
    const row = await findScopedContactPage({ clientNumber: 'TMC-0001', userId: 2, byId: 'p1' });
    expect(row?.metadata.phone).toBeUndefined();
  });

  it('keeps the LID under waLid rather than destroying it', async () => {
    // It is a real identifier that really does identify this person to WhatsApp. It just is not
    // a number. DEF-245's rule, and the right one: move it where a mistake stays reversible.
    queryRawUnsafe.mockResolvedValue([{
      id: 'p1', title: 'X', userId: 2, status: 'active',
      metadata: { phone: SYNTHETIC }, createdAt: null, lastUpdatedAt: null,
    }]);
    const row = await findScopedContactPage({ clientNumber: 'TMC-0001', userId: 2, byId: 'p1' });
    expect(row?.metadata.waLid).toBe(SYNTHETIC);
    expect(row?.metadata.phoneWasLid).toBe(true);
  });

  it('leaves a REAL phone number completely alone', async () => {
    // The load-bearing other half: he explicitly said the useful column is the real number
    // ("there is proper phone number starting from +923 or 03"). Suppressing those would be a
    // worse failure than the one being fixed.
    queryRawUnsafe.mockResolvedValue([{
      id: 'p1', title: 'Hamna Latif Bhutta', userId: 2, status: 'active',
      metadata: { phone: REAL, email: 'h@x.com' }, createdAt: null, lastUpdatedAt: null,
    }]);
    const row = await findScopedContactPage({ clientNumber: 'TMC-0001', userId: 2, byId: 'p1' });
    expect(row?.metadata.phone).toBe(REAL);
    expect(row?.metadata.phoneWasLid).toBeUndefined();
  });

  it('does not disturb a contact with no phone at all', async () => {
    queryRawUnsafe.mockResolvedValue([{
      id: 'p1', title: 'X', userId: 2, status: 'active',
      metadata: { email: 'x@y.com' }, createdAt: null, lastUpdatedAt: null,
    }]);
    const row = await findScopedContactPage({ clientNumber: 'TMC-0001', userId: 2, byId: 'p1' });
    expect(row?.metadata).toEqual({ email: 'x@y.com' });
  });

  it('applies on every lookup limb, not just the one that got tested', async () => {
    // Three limbs, one rule. A projection applied to the id path only would be the same
    // partial-coverage shape that produced this defect in the first place.
    for (const args of [
      { byId: 'p1' },
      { byEmail: 'm@x.com' },
      { byPhone: SYNTHETIC },
    ]) {
      queryRawUnsafe.mockResolvedValue([{
        id: 'p1', title: 'X', userId: 2, status: 'active',
        metadata: { phone: SYNTHETIC }, createdAt: null, lastUpdatedAt: null,
      }]);
      const row = await findScopedContactPage({ clientNumber: 'TMC-0001', userId: 2, ...args });
      expect(row?.metadata.phone, JSON.stringify(args)).toBeUndefined();
    }
  });

  it('never hands a LID to the WhatsApp resolver as a number to message', async () => {
    // This limb feeds a SEND path. A LID there means messaging an address the owner never chose.
    queryRawUnsafe.mockResolvedValue([{ phone: SYNTHETIC }, { phone: REAL }]);
    const phones = await findScopedContactPhonesByEmail({
      clientNumber: 'TMC-0001', userId: 2, email: 'm@x.com',
    });
    expect(phones).toEqual([REAL]);
  });
});
