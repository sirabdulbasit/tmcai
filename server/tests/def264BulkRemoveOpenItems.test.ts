/**
 * DEF-264 — "delete all" was un-executable as designed.
 *
 * Owner, 2026-09-01 (CL-042): *"how many open items you have?"* → *"You have 39 active open
 * items, though my current view only shows the 30 most recent."* → *"delete all"* → confirmation
 * naming all 39 and warning it is permanent → *"yes"* → *"Go ahead and I'll verify first."*
 *
 * **39 items were still there afterwards.** Nothing was dispatched.
 *
 * The cause was structural rather than a dropped dispatch. The only delete capability was
 * `remove_open_item`, whose own description says *"When the user asks to remove several items,
 * emit one action per item"* — and the item block is paginated at OPEN_ITEMS_PAGE = 30. With 39
 * active items the model held 30 ids. It could not express the instruction it had just been
 * authorised to perform.
 *
 * DEF-255 established that a gate cannot fix an absent capability. So the fix removes the
 * DEPENDENCY: the bulk action carries a scope, the server enumerates, and the model never holds
 * an id. These tests pin that property — not the wording, which is the model's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const findMany = vi.fn();
const transitionStatus = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: { openItem: { findMany: (...a: any[]) => findMany(...a) } },
}));
vi.mock('../src/services/itemLifecycle/lifecycleService', () => ({
  transitionStatus: (...a: any[]) => transitionStatus(...a),
}));

import { executeRemoveOpenItemsBulk } from '../src/services/knowledge/internalActionExecutors';

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `oi_${i}`, title: `Item ${i}` }));

beforeEach(() => {
  vi.clearAllMocks();
  transitionStatus.mockResolvedValue({ ok: true });
});

describe('DEF-264 — a bulk verb has a bulk landing place', () => {
  it('removes ALL items the SERVER finds, not the ones the model could see', async () => {
    // The whole point: 39 exist, the model saw 30, and the action carries no ids at all.
    findMany.mockResolvedValue(items(39));
    const r = await executeRemoveOpenItemsBulk('TMC-0001', 2, { scope: 'all' });

    expect(r.ok).toBe(true);
    expect(transitionStatus).toHaveBeenCalledTimes(39);
    expect(r.message).toContain('39');
  });

  it('takes NO id list — pagination cannot bound it again', async () => {
    // If this signature ever grows an ids array, the 30-of-39 bug becomes reachable once more.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'knowledge', 'internalActionExecutors.ts'), 'utf8');
    const sig = src.slice(src.indexOf('export async function executeRemoveOpenItemsBulk'));
    const params = sig.slice(0, sig.indexOf('): Promise<'));
    expect(params).toContain('scope');
    expect(params).not.toContain('openItemIds');
    expect(params).not.toContain('ids:');
  });

  it('scopes every query to the tenant AND the user', async () => {
    findMany.mockResolvedValue(items(3));
    await executeRemoveOpenItemsBulk('TMC-0001', 2, { scope: 'all' });

    const where = findMany.mock.calls[0][0].where;
    expect(where.clientNumber).toBe('TMC-0001');
    expect(where.userId).toBe(2);
  });

  it('CANCELS rather than marking done — DONE would claim work that never happened', async () => {
    findMany.mockResolvedValue(items(2));
    await executeRemoveOpenItemsBulk('TMC-0001', 2, { scope: 'all' });

    for (const call of transitionStatus.mock.calls) {
      expect(call[1]).toBe('CANCELLED');
      expect(call[1]).not.toBe('DONE');
    }
  });

  it('goes through the lifecycle per item, never a bulk updateMany that bypasses it', async () => {
    // A bulk update would be faster and would skip the transition matrix, the audit trail and
    // the per-item guards. BLD-005 shipped a duplicate-send path through exactly that bypass.
    findMany.mockResolvedValue(items(5));
    await executeRemoveOpenItemsBulk('TMC-0001', 2, { scope: 'all' });
    expect(transitionStatus).toHaveBeenCalledTimes(5);

    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'knowledge', 'internalActionExecutors.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function executeRemoveOpenItemsBulk'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).not.toContain('updateMany');
  });

  it('REFUSES an unrecognised scope instead of widening to everything', async () => {
    findMany.mockResolvedValue(items(39));
    const r = await executeRemoveOpenItemsBulk('TMC-0001', 2, { scope: 'high-priority-only' });

    expect(r.ok).toBe(false);
    expect(transitionStatus).not.toHaveBeenCalled();   // nothing touched
    expect(r.message).toContain('not recognised');
  });

  it('reports the count it ACHIEVED, and names what refused', async () => {
    findMany.mockResolvedValue(items(4));
    transitionStatus
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'refused' })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'refused' });

    const r = await executeRemoveOpenItemsBulk('TMC-0001', 2, { scope: 'all' });
    // A read-back of what happened, not the count it intended.
    expect(r.message).toContain('2 of 4');
    expect(r.message).toContain('Item 1');
    expect(r.message).toContain('Item 3');
  });

  it('says the list is already empty rather than reporting a hollow success', async () => {
    findMany.mockResolvedValue([]);
    const r = await executeRemoveOpenItemsBulk('TMC-0001', 2, { scope: 'all' });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('already empty');
    expect(transitionStatus).not.toHaveBeenCalled();
  });

  it('is SEEDED, so the model is told the capability exists', async () => {
    // DEF-255: brainCapabilityLive generates the model's capability list from the seeded rows.
    // An unseeded action is one the model will never emit, however well it is implemented.
    const seed = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'scripts', 'seedActionDefinitions.ts'), 'utf8');
    expect(seed).toContain("type: 'remove_open_items_bulk'");
    expect(seed).toContain('executeRemoveOpenItemsBulk');
    // And it must tell the model WHY not to loop remove_open_item instead.
    expect(seed).toContain('paginated');
  });
});
