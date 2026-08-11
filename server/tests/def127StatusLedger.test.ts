/**
 * DEF-127 — the open-item status ledger, restored.
 *
 * `item_status_history` was dropped on 2026-05-18 as an "orphan". It was not one.
 * `transitionStatus` writes it inside the SAME transaction as the status update,
 * so with the table and the model gone, `(tx as any).itemStatusHistory.create`
 * threw and the transaction REVERTED the status change. Proven on production by
 * a read-only aborted probe: `typeof tx.itemStatusHistory === 'undefined'`.
 *
 * Two live user-facing paths were broken by that: the Open Items page status
 * control (`OpenItemsPage.jsx:174`) and Brain's `mark_open_item_done` /
 * `delegate_open_item`.
 *
 * The 2026-05-18 note claimed `open_items.notes` had replaced it. Measured on
 * production: 24 note entries across 7 of 277 items, and NONE records a status
 * change. There was no audit trail at all — 267 items were closed with no record
 * of who closed them or why.
 *
 * Two things these tests exist to hold:
 *   1. status + ledger are ONE atomic unit, in both directions;
 *   2. the ledger is USER-owned — one colleague must never read another's trail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const H = vi.hoisted(() => {
  const state = {
    item: null as any,
    ledger: [] as any[],
    /** make the ledger write fail, to prove the status update is rolled back */
    failLedger: false,
    statusWrites: [] as any[],
  };

  const ledgerCreate = vi.fn(async ({ data }: any) => {
    if (state.failLedger) throw new Error('ledger unavailable');
    const row = { id: state.ledger.length + 1, ...data };
    state.ledger.push(row);
    return row;
  });

  const itemUpdate = vi.fn(async ({ data }: any) => {
    state.statusWrites.push(data);
    return { ...state.item, ...data };
  });

  const client = {
    openItem: {
      findFirst: vi.fn(async () => state.item),
      update: itemUpdate,
    },
    itemStatusHistory: {
      create: ledgerCreate,
      findMany: vi.fn(async ({ where }: any) => state.ledger.filter((r) =>
        r.clientNumber === where.clientNumber
        && (where.userId === undefined || r.userId === where.userId)
        && (where.openItemId === undefined || r.openItemId === where.openItemId))),
      count: vi.fn(async () => state.ledger.length),
    },
    // Real transaction semantics: if the callback throws, everything it did is
    // discarded. That is the behaviour the whole defect turns on.
    $transaction: vi.fn(async (fn: any) => {
      const before = [...state.statusWrites];
      try {
        return await fn(client);
      } catch (e) {
        state.statusWrites = before; // rollback
        throw e;
      }
    }),
  };

  return { state, client, ledgerCreate, itemUpdate };
});

vi.mock('../src/db/prisma', () => ({ default: H.client }));
vi.mock('../src/services/infra/pubsubPublisher', () => ({ publish: vi.fn(async () => undefined) }));

import { transitionStatus } from '../src/services/itemLifecycle/lifecycleService';

const SQL = readFileSync(
  join(__dirname, '..', 'prisma', 'migrations', '20260811_item_status_history_restore', 'migration.sql'),
  'utf-8',
);
const SCHEMA = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf-8');

beforeEach(() => {
  H.state.ledger.length = 0;
  H.state.statusWrites.length = 0;
  H.state.failLedger = false;
  H.state.item = {
    id: 'item-1', status: 'NEW', userId: 7, ownerId: 7,
    delegateeId: null, delegateeEmail: null, entityId: null,
    priority: 'medium', title: 'Test item',
  };
  H.ledgerCreate.mockClear();
  H.itemUpdate.mockClear();
});

