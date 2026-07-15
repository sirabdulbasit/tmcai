import { describe, it, expect } from 'vitest';
import { pickCanonical, planMerge, type ContactRow } from '../src/services/knowledge/contactPruneService';

// 2026-07-14 — "there should be a mechanism of keep pruning contacts."
// The pure planning logic is the safety-critical part: which rows may
// auto-merge, which are flagged for a human. (The executor is thin
// prisma plumbing; the DECISIONS are locked here.)

const row = (over: Partial<ContactRow>): ContactRow => ({
  id: 'x', name: 'Asad Ahmed Taj', email: null, phone: null,
  ownerUserId: null, createdAt: new Date('2026-06-01'), metadata: null,
  ...over,
});

describe('pickCanonical', () => {
  it('prefers a row with an owner over an ownerless one', () => {
    const a = row({ id: 'ownerless', createdAt: new Date('2026-01-01') });
    const b = row({ id: 'owned', ownerUserId: 2, createdAt: new Date('2026-06-01') });
    expect(pickCanonical([a, b]).id).toBe('owned');
  });
  it('prefers the oldest among equals', () => {
    const a = row({ id: 'newer', ownerUserId: 2, createdAt: new Date('2026-06-01') });
    const b = row({ id: 'older', ownerUserId: 2, createdAt: new Date('2026-01-01') });
    expect(pickCanonical([a, b]).id).toBe('older');
  });
});

describe('planMerge — the Asad case and its boundaries', () => {
  it('merges email-only + phone-only fragments into one row with both identifiers', () => {
    // The literal 3-row Asad split (post .com-junk cleanup): named row
    // with email, named row with phone.
    const emailRow = row({ id: 'e', email: 'asad.ahmed@tmcltd.com', ownerUserId: 2, createdAt: new Date('2026-01-01') });
    const phoneRow = row({ id: 'p', phone: '+923474937298' });
    const plan = planMerge([emailRow, phoneRow])!;
    expect(plan.canonicalId).toBe('e');
    expect(plan.duplicateIds).toEqual(['p']);
    expect(plan.set.phone).toBe('+923474937298'); // union onto canonical
    expect(plan.set.email).toBeUndefined();       // already there
  });

  it('REFUSES to merge when two distinct primary emails exist (two people can share a name)', () => {
    const a = row({ id: 'a', email: 'ali1@x.com' });
    const b = row({ id: 'b', email: 'ali2@x.com' });
    expect(planMerge([a, b])).toBeNull(); // flagged, human call
  });

  it('REFUSES on two distinct phones', () => {
    const a = row({ id: 'a', phone: '+92300' });
    const b = row({ id: 'b', phone: '+92311' });
    expect(planMerge([a, b])).toBeNull();
  });

  it('same email on both rows is not a conflict', () => {
    const a = row({ id: 'a', email: 'asad@x.com', ownerUserId: 2, createdAt: new Date('2026-01-01') });
    const b = row({ id: 'b', email: 'ASAD@X.COM' }); // case difference
    const plan = planMerge([a, b]);
    expect(plan).not.toBeNull();
    expect(plan!.canonicalId).toBe('a');
  });

  it('unions altEmails/altPhones from all duplicates so nothing is lost', () => {
    const a = row({ id: 'a', email: 'asad@x.com', ownerUserId: 2, createdAt: new Date('2026-01-01'), metadata: { altEmails: ['old@x.com'] } });
    const b = row({ id: 'b', metadata: { altEmails: ['second@x.com'], altPhones: ['+92399'] } });
    const plan = planMerge([a, b])!;
    expect(plan.set.metadata!.altEmails).toEqual(expect.arrayContaining(['old@x.com', 'second@x.com']));
    expect(plan.set.metadata!.altPhones).toEqual(['+92399']);
  });

  it('single row → nothing to merge', () => {
    expect(planMerge([row({ id: 'only' })])).toBeNull();
  });
});
