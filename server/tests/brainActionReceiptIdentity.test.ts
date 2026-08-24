/**
 * A completed action must not lose its own receipt.
 *
 * Owner, 2026-08-24, on a schema audit whose finding #2 read: *"This is exactly how Brain can
 * execute something, fail to find its receipt later, and then deny or misreport completion."*
 * On this database that is not a hypothesis. Measured before the fix:
 *
 *     152 brain_action_artifacts · 35 brain_pending_actions
 *       0 artifacts pointing at a missing pending action
 *       5 pending actions pointing at an artifact THAT DOES NOT EXIST
 *
 * and those five were not lost rows — they were a column carrying two different meanings:
 *
 *     cmsernb0o000mrto983hvi22t    a real BrainActionArtifact id
 *     19fd12e8abc16d71             a GMAIL message id
 *     72ttj4kbqt8n7i3k1qh44u4u7g   a GOOGLE CALENDAR event id
 *
 * every one of them status='completed'. `instructionDispatcher` returns
 * `artifactId: out.eventId ?? String(r.actionId)` and `markCompleted` filed it verbatim into
 * the column read-back treats as a receipt pointer. Brain did the thing, then could not find
 * its own proof, and answered from nothing. That is the `fabricated-status` class — 6 of 16
 * live symptom signatures, the largest group — and DEF-238 is one instance of it.
 *
 * These assertions pin the rule that closes the class: THE ID IS CLASSIFIED, NOT ASSUMED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const update = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    brainActionArtifact: { findUnique: (...a: any[]) => findUnique(...a) },
    brainPendingAction: { update: (...a: any[]) => update(...a) },
  },
}));

import { markCompleted } from '../src/services/knowledge/pendingActionService';

const ROW = (over: any = {}) => ({
  id: 'pending-1', clientNumber: 'TMC-0001', userId: 2, channel: 'whatsapp',
  actionKind: 'schedule_meeting', status: 'completed', slots: {}, missingSlots: [],
  previewHash: null, previewedAt: null, artifactId: null, artifactExtId: null,
  createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(),
  ...over,
});

describe('markCompleted — a receipt link is a receipt link, not "whatever came back"', () => {
  beforeEach(() => { findUnique.mockReset(); update.mockReset(); update.mockResolvedValue(ROW()); });

  const dataOf = () => update.mock.calls[0][0].data;

  it('files a REAL artifact id as the receipt link', async () => {
    findUnique.mockResolvedValue({ id: 'cmsernb0o000mrto983hvi22t' });
    await markCompleted('pending-1', 'cmsernb0o000mrto983hvi22t');
    expect(dataOf().artifactId).toBe('cmsernb0o000mrto983hvi22t');
    expect(dataOf().artifactExtId).toBeUndefined();
  });

  it('does NOT file a Gmail message id as a receipt — the DEF-238 class', async () => {
    findUnique.mockResolvedValue(null);                 // no such artifact
    await markCompleted('pending-1', '19fd12e8abc16d71');
    expect(dataOf().artifactId).toBeNull();             // never a dangling pointer
    expect(dataOf().artifactExtId).toBe('19fd12e8abc16d71');
  });

  it('does NOT file a Calendar event id as a receipt either', async () => {
    findUnique.mockResolvedValue(null);
    await markCompleted('pending-1', '72ttj4kbqt8n7i3k1qh44u4u7g');
    expect(dataOf().artifactId).toBeNull();
    expect(dataOf().artifactExtId).toBe('72ttj4kbqt8n7i3k1qh44u4u7g');
  });

  it('KEEPS the provider id rather than discarding it — one silent gap must not replace another', async () => {
    findUnique.mockResolvedValue(null);
    await markCompleted('pending-1', '19fd0b50cdbca82e');
    const d = dataOf();
    expect(d.artifactExtId ?? d.artifactId).toBe('19fd0b50cdbca82e');
  });

  it('still marks the action completed whichever column the id lands in', async () => {
    findUnique.mockResolvedValue(null);
    await markCompleted('pending-1', 'anything');
    expect(dataOf().status).toBe('completed');
  });

  it('does not go looking for an artifact when the dispatcher returned nothing', async () => {
    await markCompleted('pending-1', '');
    expect(findUnique).not.toHaveBeenCalled();
    expect(dataOf().artifactId).toBeNull();
  });
});