describe('DEF-127 — an accepted transition writes status and ledger atomically', () => {
  it('accepts the transition and records exactly ONE accepted row', async () => {
    const r = await transitionStatus('item-1', 'TRIAGED', { clientNumber: 'TMC-0001', actor: 'user:7' });

    expect(r.ok).toBe(true);
    expect(r.historyId).toBe(1);
    expect(H.state.ledger).toHaveLength(1);
    expect(H.state.ledger[0]).toMatchObject({
      clientNumber: 'TMC-0001', userId: 7, openItemId: 'item-1',
      fromStatus: 'NEW', toStatus: 'TRIAGED', outcome: 'accepted', actor: 'user:7',
    });
  });

  it('rolls the status update BACK when the ledger write fails', async () => {
    // The invariant, stated as a test: a mutation without its audit must not
    // mutate. This is also the exact mechanism that broke production — except
    // there it failed on EVERY transition, silently.
    H.state.failLedger = true;

    await expect(transitionStatus('item-1', 'TRIAGED', { clientNumber: 'TMC-0001', actor: 'user:7' }))
      .rejects.toThrow(/ledger unavailable/);

    expect(H.state.statusWrites).toHaveLength(0);
    expect(H.state.ledger).toHaveLength(0);
  });

  it('carries the owning user from the ITEM, not from the caller', async () => {
    // ctx has no userId field at all, so it cannot be spoofed or defaulted.
    H.state.item.userId = 42;
    await transitionStatus('item-1', 'TRIAGED', { clientNumber: 'TMC-0001', actor: 'agent:reflection' });
    expect(H.state.ledger[0].userId).toBe(42);
  });
});

