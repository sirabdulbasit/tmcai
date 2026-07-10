import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pillar 2 (2026-07-10) — ground-or-ask guard. Every action that touches
// a human or a specific record must ground its target to a real record
// scoped to the user; if it can't, fail closed to an ask. This is the
// structural end of the substitution class (wrong-recipient, wrong-owner,
// stale-contact) — one guard, all verbs.

const resolveCandidateMock = vi.fn();
const openItemFindFirst = vi.fn();

vi.mock('../src/services/knowledge/candidateResolver', () => ({
  resolveCandidate: (...a: any[]) => resolveCandidateMock(...a),
}));
vi.mock('../src/db/prisma', () => ({
  default: {
    openItem: { findFirst: (...a: any[]) => openItemFindFirst(...a) },
  },
}));

import {
  verifyActionTargets,
  TARGETING_ACTION_KINDS,
} from '../src/services/knowledge/actionTargetGuard';

const U = 2;
const CN = 'TMC-0001';
const RESOLVED = { id: 'ent_1', name: 'Muhammad Yousaf', email: null, phone: '+923028000553' };

beforeEach(() => {
  vi.clearAllMocks();
  resolveCandidateMock.mockResolvedValue(null); // default: nothing resolves
  openItemFindFirst.mockResolvedValue(null);    // default: no item
});

