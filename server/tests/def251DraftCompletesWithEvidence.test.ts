/**
 * DEF-251 — completed work is recordable on a DRAFT item; abandonment still
 * is not closable. The deck's one open tag:
 * `Asked to delete drafts, sometimes told drafts don't exist, sometimes
 * blocked because it IS a draft`.
 *
 * The live hit (S23, 2026-08-27 07:57): "I replied to Arshad on this emai"
 * → "I wasn't able to close the item about the Pakistan payroll because it's
 * still in draft." The payroll answer existed; the record could not say so —
 * DEF-236's "three, and only three" exits from DRAFT had no completion exit,
 * which also walled off DEF-250's reconciliation close on exactly the item
 * class most likely to be resolved by a thread reply (email-derived drafts).
 *
 * The line DEF-236 defended survives intact: an ABANDON must never be written
 * as completion. DRAFT→CLOSED demands `resolution_reason` (completion
 * evidence); DRAFT→CANCELLED remains the evidence-free abandon path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

const state = {
  item: null as any,
  updates: [] as any[],
  historyRows: [] as any[],
};

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0, groupBy: async () => [],
  };
  const tables: any = {
    openItem: {
      findFirst: async () => state.item,
      update: async (args: any) => { state.updates.push(args); return {}; },
    },
    itemStatusHistory: {
      create: async (args: any) => { const row = { id: 'h1', ...args.data }; state.historyRows.push(row); return row; },
    },
  };
  const p: any = new Proxy(tables, { get: (t: any, k: string) => (k in t ? t[k] : (k === '$transaction' ? (fn: any) => fn(p) : empty)) });
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/infra/pubsubPublisher', () => ({ publish: vi.fn(async () => undefined) }));

import { findTransition, TRANSITIONS } from '../src/services/itemLifecycle/transitionMatrix';

const PAYROLL_DRAFT = {
  id: 'oi-payroll',
  clientNumber: 'TMC-0001',
  userId: 2,
  ownerId: 2,
  status: 'DRAFT',
  title: 'Check with SAP about Pakistan Payroll',
};

describe('DEF-251 — the matrix: completion exists, evidence-guarded; abandon unchanged', () => {
  it('DRAFT→CLOSED exists, demands resolution_reason, needs no approval', () => {
    const t = findTransition('DRAFT', 'CLOSED');
    expect(t).toBeTruthy();
    expect(t?.guards).toContain('resolution_reason');
    expect(t?.requiresApproval).toBe(false);
  });

  it('DRAFT→CANCELLED (abandon) remains evidence-free — the two cases stay distinct', () => {
    const t = findTransition('DRAFT', 'CANCELLED');
    expect(t).toBeTruthy();
    expect(t?.guards ?? []).not.toContain('resolution_reason');
  });

  it('the matrix count moved 32 → 33, documented', () => {
    expect(TRANSITIONS).toHaveLength(33);
  });
});

describe('DEF-251 — the S23 shape through the REAL lifecycle service', () => {
  beforeEach(() => {
    state.item = { ...PAYROLL_DRAFT };
    state.updates = [];
    state.historyRows = [];
  });

  it('WITH completion evidence, the payroll draft closes — status write + ledger row', async () => {
    const { transitionStatus } = await import('../src/services/itemLifecycle/lifecycleService');
    const res = await transitionStatus('oi-payroll', 'CLOSED', {
      clientNumber: 'TMC-0001',
      actor: 'user:2',
      reason: 'Owner replied to Arshad on the payroll thread — answer provided',
    });
    expect(res.ok).toBe(true);
    expect(state.updates[0]?.data?.status).toBe('CLOSED');
    expect(state.historyRows[0]).toMatchObject({});
    expect(state.historyRows).toHaveLength(1);
  });

  it('WITHOUT evidence, the close is refused and no STATUS is written — abandon cannot masquerade as done', async () => {
    const { transitionStatus } = await import('../src/services/itemLifecycle/lifecycleService');
    const res = await transitionStatus('oi-payroll', 'CLOSED', {
      clientNumber: 'TMC-0001',
      actor: 'user:2',
    });
    expect(res.ok).toBe(false);
    // No status write. The lifecycle DOES ledger the refusal itself (an
    // audited "rejected" row — DEF-127's design, refusals leave receipts);
    // what must never exist is an applied CLOSED write.
    expect(state.updates).toHaveLength(0);
    for (const h of state.historyRows) expect(h.outcome).not.toBe('accepted');
  });
});
