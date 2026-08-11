/**
 * DEF-129 — CANCELLED as a real, reversible outcome, and transitions that are
 * atomic with the fields they carry.
 *
 * Three things came together here.
 *
 * 1. `remove_open_item` wrote `status: 'CANCELLED'` straight to the row. Not
 *    carelessness: the matrix had no such state, so there was no legal
 *    transition to ask for. CLOSED was the only terminal state, and closing an
 *    item the owner asked to REMOVE records work as completed that never
 *    happened — the fabricated-completion class, in the data instead of a
 *    sentence.
 *
 * 2. Delegation wrote `delegateeName`/`delegateeEmail`/`delegateeId` in a
 *    SEPARATE update BEFORE requesting the transition. After DEF-128 made
 *    refusals visible, a refused delegation left those fields behind: an item
 *    that was not DELEGATED but carried a delegatee, reading as an assignment
 *    nobody made.
 *
 * 3. Six production items sat in `DONE`, outside the v15 vocabulary, so
 *    `transitionStatus` refused them outright — unmovable by any path.
 *
 * The tests below exercise behaviour through the real service with a fake
 * Prisma that honours transaction rollback; the migration assertions are
 * supplementary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const H = vi.hoisted(() => {
  const state = {
    item: null as any,
    ledger: [] as any[],
    failLedger: false,
    /** what the item looks like after committed writes */
    committed: {} as Record<string, unknown>,
  };

  const client = {
    openItem: {
      findFirst: vi.fn(async () => state.item),
      update: vi.fn(async ({ data }: any) => {
        Object.assign(state.committed, data);
        return { ...state.item, ...data };
      }),
    },
    itemStatusHistory: {
      create: vi.fn(async ({ data }: any) => {
        if (state.failLedger) throw new Error('ledger unavailable');
        const row = { id: state.ledger.length + 1, ...data };
        state.ledger.push(row);
        return row;
      }),
    },
    $transaction: vi.fn(async (fn: any) => {
      const snapshot = { ...state.committed };
      try {
        return await fn(client);
      } catch (e) {
        // Real rollback: everything the callback wrote is discarded.
        state.committed = snapshot;
        throw e;
      }
    }),
  };
  return { state, client };
});

vi.mock('../src/db/prisma', () => ({ default: H.client }));
vi.mock('../src/services/infra/pubsubPublisher', () => ({ publish: vi.fn(async () => undefined) }));

import { transitionStatus } from '../src/services/itemLifecycle/lifecycleService';
import {
  ALL_STATUSES, findTransition, INACTIVE_STATUS_VALUES,
} from '../src/services/itemLifecycle/transitionMatrix';

const DONE_SQL = readFileSync(
  join(__dirname, '..', 'prisma', 'migrations', '20260811_normalise_legacy_done_status', 'migration.sql'), 'utf-8',
);

const ctx = (extra: Record<string, unknown> = {}) => ({
  clientNumber: 'TMC-0001', actor: 'user:7', reason: 'because the owner said so', ...extra,
});

beforeEach(() => {
  H.state.ledger.length = 0;
  H.state.failLedger = false;
  H.state.committed = {};
  H.state.item = {
    id: 'item-1', status: 'TRIAGED', userId: 7, ownerId: 7,
    delegateeId: null, delegateeEmail: null, delegateeName: null,
    entityId: null, priority: 'medium', title: 'Test item',
  };
});

describe('DEF-129 — CANCELLED is a real, reversible outcome', () => {
  it('is part of the lifecycle vocabulary', () => {
    expect(ALL_STATUSES).toContain('CANCELLED');
  });

  it('is reachable from every non-terminal state', async () => {
    for (const from of ['NEW', 'TRIAGED', 'IN_PROGRESS', 'DELEGATED', 'WAITING_INFO', 'SNOOZED', 'INFORMED'] as const) {
      expect(findTransition(from, 'CANCELLED'), `${from} -> CANCELLED`).toBeTruthy();
    }
  });

  it('cannot be reached from CLOSED — completed work is not cancellable', () => {
    // Cancelling something already done would rewrite history rather than
    // record a decision.
    expect(findTransition('CLOSED', 'CANCELLED')).toBeUndefined();
  });

  it('RESTORES to TRIAGED, so a withdrawal can be undone', async () => {
    H.state.item.status = 'CANCELLED';
    const r = await transitionStatus('item-1', 'TRIAGED', ctx());
    expect(r.ok).toBe(true);
    expect(H.state.committed.status).toBe('TRIAGED');
    expect(H.state.ledger[0]).toMatchObject({ fromStatus: 'CANCELLED', toStatus: 'TRIAGED', outcome: 'accepted' });
  });

  it('requires a reason — a cancelled item with no explanation looks lost', async () => {
    const r = await transitionStatus('item-1', 'CANCELLED', { clientNumber: 'TMC-0001', actor: 'user:7' });
    expect(r.ok).toBe(false);
    expect(r.guardsFailed).toContain('resolution_reason');
    expect(H.state.committed.status).toBeUndefined();
  });

  it('cancelling records the reason in the ledger', async () => {
    const r = await transitionStatus('item-1', 'CANCELLED', ctx({ reason: 'user_marked_wrong: not mine' }));
    expect(r.ok).toBe(true);
    expect(H.state.ledger[0]).toMatchObject({ toStatus: 'CANCELLED', outcome: 'accepted' });
    expect(H.state.ledger[0].reason).toContain('user_marked_wrong');
  });

  it('a cancelled item is treated as OFF the plate everywhere', () => {
    // One shared definition. Without CANCELLED here, withdrawn work would keep
    // appearing in the owner's list and keep being chased by the radar.
    expect(INACTIVE_STATUS_VALUES).toContain('CANCELLED');
    expect(INACTIVE_STATUS_VALUES).toContain('CLOSED');
    expect(INACTIVE_STATUS_VALUES).toContain('DONE');
  });
});