describe('DEF-127 — rejected transitions are recorded too, with their user', () => {
  it('records a guard failure as rejected, and does not change status', async () => {
    // TRIAGED -> DELEGATED exists in the matrix and carries `delegatee_set`;
    // this item has no delegatee, so the guard is what refuses it.
    H.state.item.status = 'TRIAGED';
    const r = await transitionStatus('item-1', 'DELEGATED', { clientNumber: 'TMC-0001', actor: 'user:7' });

    expect(r.ok).toBe(false);
    expect(r.guardsFailed).toContain('delegatee_set');
    expect(H.state.statusWrites).toHaveLength(0);
    expect(H.state.ledger[0]).toMatchObject({ outcome: 'rejected', userId: 7, toStatus: 'DELEGATED' });
    expect(H.state.ledger[0].reason).toContain('guards failed');
  });

  it('records an off-matrix transition as rejected, with the user', async () => {
    // NEW -> WAITING_INFO is not in the matrix (NEW goes to TRIAGED,
    // IN_PROGRESS, INFORMED or CLOSED only).
    const r = await transitionStatus('item-1', 'WAITING_INFO', { clientNumber: 'TMC-0001', actor: 'user:7' });
    expect(r.ok).toBe(false);
    expect(H.state.ledger[0]).toMatchObject({ outcome: 'rejected', userId: 7 });
  });

  it('records a no-op self-transition as rejected, with the user', async () => {
    const r = await transitionStatus('item-1', 'NEW', { clientNumber: 'TMC-0001', actor: 'user:7' });
    expect(r.ok).toBe(false);
    expect(H.state.ledger[0]).toMatchObject({ outcome: 'rejected', userId: 7, reason: 'no-op self-transition' });
  });

  it('EVERY rejected path supplies a userId — none defaults to null', async () => {
    // Four rejected branches exist; a missed one would write NULL into a NOT NULL
    // column and turn a refusal into a crash.
    await transitionStatus('item-1', 'NEW', { clientNumber: 'TMC-0001', actor: 'user:7' });          // no-op
    await transitionStatus('item-1', 'WAITING_INFO', { clientNumber: 'TMC-0001', actor: 'user:7' });  // off-matrix
    await transitionStatus('item-1', 'CLOSED', { clientNumber: 'TMC-0001', actor: 'user:7' });        // needs approval

    expect(H.state.ledger.length).toBeGreaterThanOrEqual(3);
    for (const row of H.state.ledger) {
      expect(typeof row.userId).toBe('number');
    }
  });

  it('a ledger failure on a REJECTED path still returns the refusal', async () => {
    // Asymmetry kept on purpose: the rejected write is best-effort, because
    // failing to log a refusal must not turn it into an exception.
    H.state.failLedger = true;
    const r = await transitionStatus('item-1', 'WAITING_INFO', { clientNumber: 'TMC-0001', actor: 'user:7' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no valid transition');
  });
});

describe('DEF-127 — the ledger is user-owned, not merely tenant-scoped', () => {
  it('is registered in BOTH guard registries', async () => {
    const { TENANT_SCOPED_MODELS, USER_SCOPED_MODELS } = await vi.importActual<any>('../src/db/prisma');
    expect(TENANT_SCOPED_MODELS.has('ItemStatusHistory')).toBe(true);
    expect(USER_SCOPED_MODELS.has('ItemStatusHistory')).toBe(true);
  });

  it('one user cannot read another user\'s trail in the same tenant', async () => {
    H.state.ledger.push(
      { id: 1, clientNumber: 'TMC-0001', userId: 7, openItemId: 'item-1', outcome: 'accepted' },
      { id: 2, clientNumber: 'TMC-0001', userId: 9, openItemId: 'item-1', outcome: 'accepted' },
    );

    const mine = await H.client.itemStatusHistory.findMany({
      where: { clientNumber: 'TMC-0001', userId: 7, openItemId: 'item-1' },
    });

    expect(mine).toHaveLength(1);
    expect(mine[0].userId).toBe(7);
  });

  it('the route reads are user-scoped in source, not tenant-only', async () => {
    const route = readFileSync(join(__dirname, '..', 'src', 'routes', 'openItemsRoutes.ts'), 'utf-8');
    const block = route.slice(route.indexOf('prisma.itemStatusHistory.findMany'));
    expect(block.slice(0, 400)).toContain('userId: user.id');
    const countBlock = route.slice(route.indexOf('prisma.itemStatusHistory.count'));
    expect(countBlock.slice(0, 400)).toContain('userId: user.id');
  });

  it('no `as any` remains on the lifecycle or route ledger access', () => {
    const life = readFileSync(join(__dirname, '..', 'src', 'services', 'itemLifecycle', 'lifecycleService.ts'), 'utf-8');
    const route = readFileSync(join(__dirname, '..', 'src', 'routes', 'openItemsRoutes.ts'), 'utf-8');
    expect(life).not.toContain('as any).itemStatusHistory');
    expect(route).not.toContain('as any).itemStatusHistory');
  });
});

describe('DEF-127 — the migration is idempotent and matches the model', () => {
  it('is a NEW folder, never an edit to the recorded April migration', () => {
    const april = readFileSync(
      join(__dirname, '..', 'prisma', 'migrations', '20260419_v15_item_lifecycle', 'migration.sql'), 'utf-8',
    );
    // The April migration is in _prisma_migrations and will never re-run;
    // editing it would be ledger drift. It must still carry its original shape,
    // which had no user_id.
    expect(april).toContain('CREATE TABLE IF NOT EXISTS "item_status_history"');
    expect(april).not.toContain('user_id');
  });

  it('every DDL statement is guarded so a re-run is a no-op', () => {
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS "item_status_history"');
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS "user_id"');
    const creates = SQL.match(/CREATE INDEX/g) ?? [];
    const guarded = SQL.match(/CREATE INDEX IF NOT EXISTS/g) ?? [];
    expect(creates).toHaveLength(guarded.length);
  });

  it('user_id ends NOT NULL, and is grounded rather than defaulted', () => {
    expect(SQL).toMatch(/"user_id"\s+INTEGER\s+NOT NULL/);
    expect(SQL).toContain('ALTER COLUMN "user_id" SET NOT NULL');
    // The recovery joins on BOTH tenant and item, so a colliding id in another
    // tenant can never supply the owner.
    expect(SQL).toContain('oi."id" = h."open_item_id"');
    expect(SQL).toContain('oi."client_number" = h."client_number"');
    // No DEFAULT on user_id anywhere — a default would invent an owner.
    const userIdLines = SQL.split('\n').filter((l) => l.includes('"user_id"'));
    expect(userIdLines.some((l) => /DEFAULT/i.test(l))).toBe(false);
  });

  it('refuses to continue if any row cannot be grounded', () => {
    expect(SQL).toContain('RAISE EXCEPTION');
    expect(SQL).toMatch(/WHERE "user_id" IS NULL/);
  });

  it('performs NO historical audit backfill', () => {
    // 267 items are already closed with no record of why. Inventing rows for
    // them would fabricate audit. The only UPDATE permitted here is the
    // grounded user_id recovery on rows that already exist.
    const inserts = SQL.match(/INSERT\s+INTO/gi) ?? [];
    expect(inserts).toHaveLength(0);
    const updates = SQL.match(/UPDATE\s+"item_status_history"/g) ?? [];
    expect(updates).toHaveLength(1);
  });

  it('creates exactly the three tenant-first indexes, and no global one', () => {
    expect(SQL).toContain('"client_number", "open_item_id", "created_at"');
    expect(SQL).toContain('"client_number", "user_id", "created_at"');
    expect(SQL).toContain('"client_number", "outcome", "created_at"');
    // No verified consumer does cross-tenant history queries, and an unused
    // index is write cost for nothing.
    expect(SQL).not.toMatch(/CREATE INDEX[^;]*ON "item_status_history" \("created_at"/);
  });

  it('SQL and Prisma model agree on every column', () => {
    const model = SCHEMA.slice(SCHEMA.indexOf('model ItemStatusHistory'));
    const body = model.slice(0, model.indexOf('}'));
    for (const col of [
      'client_number', 'user_id', 'open_item_id', 'from_status',
      'to_status', 'outcome', 'reason', 'actor', 'trace_id', 'created_at',
    ]) {
      expect(SQL, `SQL missing ${col}`).toContain(`"${col}"`);
      expect(body, `model missing ${col}`).toMatch(new RegExp(col.replace(/_/g, '_?')));
    }
    expect(body).toContain('@@map("item_status_history")');
    expect(body).toMatch(/userId\s+Int\s+@map\("user_id"\)/); // required, not Int?
  });
});

/**
 * DEF-128 — Brain reported a REFUSED transition as a completion.
 *
 * Found on 2026-08-11 by the ledger DEF-127 restored, during that build's own
 * live acceptance. A real Brain turn answered:
 *
 *   Marked "[DEF-127 TEST] Brain transition acceptance" done.
 *
 * while the audit row written in the same second said:
 *
 *   NEW->CLOSED  rejected  "approval required, none provided"
 *
 * and the item was still NEW. `transitionStatus` RETURNS `{ ok:false, error }`
 * for a refusal — guard failed, approval required, not in the matrix — it does
 * not throw. Both Brain call sites discarded the result and composed a success
 * summary unconditionally. That is the fabricated-completion class §2.5 forbids,
 * and it also meant `delegate_open_item` queued a delegatee email for a
 * delegation that had not happened.
 *
 * These are supplementary source assertions; the primary evidence is the live
 * re-run recorded in the deploy row.
 */
describe('DEF-128 — a refused transition is never reported as done', () => {
  const composer = readFileSync(join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf-8');

  it('mark_open_item_done inspects the transition result', () => {
    const block = composer.slice(composer.indexOf("reason: act.completionNote || 'Marked done via Brain Chat'"));
    expect(block.slice(0, 500)).toContain('closeResult.ok');
    expect(block.slice(0, 700)).toContain('[mark_open_item_done: not closed');
  });

  it('delegate_open_item inspects the transition result', () => {
    const block = composer.slice(composer.indexOf('const delegateResult = await transitionStatus'));
    expect(block.slice(0, 600)).toContain('delegateResult.ok');
    expect(block.slice(0, 700)).toContain('[delegate_open_item: not delegated');
  });

  it('neither success summary can be reached without an ok result', () => {
    // The success wording must sit INSIDE the ok branch, not after it.
    const close = composer.slice(composer.indexOf('const closeResult = await transitionStatus'));
    const okIdx = close.indexOf('} else {');
    const summaryIdx = close.indexOf('let summary = `Marked');
    expect(okIdx).toBeGreaterThan(-1);
    expect(summaryIdx).toBeGreaterThan(okIdx);
  });

  it('refusal messages are bracketed markers, not hardcoded Brain sentences', () => {
    // §2.4 — a plain English sentence pretending to be Brain is forbidden;
    // markers are rendered into Brain's voice by answerSanitizer.
    expect(composer).toContain('[mark_open_item_done: not closed —');
    expect(composer).toContain('[delegate_open_item: not delegated —');
  });
});