describe('verifyActionTargets — notify_via_whatsapp', () => {
  it('OK when recipientCandidateId resolves', async () => {
    resolveCandidateMock.mockResolvedValue(RESOLVED);
    const v = await verifyActionTargets('notify_via_whatsapp', { recipientCandidateId: 'ent_1', message: 'hi' }, U, CN);
    expect(v.ok).toBe(true);
  });
  it('OK when a valid ad-hoc phone is given (no candidate needed)', async () => {
    const v = await verifyActionTargets('notify_via_whatsapp', { recipientAdHocPhone: '+923710042740', message: 'hi' }, U, CN);
    expect(v.ok).toBe(true);
    expect(resolveCandidateMock).not.toHaveBeenCalled();
  });
  it('BLOCKS when candidate does not resolve and no valid phone (the EXIM/Asad class)', async () => {
    const v = await verifyActionTargets('notify_via_whatsapp', { recipientCandidateId: 'ghost', message: 'hi' }, U, CN);
    expect(v.ok).toBe(false);
    expect((v as any).marker).toMatch(/^\[target unresolved:/);
  });
  it('BLOCKS an invalid ad-hoc phone', async () => {
    const v = await verifyActionTargets('notify_via_whatsapp', { recipientAdHocPhone: '12', message: 'hi' }, U, CN);
    expect(v.ok).toBe(false);
  });
});

describe('verifyActionTargets — send_email', () => {
  it('OK with a valid ad-hoc email', async () => {
    const v = await verifyActionTargets('send_email', { toAdHoc: ['x@y.com'], toCandidateIds: [] }, U, CN);
    expect(v.ok).toBe(true);
  });
  it('OK when a to-candidate resolves', async () => {
    resolveCandidateMock.mockResolvedValue(RESOLVED);
    const v = await verifyActionTargets('send_email', { toCandidateIds: ['ent_1'], toAdHoc: [] }, U, CN);
    expect(v.ok).toBe(true);
  });
  it('BLOCKS when no recipient grounds', async () => {
    const v = await verifyActionTargets('send_email', { toCandidateIds: ['ghost'], toAdHoc: ['not-an-email'] }, U, CN);
    expect(v.ok).toBe(false);
  });
});

describe('verifyActionTargets — schedule_meeting', () => {
  it('OK with an ad-hoc attendee email (the Rafay case)', async () => {
    const v = await verifyActionTargets('schedule_meeting', { attendeeCandidateIds: [], attendeeAdHocEmails: ['rafayfrasat02@gmail.com'] }, U, CN);
    expect(v.ok).toBe(true);
  });
  it('BLOCKS when no attendee grounds', async () => {
    const v = await verifyActionTargets('schedule_meeting', { attendeeCandidateIds: ['ghost'], attendeeAdHocEmails: [] }, U, CN);
    expect(v.ok).toBe(false);
  });
});

describe('verifyActionTargets — delegate_open_item', () => {
  it('OK when item exists AND delegatee resolves', async () => {
    openItemFindFirst.mockResolvedValue({ id: 'oi_1' });
    resolveCandidateMock.mockResolvedValue(RESOLVED);
    const v = await verifyActionTargets('delegate_open_item', { openItemId: 'oi_1', delegateeCandidateId: 'ent_1' }, U, CN);
    expect(v.ok).toBe(true);
  });
  it('BLOCKS when the open item is stale (not found)', async () => {
    openItemFindFirst.mockResolvedValue(null);
    resolveCandidateMock.mockResolvedValue(RESOLVED);
    const v = await verifyActionTargets('delegate_open_item', { openItemId: 'stale', delegateeCandidateId: 'ent_1' }, U, CN);
    expect(v.ok).toBe(false);
    expect((v as any).marker).toMatch(/open item/i);
  });
  it('BLOCKS when item exists but delegatee does not ground', async () => {
    openItemFindFirst.mockResolvedValue({ id: 'oi_1' });
    const v = await verifyActionTargets('delegate_open_item', { openItemId: 'oi_1', delegateeCandidateId: 'ghost' }, U, CN);
    expect(v.ok).toBe(false);
    expect((v as any).marker).toMatch(/delegate/i);
  });
  it('OK with an ad-hoc delegatee email when item exists', async () => {
    openItemFindFirst.mockResolvedValue({ id: 'oi_1' });
    const v = await verifyActionTargets('delegate_open_item', { openItemId: 'oi_1', delegateeAdHocEmail: 'x@y.com' }, U, CN);
    expect(v.ok).toBe(true);
  });
});

describe('verifyActionTargets — contact + open-item mutations', () => {
  it('set_contact_scope BLOCKS on unresolved contact', async () => {
    const v = await verifyActionTargets('set_contact_scope', { contactCandidateId: 'ghost', scope: 'private' }, U, CN);
    expect(v.ok).toBe(false);
  });
  it('mark_open_item_done OK when the item exists', async () => {
    openItemFindFirst.mockResolvedValue({ id: 'oi_1' });
    const v = await verifyActionTargets('mark_open_item_done', { openItemId: 'oi_1' }, U, CN);
    expect(v.ok).toBe(true);
  });
});

describe('verifyActionTargets — id-bearing meeting/wiki actions', () => {
  it('cancel_meeting OK with a non-empty eventId', async () => {
    const v = await verifyActionTargets('cancel_meeting', { eventId: 'evt_1' }, U, CN);
    expect(v.ok).toBe(true);
  });
  it('cancel_meeting BLOCKS with an empty eventId', async () => {
    const v = await verifyActionTargets('cancel_meeting', { eventId: '' }, U, CN);
    expect(v.ok).toBe(false);
  });
  it('delete_wiki_page BLOCKS with a missing page id', async () => {
    const v = await verifyActionTargets('delete_wiki_page', {}, U, CN);
    expect(v.ok).toBe(false);
  });
});

describe('verifyActionTargets — non-targeting actions pass through', () => {
  it.each(['add_open_item', 'set_brain_name', 'record_preference', 'totally_unknown'])(
    '%s has no external target → ok',
    async (kind) => {
      const v = await verifyActionTargets(kind, {}, U, CN);
      expect(v.ok).toBe(true);
    },
  );
});

describe('manifest coverage — every human/record-targeting ComposedAction is declared', () => {
  it('TARGETING_ACTION_KINDS matches the set of targeting action types', () => {
    // If a new ComposedAction that touches a human/record is added, add it
    // here AND to TARGETING_ACTION_KINDS — this list is the canonical
    // ledger the guard iterates. Keeping them in sync is the whole point.
    const expected = [
      'notify_via_whatsapp', 'send_email', 'schedule_meeting', 'delegate_open_item',
      'cancel_meeting', 'reschedule_meeting', 'update_open_item', 'mark_open_item_done',
      'set_contact_scope', 'mark_contact_inactive', 'archive_wiki_page', 'delete_wiki_page',
    ].sort();
    expect([...TARGETING_ACTION_KINDS].sort()).toEqual(expected);
  });

  it('every declared targeting kind actually returns a block for empty slots (no silent pass)', async () => {
    for (const kind of TARGETING_ACTION_KINDS) {
      const v = await verifyActionTargets(kind, {}, U, CN);
      expect(v.ok, `${kind} must fail closed on empty slots`).toBe(false);
    }
  });
});