describe('DEF-129 — a transition and the fields it carries are one atomic unit', () => {
  it('an ACCEPTED delegation writes status and delegatee together', async () => {
    const r = await transitionStatus('item-1', 'DELEGATED', ctx({
      itemData: { delegateeName: 'Hamna', delegateeEmail: 'hamna@example.com', delegateeId: null },
    }));

    expect(r.ok).toBe(true);
    expect(H.state.committed).toMatchObject({
      status: 'DELEGATED', delegateeName: 'Hamna', delegateeEmail: 'hamna@example.com',
    });
    expect(H.state.ledger).toHaveLength(1);
  });

  it('a REFUSED delegation leaves NO delegatee fields behind', async () => {
    // The HIGH finding. NEW -> DELEGATED is not in the matrix, so this is
    // refused before anything is written.
    H.state.item.status = 'NEW';

    const r = await transitionStatus('item-1', 'DELEGATED', ctx({
      itemData: { delegateeName: 'Hamna', delegateeEmail: 'hamna@example.com' },
    }));

    expect(r.ok).toBe(false);
    expect(H.state.committed.delegateeName).toBeUndefined();
    expect(H.state.committed.delegateeEmail).toBeUndefined();
    expect(H.state.committed.status).toBeUndefined();
  });

  it('a ledger failure rolls back the delegatee fields too', async () => {
    // Not just the status: everything that travelled with the transition.
    H.state.failLedger = true;

    await expect(transitionStatus('item-1', 'DELEGATED', ctx({
      itemData: { delegateeName: 'Hamna', delegateeEmail: 'hamna@example.com' },
    }))).rejects.toThrow(/ledger unavailable/);

    expect(H.state.committed.delegateeName).toBeUndefined();
    expect(H.state.committed.status).toBeUndefined();
  });

  it('the delegatee guard is satisfied by a delegatee arriving WITH the transition', async () => {
    // Before `itemData`, the guard read the stored row, so the caller had to
    // write the fields first — which is exactly what left them behind.
    const r = await transitionStatus('item-1', 'DELEGATED', ctx({
      itemData: { delegateeEmail: 'hamna@example.com' },
    }));
    expect(r.ok).toBe(true);
    expect(r.guardsFailed).toBeUndefined();
  });

  it('still refuses when NO delegatee is supplied by either route', async () => {
    const r = await transitionStatus('item-1', 'DELEGATED', ctx());
    expect(r.ok).toBe(false);
    expect(r.guardsFailed).toContain('delegatee_set');
  });

  it('itemData can NEVER override the status the matrix approved', async () => {
    // A caller smuggling `status` past the guards would defeat the whole matrix.
    const r = await transitionStatus('item-1', 'CANCELLED', ctx({
      itemData: { status: 'CLOSED', metadata: { archivedReason: 'user_marked_wrong' } },
    }));
    expect(r.ok).toBe(true);
    expect(H.state.committed.status).toBe('CANCELLED');
    expect(H.state.committed.metadata).toMatchObject({ archivedReason: 'user_marked_wrong' });
  });

  it('tenant isolation: the item is loaded by tenant, and a foreign tenant finds nothing', async () => {
    H.state.item = null;
    const r = await transitionStatus('item-1', 'CANCELLED', ctx({ clientNumber: 'OTHER-9' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not found');
    expect(H.state.ledger).toHaveLength(0);
    const call = (H.client.openItem.findFirst as any).mock.calls.at(-1)[0];
    expect(call.where.clientNumber).toBe('OTHER-9');
  });
});

describe('DEF-129 — the legacy DONE normalisation migration', () => {
  it('writes an audit row for every item it changes', () => {
    expect(DONE_SQL).toContain('INSERT INTO "item_status_history"');
    expect(DONE_SQL).toMatch(/'DONE',\s*'CLOSED',\s*'accepted'/);
    expect(DONE_SQL).toContain("'system'");
  });

  it('carries tenant AND user onto each audit row', () => {
    expect(DONE_SQL).toContain('oi."client_number"');
    expect(DONE_SQL).toContain('oi."user_id"');
  });

  it('is idempotent — a re-run matches nothing', () => {
    // Both statements are predicated on status = 'DONE', which is false after
    // the first run, so a second run inserts nothing and updates nothing.
    const guarded = DONE_SQL.match(/WHERE\s+(oi\.)?"status" = 'DONE'/g) ?? [];
    expect(guarded.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT add DONE as a status — it removes it', () => {
    expect(ALL_STATUSES).not.toContain('DONE');
    expect(DONE_SQL).toContain(`SET "status" = 'CLOSED'`);
  });

  it('is a new folder, leaving the recorded April migration untouched', () => {
    const april = readFileSync(
      join(__dirname, '..', 'prisma', 'migrations', '20260419_v15_item_lifecycle', 'migration.sql'), 'utf-8');
    expect(april).not.toContain('DEF-129');
  });
});
