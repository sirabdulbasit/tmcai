/**
 * DEF-186 / DEF-187 / DEF-188 / DEF-189 / DEF-190 — C-3 increment 3: junk
 * withdraws itself, the owner is told once, and the telling can be neither
 * false, nor lost, nor doubled, nor split, nor cross-tenant.
 *
 * Three surfaces, one chain:
 *
 *   1. `zombieItemPolicy` — 'stale_no_engagement' joins the SAME reversible
 *      quarantine → grace → soft-close lifecycle as malformed residue.
 *   2. `renderSelfPruneNotice` ↔ `curatedMarkerMeaning` — the withdrawal
 *      notice is the sanctioned marker form (field boundary, clamp/reject).
 *   3. The cleanup job + the DEF-190 notice OUTBOX (Codex iteration-3
 *      directives 1-4): a batch is ONE atomic insert with an immutable
 *      member snapshot and unique dedup identity (a partial claim cannot
 *      exist); members are REVALIDATED with a fresh read immediately before
 *      enqueue (a restored item is never announced); the queue is asked for
 *      the batch identity in ANY state before sending (a sent-mark failure
 *      can never re-send); owed flags are cleared from a FRESH re-read under
 *      a status+updatedAt CAS (a concurrent metadata write survives); and
 *      the stale sweep runs only under CONFIRMED settings authority — a
 *      no-user pair holds and counts `heldNoAuthority`.
 *
 * The prisma mock honours EVERY stated filter (tenant, user, status —
 * scalar and set —, updatedAt, JSON path, dedupKey, outbox state) against
 * in-memory tables: dropping any scope or predicate in the job turns these
 * tests red. (`def189OpenItemsSettingsFailClosed.test.ts` tests the REAL
 * settings module against a rejecting Prisma.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const mocks = vi.hoisted(() => {
  const state = {
    items: [] as any[],
    /** Outbox rows (self_prune_notice_batches). */
    batches: [] as any[],
    /** Tenant registry rows for the ForAllTenants wrapper. */
    tenants: [] as string[],
    /** Prompts the queue accepted — what brainPromptQueue.findFirst reads. */
    prompts: [] as any[],
    /** openItem.updateMany targeting one of these ids throws. */
    failUpdateIds: new Set<string>(),
    /** Throw ONLY on the owed:false clear write for these ids. */
    failOwedMarkIds: new Set<string>(),
    /** Fail the next N outbox creates (batch insert rejected). */
    batchCreateFailNext: 0,
    /** Fail the next N outbox sent-marks (state -> 'sent'). */
    batchMarkFailNext: 0,
    /**
     * DEF-208 — the OTHER sent-mark failure: the update raises nothing and
     * matches NOTHING, because a concurrent writer moved the batch out of
     * 'pending'. A throw rolls back on its own; a count of 0 only rolls back if
     * the code turns it into one, which is exactly the branch worth pinning.
     */
    batchMarkZeroNext: 0,
    /** Same, for the cancel-mark taken when every member was restored. */
    batchCancelZeroNext: 0,
    /** Fail the next N enqueues (transient queue outage). */
    enqueueFailNext: 0,
    /** One-shot: mutate the store after a full-item read (concurrent editor). */
    afterItemRead: null as null | ((s: any) => void),
    /** One-shot: mutate the store before the clear's findFirst evaluates. */
    onClearRead: null as null | ((s: any) => void),
    /** True only while the $transaction callback is running. */
    inTx: false,
    /**
     * DEF-208 — THE BARRIER. One-shot, fires on a full-item read made INSIDE
     * the transaction, i.e. exactly between the final revalidation and the
     * claim/enqueue. Codex iteration-4 directive 2: "add a barrier precisely
     * after final revalidation and before queue insertion; restoration must
     * yield no queued withdrawal fact."
     */
    afterTxItemRead: null as null | ((s: any) => void),
  };

  function matches(row: any, where: any): boolean {
    if (!where) return true;
    if (where.id !== undefined && typeof where.id !== 'object' && row.id !== where.id) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.clientNumber !== undefined && row.clientNumber !== where.clientNumber) return false;
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (typeof where.status === 'string' && row.status !== where.status) return false;
    if (where.status?.in && !where.status.in.includes(row.status)) return false;
    if (typeof where.state === 'string' && row.state !== where.state) return false;
    if (where.state?.in && !where.state.in.includes(row.state)) return false;
    if (where.priority?.not !== undefined && row.priority === where.priority.not) return false;
    if (where.updatedAt !== undefined
      && +new Date(row.updatedAt) !== +new Date(where.updatedAt)) return false;
    if (where.metadata?.path) {
      const [a, b] = where.metadata.path;
      if (row.metadata?.[a]?.[b] !== where.metadata.equals) return false;
    }
    if (where.dedupKey !== undefined && row.dedupKey !== where.dedupKey) return false;
    return true;
  }

  const findMany = vi.fn(async (args: any) => {
    let rows = state.items.filter((i) => matches(i, args?.where));
    if (args?.orderBy?.createdAt === 'asc') {
      rows = [...rows].sort((x, y) => +new Date(x.createdAt) - +new Date(y.createdAt));
    }
    if (args?.orderBy?.userId === 'asc') {
      rows = [...rows].sort((x, y) => x.userId - y.userId);
    }
    if (args?.distinct) {
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        const k = args.distinct.map((d: string) => String(r[d])).join('|');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    // DEF-209 — `skip` is honoured, so a paging bug cannot pass by re-reading
    // page 0 forever. Applied BEFORE take, as Prisma does.
    if (args?.skip) rows = rows.slice(args.skip);
    if (args?.take) rows = rows.slice(0, args.take);
    const out = rows.map((r) => ({ ...r }));
    // The concurrent editor: mutates the STORE between this read and the
    // job's next step. Fires only on full-item reads (they select `title`).
    if (state.afterItemRead && args?.select?.title) {
      const hook = state.afterItemRead;
      state.afterItemRead = null;
      hook(state);
    }
    if (state.inTx && state.afterTxItemRead && args?.select?.title) {
      const hook = state.afterTxItemRead;
      state.afterTxItemRead = null;
      hook(state);
    }
    return out;
  });

  const findFirst = vi.fn(async (args: any) => {
    if (state.onClearRead) {
      const hook = state.onClearRead;
      state.onClearRead = null;
      hook(state);
    }
    const row = state.items.find((i) => matches(i, args?.where));
    return row ? { ...row } : null;
  });

  const updateMany = vi.fn(async (args: any) => {
    const targets = state.items.filter((i) => matches(i, args?.where));
    if (targets.some((t) => state.failUpdateIds.has(t.id))) {
      throw new Error('update rejected (test)');
    }
    const isOwedClear = args?.data?.metadata?.selfPruneNotice?.owed === false;
    if (isOwedClear && targets.some((t) => state.failOwedMarkIds.has(t.id))) {
      throw new Error('owed clear rejected (test)');
    }
    for (const t of targets) {
      if (args.data.status !== undefined) t.status = args.data.status;
      if (args.data.metadata !== undefined) t.metadata = args.data.metadata;
      t.updatedAt = new Date(); // @updatedAt
    }
    return { count: targets.length };
  });

  let batchSeq = 0;
  const batchFindMany = vi.fn(async (args: any) => {
    let rows = state.batches.filter((b) => matches(b, args?.where));
    if (args?.orderBy?.createdAt === 'asc') {
      rows = [...rows].sort((x, y) => +new Date(x.createdAt) - +new Date(y.createdAt));
    }
    return rows.map((r) => ({ ...r }));
  });
  const batchCreate = vi.fn(async (args: any) => {
    if (state.batchCreateFailNext > 0) {
      state.batchCreateFailNext--;
      throw new Error('outbox insert rejected (test)');
    }
    // DEF-210 — the DATABASE constraint, modelled. `self_prune_notice_batches_dedup_uq`
    // is a UNIQUE INDEX on `dedup_key` (20260817_self_prune_notice_outbox
    // migration.sql:25), and it is the whole of Codex iteration-4 HIGH 3's answer:
    // two concurrent creators that select the same owed events derive the SAME
    // key, so the second one collides here instead of announcing a second time.
    // A mock that accepted the duplicate would let that guarantee rot untested.
    if (state.batches.some((b: any) => b.dedupKey === args?.data?.dedupKey)) {
      throw new Error('duplicate key value violates unique constraint "self_prune_notice_batches_dedup_uq"');
    }
    const row = {
      id: `nb-${++batchSeq}`,
      state: 'pending',
      createdAt: new Date(),
      sentAt: null,
      cancelledReason: null,
      promptId: null,
      ...args.data,
    };
    state.batches.push(row);
    return { ...row };
  });
  const batchUpdateMany = vi.fn(async (args: any) => {
    const targets = state.batches.filter((b) => matches(b, args?.where));
    if (args?.data?.state === 'sent' && state.batchMarkFailNext > 0 && targets.length > 0) {
      state.batchMarkFailNext--;
      throw new Error('outbox sent-mark rejected (test)');
    }
    if (args?.data?.state === 'sent' && state.batchMarkZeroNext > 0) {
      state.batchMarkZeroNext--;
      return { count: 0 };
    }
    if (args?.data?.state === 'cancelled' && state.batchCancelZeroNext > 0) {
      state.batchCancelZeroNext--;
      return { count: 0 };
    }
    for (const t of targets) Object.assign(t, args.data);
    return { count: targets.length };
  });

  const userFindMany = vi.fn(async (args: any) => {
    let tenants = [...state.tenants];
    if (args?.orderBy?.clientNumber === 'asc') tenants.sort();
    return tenants.map((clientNumber) => ({ clientNumber }));
  });

  const promptFindFirst = vi.fn(async (args: any) => {
    return state.prompts.find((p) => matches(p, args?.where)) ?? null;
  });

  const enqueueBrainPrompt = vi.fn(async (input: any) => {
    if (state.enqueueFailNext > 0) {
      state.enqueueFailNext--;
      throw new Error('queue down (test)');
    }
    state.prompts.push({ ...input });
    return { status: 'queued', promptId: `p${state.prompts.length}` };
  });

  /** Snapshot / restore the in-memory tables around the callback. */
  const runInTransaction = (client: any) => vi.fn(async (fn: any) => {
    const snap = {
      items: state.items.map((r: any) => ({
        ...r, metadata: r.metadata ? JSON.parse(JSON.stringify(r.metadata)) : r.metadata,
      })),
      batches: state.batches.map((b: any) => ({ ...b })),
      prompts: state.prompts.map((p: any) => ({ ...p })),
    };
    state.inTx = true;
    try {
      return await fn(client);
    } catch (err) {
      state.items = snap.items;
      state.batches = snap.batches;
      state.prompts = snap.prompts;
      throw err;
    } finally {
      state.inTx = false;
    }
  });

  return {
    state,
    runInTransaction,
    findMany,
    findFirst,
    updateMany,
    batchFindMany,
    batchCreate,
    batchUpdateMany,
    userFindMany,
    promptFindFirst,
    enqueueBrainPrompt,
    resolveOpenItemsSettings: vi.fn(),
    getBehaviorValue: vi.fn(),
  };
});

vi.mock('../src/db/prisma', () => {
  const client: any = {
    openItem: {
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      updateMany: mocks.updateMany,
    },
    selfPruneNoticeBatch: {
      findMany: mocks.batchFindMany,
      create: mocks.batchCreate,
      updateMany: mocks.batchUpdateMany,
    },
    user: { findMany: mocks.userFindMany },
    brainPromptQueue: { findFirst: mocks.promptFindFirst },
  };
  // DEF-208 — the transaction MOCKS ROLLBACK, because rollback is the property
  // under test: the whole point of the boundary is that a failed sent-mark
  // leaves no queue row and no claim stamp. A `$transaction` that merely ran the
  // callback would let a broken implementation pass.
  client.$transaction = mocks.runInTransaction(client);
  return { default: client };
});

vi.mock('../src/services/openItems/openItemsSettings', () => ({
  resolveOpenItemsSettings: mocks.resolveOpenItemsSettings,
  getOpenItemsSettings: vi.fn(),
}));

vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  enqueueBrainPrompt: mocks.enqueueBrainPrompt,
}));

vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: mocks.getBehaviorValue,
}));

vi.mock('../src/utils/logger', () => ({
  default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  runOpenItemsBacklogCleanup,
  runOpenItemsBacklogCleanupForAllTenants,
} from '../src/jobs/openItemsBacklogCleanupJob';
import {
  classifyZombieOpenItem,
  planZombieLifecycle,
  SELF_PRUNE_POLICY_VERSION,
} from '../src/services/openItems/zombieItemPolicy';
import { renderSelfPruneNotice } from '../src/services/notifications/proactiveMessageText';
import {
  curatedMarkerMeaning,
  sanitizeAnswerForUser,
} from '../src/services/knowledge/answerSanitizer';
import {
  isSystemMarker,
  stripMarkerEnvelope,
  systemMarker,
  SYSTEM_MARKER_SENTINEL,
  NEUTRAL_MARKER_FALLBACK,
} from '../src/services/knowledge/systemMarker';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** A well-formed item nobody has touched — the stale candidate. */
function staleItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-stale-1',
    title: 'Prepare Q2 hiring plan for the Lahore office',
    description: null,
    status: 'NEW',
    priority: 'medium',
    dueDate: null,
    delegateeId: null,
    delegateeName: null,
    delegateeEmail: null,
    notes: [],
    createdAt: daysAgo(40),
    updatedAt: daysAgo(40),
    sourceFeed: 'email',
    sourceRef: 'ref-1',
    metadata: {},
    userId: 7,
    clientNumber: 'tenant-1',
    ...overrides,
  };
}

function quarantinedStaleMeta(detectedDaysAgo: number) {
  return {
    selfPrune: {
      version: SELF_PRUNE_POLICY_VERSION,
      state: 'quarantined',
      reason: 'stale_no_engagement',
      suppressProactive: true,
      detectedAt: daysAgo(detectedDaysAgo).toISOString(),
      lastEvaluatedAt: daysAgo(detectedDaysAgo).toISOString(),
    },
  };
}

/** An already-archived row carrying its unannounced debt. */
function archivedOwedItem(overrides: Record<string, unknown> = {}) {
  return staleItem({
    status: 'CANCELLED',
    metadata: {
      archivedReason: 'stale_no_engagement',
      archivedAt: daysAgo(1).toISOString(),
      selfPruneNotice: { owed: true, reason: 'stale_no_engagement', recordedAt: daysAgo(1).toISOString() },
    },
    ...overrides,
  });
}

/** DEF-189/190 query-shape sweep: every openItem AND outbox read is tenant-scoped. */
function assertAllQueriesTenantScoped() {
  expect(mocks.findMany.mock.calls.length).toBeGreaterThan(0);
  for (const [args] of mocks.findMany.mock.calls) {
    expect(args.where?.clientNumber, `unscoped openItem query: ${JSON.stringify(args.where)}`)
      .toBeDefined();
  }
  for (const [args] of mocks.batchFindMany.mock.calls) {
    expect(args.where?.clientNumber, `unscoped outbox query: ${JSON.stringify(args.where)}`)
      .toBeDefined();
  }
}

/** Every item write is tenant+user+id constrained and carries a status predicate. */
function assertAllWritesGuarded() {
  expect(mocks.updateMany.mock.calls.length).toBeGreaterThan(0);
  for (const [args] of mocks.updateMany.mock.calls) {
    expect(args.where.id, JSON.stringify(args.where)).toBeDefined();
    expect(args.where.clientNumber, JSON.stringify(args.where)).toBeDefined();
    expect(args.where.userId, JSON.stringify(args.where)).toBeDefined();
    expect(args.where.status, `write without a compare-and-set status: ${JSON.stringify(args.where)}`)
      .toBeDefined();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.items = [];
  mocks.state.batches = [];
  mocks.state.tenants = [];
  mocks.state.prompts = [];
  mocks.state.failUpdateIds.clear();
  mocks.state.failOwedMarkIds.clear();
  mocks.state.batchCreateFailNext = 0;
  mocks.state.batchMarkFailNext = 0;
  mocks.state.batchMarkZeroNext = 0;
  mocks.state.batchCancelZeroNext = 0;
  mocks.state.enqueueFailNext = 0;
  mocks.state.afterItemRead = null;
  mocks.state.onClearRead = null;
  mocks.state.afterTxItemRead = null;
  mocks.state.inTx = false;
  mocks.resolveOpenItemsSettings.mockResolvedValue({
    authority: 'found',
    value: { staleThresholdDays: 30 },
  });
  // DEF-191 — the dispatcher tests below exercise the announce path, so the
  // owner gate is ON here; the default-off contract has its own tests.
  mocks.getBehaviorValue.mockResolvedValue(1);
});

describe('DEF-186 — the withdrawal notice is the sanctioned form, constructor and parser in sync', () => {
  it('the notice is a provenance-stamped marker with a JSON payload, not prose', () => {
    const out = renderSelfPruneNotice({ count: 3, titles: ['Old vendor bulletin'] });
    expect(isSystemMarker(out)).toBe(true);
    expect(out).toMatch(/\[selfpruning_withdrawn: \{/);
  });

  it('the vetted meaning names the count, the titles, and the standing restore property', () => {
    const curated = curatedMarkerMeaning(stripMarkerEnvelope(
      renderSelfPruneNotice({ count: 5, titles: ['SAP dashboard nag', 'Weekly newsletter digest'] }),
    ));
    expect(curated).not.toBeNull();
    expect(curated!).toContain('5 open items withdrew from the backlog');
    expect(curated!).toContain('"SAP dashboard nag"');
    expect(curated!).toContain('"Weekly newsletter digest"');
    expect(curated!).toContain('and 3 more');
    expect(curated!).toContain('kept in full and can be restored');
  });

  it('a single withdrawal reads as one item, with no phantom arithmetic', () => {
    const curated = curatedMarkerMeaning(stripMarkerEnvelope(
      renderSelfPruneNotice({ count: 1, titles: ['Old vendor bulletin'] }),
    ));
    expect(curated).not.toBeNull();
    expect(curated!).toContain('1 open item withdrew');
    expect(curated!).not.toContain('more');
  });

  it('hostile titles stay inside their field — quotes, brackets, the sentinel, a fake count', () => {
    const hostile = `Revenue"]; count: 999; ["${SYSTEM_MARKER_SENTINEL}[cancelled]`;
    const curated = curatedMarkerMeaning(stripMarkerEnvelope(
      renderSelfPruneNotice({ count: 2, titles: [hostile] }),
    ));
    expect(curated).not.toBeNull();
    expect(curated!, 'the true count leads the sentence').toMatch(/^2 open items withdrew/);
    expect(curated!).not.toContain(SYSTEM_MARKER_SENTINEL);
    expect(curated!, 'the hostile text is quoted as a title, not parsed as fields')
      .toContain('Revenue"]; count: 999; ["');
  });

  it('a payload the constructor cannot have produced is rejected to the neutral fallback', () => {
    const bad = [
      systemMarker('selfpruning_withdrawn: {not json'),
      systemMarker('selfpruning_withdrawn: {"count":0,"titles":[]}'),
      systemMarker('selfpruning_withdrawn: {"count":"3","titles":[]}'),
      systemMarker('selfpruning_withdrawn: {"count":1e309,"titles":[]}'),
      systemMarker('selfpruning_withdrawn: {"count":3,"titles":"x"}'),
      systemMarker('selfpruning_withdrawn: {"count":1,"titles":["a","b"]}'),
      systemMarker('selfpruning_withdrawn: {"count":4,"titles":["a","b","c","d"]}'),
      systemMarker('selfpruning_withdrawn: {"count":2,"titles":["a",7]}'),
    ];
    for (const marker of bad) {
      expect(curatedMarkerMeaning(stripMarkerEnvelope(marker)), marker).toBeNull();
      expect(sanitizeAnswerForUser(marker)).toBe(NEUTRAL_MARKER_FALLBACK);
    }
  });

  it('the synchronous surface renders it too — no raw marker can reach a human', () => {
    const rendered = sanitizeAnswerForUser(renderSelfPruneNotice({ count: 2, titles: ['Old nag'] }));
    expect(rendered).not.toContain('selfpruning_withdrawn');
    expect(rendered).not.toContain('[');
    expect(rendered).toContain('2 open items withdrew');
  });
});

describe('DEF-186 — stale_no_engagement joins the reversible lifecycle', () => {
  it('an untouched item past the window classifies stale; the window is the caller’s to supply', () => {
    expect(classifyZombieOpenItem(staleItem(), new Date(), { staleAfterDays: 30 }))
      .toBe('stale_no_engagement');
    expect(classifyZombieOpenItem(staleItem(), new Date()), 'no window, no stale verdict').toBeNull();
    expect(classifyZombieOpenItem(staleItem(), new Date(), { staleAfterDays: 0 }), 'disabled').toBeNull();
    expect(classifyZombieOpenItem(staleItem({ createdAt: daysAgo(10) }), new Date(), { staleAfterDays: 30 }),
      'younger than the window').toBeNull();
  });

  it('any engagement evidence preserves the item — the ONE definition, not the job’s old subset', () => {
    for (const engaged of [
      { dueDate: daysAgo(5) },
      { notes: [{ text: 'still relevant' }] },
      { delegateeName: 'Hamna' },
      { metadata: { userConfirmedAt: daysAgo(3).toISOString() } },
    ]) {
      expect(classifyZombieOpenItem(staleItem(engaged), new Date(), { staleAfterDays: 30 }),
        JSON.stringify(engaged)).toBeNull();
    }
  });

  it('malformed reasons keep their identity even when the item is also old', () => {
    expect(classifyZombieOpenItem(staleItem({ title: 'Untitled' }), new Date(), { staleAfterDays: 30 }))
      .toBe('placeholder_title');
  });

  it('quarantine first, archive only after the grace period', () => {
    const fresh = planZombieLifecycle(staleItem(), new Date(), undefined, { staleAfterDays: 30 });
    expect(fresh.action).toBe('quarantine');
    if (fresh.action === 'quarantine') {
      expect(fresh.reason).toBe('stale_no_engagement');
      expect(fresh.selfPrune.suppressProactive).toBe(true);
    }

    const held = planZombieLifecycle(
      staleItem({ metadata: quarantinedStaleMeta(3) }), new Date(), undefined, { staleAfterDays: 30 });
    expect(held.action).toBe('hold');

    const closed = planZombieLifecycle(
      staleItem({ metadata: quarantinedStaleMeta(8) }), new Date(), undefined, { staleAfterDays: 30 });
    expect(closed.action).toBe('archive');
    if (closed.action === 'archive') expect(closed.selfPrune.state).toBe('archived');
  });

  it('engagement during quarantine recovers the item instead of archiving it', () => {
    const plan = planZombieLifecycle(
      staleItem({ metadata: quarantinedStaleMeta(8), dueDate: daysAgo(1) }),
      new Date(), undefined, { staleAfterDays: 30 });
    expect(plan.action).toBe('recover');
    if (plan.action === 'recover') expect(plan.selfPrune.suppressProactive).toBe(false);
  });

  it('a caller that cannot judge staleness HOLDS a stale quarantine — it never releases what it cannot re-make', () => {
    const plan = planZombieLifecycle(staleItem({ metadata: quarantinedStaleMeta(8) }), new Date());
    expect(plan.action).toBe('none');
  });

  it('disabling the stale sweep releases an existing stale quarantine', () => {
    const plan = planZombieLifecycle(
      staleItem({ metadata: quarantinedStaleMeta(8) }), new Date(), undefined, { staleAfterDays: 0 });
    expect(plan.action).toBe('recover');
  });
});

describe('DEF-187/188/189/190 — the cleanup job: CAS writes, atomic outbox batches, tenant scope everywhere', () => {
  it('first sighting quarantines — tenant-scoped guarded write, no status change, no notice', async () => {
    mocks.state.items = [staleItem()];

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.quarantinedStale).toBe(1);
    expect(stats.archivedStale).toBe(0);
    const row = mocks.state.items[0];
    expect(row.status, 'quarantine never touches status').toBe('NEW');
    expect(row.metadata.selfPrune.state).toBe('quarantined');
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
    expect(mocks.state.batches).toHaveLength(0);
    assertAllWritesGuarded();
    assertAllQueriesTenantScoped();
    expect(mocks.resolveOpenItemsSettings).toHaveBeenCalledWith(7, 'tenant-1');
  });

  it('after the grace period: confirmed soft-close records the debt, ONE atomic batch is created, announced, and cleared', async () => {
    mocks.state.items = [staleItem({ metadata: quarantinedStaleMeta(8) })];

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.archivedStale).toBe(1);
    const row = mocks.state.items[0];
    expect(row.status).toBe('CANCELLED');
    expect(row.metadata.archivedReason).toBe('stale_no_engagement');
    expect(row.metadata.selfPruneNotice.owed, 'debt recorded then cleared on acceptance').toBe(false);

    expect(mocks.state.batches).toHaveLength(1);
    const batch = mocks.state.batches[0];
    expect(batch.state).toBe('sent');
    expect(batch.itemIds).toEqual(['item-stale-1']);
    expect(batch.count).toBe(1);
    expect(row.metadata.selfPruneNotice.batchId).toBe(batch.batchId);

    expect(stats.noticesEnqueued).toBe(1);
    expect(mocks.state.prompts).toHaveLength(1);
    const enq = mocks.state.prompts[0];
    expect(enq.clientNumber, 'the tenant is declared, not inferred').toBe('tenant-1');
    expect(enq.userId).toBe(7);
    expect(enq.expectsReply, 'a notice never holds the conversation lock').toBe(false);
    expect(enq.provenance).toBe('system_marker');
    expect(enq.dedupKey).toBe(batch.dedupKey);
    const curated = curatedMarkerMeaning(stripMarkerEnvelope(enq.question));
    expect(curated, 'the enqueued question is the sanctioned marker with a vetted meaning').not.toBeNull();
    expect(curated!).toContain('1 open item withdrew');
    expect(curated!).toContain('"Prepare Q2 hiring plan for the Lahore office"');
    assertAllWritesGuarded();
  });

  it('a REJECTED archive write is an error, not a withdrawal — no stat, no debt, no batch, no notice (iteration-1 CRITICAL)', async () => {
    mocks.state.items = [staleItem({ metadata: quarantinedStaleMeta(8) })];
    mocks.state.failUpdateIds.add('item-stale-1');

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.archivedStale).toBe(0);
    expect(stats.errors).toBeGreaterThanOrEqual(1);
    const row = mocks.state.items[0];
    expect(row.status, 'the item is still active').toBe('NEW');
    expect(row.metadata.selfPruneNotice).toBeUndefined();
    expect(mocks.state.batches).toHaveLength(0);
    expect(mocks.enqueueBrainPrompt, 'no false notice').not.toHaveBeenCalled();
  });

  it('a row the user touched between read and write is left alone — the compare-and-set fires (iteration-2 HIGH 4)', async () => {
    mocks.state.items = [staleItem({ metadata: quarantinedStaleMeta(8) })];
    mocks.state.afterItemRead = (s) => {
      s.items[0].dueDate = new Date();
      s.items[0].updatedAt = new Date(Date.now() + 1000);
    };

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.raced).toBeGreaterThanOrEqual(1);
    expect(stats.archivedStale, 'no cancellation from a stale snapshot').toBe(0);
    expect(stats.errors).toBe(0);
    const row = mocks.state.items[0];
    expect(row.status).toBe('NEW');
    expect(row.dueDate, 'the user’s edit survives untouched').not.toBeNull();
    expect(row.metadata.selfPruneNotice).toBeUndefined();
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
  });

  it('an item restored between owed selection and enqueue is NEVER announced — revalidation drops it and the empty batch cancels (iteration-3 CRITICAL)', async () => {
    mocks.state.items = [archivedOwedItem()];
    // The restore happens AFTER the owed selection read returns (the batch is
    // created from that stale list) and BEFORE enqueue. The fresh revalidation
    // read inside settleBatch must catch it.
    mocks.state.afterItemRead = (s) => {
      s.items[0].status = 'TRIAGED';
      s.items[0].updatedAt = new Date(Date.now() + 1000);
    };

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(mocks.enqueueBrainPrompt, 'no false owner fact').not.toHaveBeenCalled();
    expect(stats.noticesEnqueued).toBe(0);
    expect(mocks.state.batches).toHaveLength(1);
    expect(mocks.state.batches[0].state, 'the empty batch is cancelled, not sent').toBe('cancelled');
    expect(mocks.state.items[0].status, 'the restore survives').toBe('TRIAGED');
  });

  it('a restored member is dropped while live members are still announced', async () => {
    mocks.state.items = [
      archivedOwedItem({ id: 'a1', title: 'Old vendor digest', sourceRef: 'r1' }),
      archivedOwedItem({ id: 'b1', title: 'Old newsletter sweep', sourceRef: 'r2' }),
    ];
    mocks.state.afterItemRead = (s) => {
      const b = s.items.find((i: any) => i.id === 'b1');
      b.status = 'TRIAGED';
      b.updatedAt = new Date(Date.now() + 1000);
    };

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.noticesEnqueued).toBe(1);
    const curated = curatedMarkerMeaning(stripMarkerEnvelope(mocks.state.prompts[0].question));
    expect(curated!).toContain('1 open item withdrew');
    expect(curated!).toContain('"Old vendor digest"');
    expect(curated!, 'the restored item is not announced').not.toContain('Old newsletter sweep');
    const b1 = mocks.state.items.find((i: any) => i.id === 'b1');
    expect(b1.metadata.selfPruneNotice.owed, 'the restored row keeps its inert flag').toBe(true);
  });

  it('a rejected batch insert creates NOTHING sendable; the next tick forms ONE batch for the whole owed set (iteration-3 HIGH 2)', async () => {
    mocks.state.items = [
      archivedOwedItem({ id: 'a1', title: 'Old vendor digest', sourceRef: 'r1' }),
      archivedOwedItem({ id: 'b1', title: 'Old newsletter sweep', sourceRef: 'r2' }),
    ];
    mocks.state.batchCreateFailNext = 1;

    const first = await runOpenItemsBacklogCleanup('tenant-1');
    expect(first.noticesEnqueued).toBe(0);
    expect(mocks.state.prompts).toHaveLength(0);
    expect(mocks.state.batches).toHaveLength(0);

    const second = await runOpenItemsBacklogCleanup('tenant-1');
    expect(second.noticesEnqueued).toBe(1);
    expect(mocks.state.batches).toHaveLength(1);
    expect(mocks.state.batches[0].itemIds).toEqual(['a1', 'b1']);
    const curated = curatedMarkerMeaning(stripMarkerEnvelope(mocks.state.prompts[0].question));
    expect(curated!, 'one notice for the whole set, never two').toContain('2 open items withdrew');
  });

  it('a transient enqueue failure keeps the batch pending under its ORIGINAL identity; the next tick delivers exactly once', async () => {
    mocks.state.items = [staleItem({ metadata: quarantinedStaleMeta(8) })];
    mocks.state.enqueueFailNext = 1;

    const first = await runOpenItemsBacklogCleanup('tenant-1');
    expect(first.archivedStale).toBe(1);
    expect(first.noticesEnqueued).toBe(0);
    expect(mocks.state.batches).toHaveLength(1);
    expect(mocks.state.batches[0].state).toBe('pending');
    const dedupKey = mocks.state.batches[0].dedupKey;

    const second = await runOpenItemsBacklogCleanup('tenant-1');
    expect(second.noticesEnqueued).toBe(1);
    expect(mocks.state.batches, 'no second batch was minted').toHaveLength(1);
    expect(mocks.state.batches[0].state).toBe('sent');
    expect(mocks.state.prompts).toHaveLength(1);
    expect(mocks.state.prompts[0].dedupKey, 'identity never changed').toBe(dedupKey);

    const third = await runOpenItemsBacklogCleanup('tenant-1');
    expect(third.noticesEnqueued).toBe(0);
    expect(mocks.state.prompts).toHaveLength(1);
  });

  // DEF-208 UPDATED THIS TEST DELIBERATELY, and the property got STRONGER.
  // It used to prove "the retry finds the queue holding the identity" — the
  // enqueue had committed and only the sent-mark failed, so re-sending was
  // prevented by a lookup. Now the enqueue is INSIDE the same transaction as
  // the sent-mark, so a failed mark rolls the queue row back and there is
  // nothing to look up. Same owner-visible guarantee — exactly one message
  // across both attempts — reached by making the bad state unrepresentable
  // instead of detecting it afterwards.
  it('a sent-mark failure rolls the whole announcement back: no queue row, identity intact, exactly one message after the retry', async () => {
    mocks.state.items = [archivedOwedItem()];
    mocks.state.batchMarkFailNext = 1;

    const first = await runOpenItemsBacklogCleanup('tenant-1');
    expect(first.noticesEnqueued, 'nothing was announced').toBe(0);
    expect(mocks.state.prompts, 'the queue row rolled back with the mark').toHaveLength(0);
    expect(mocks.state.batches[0].state, 'mark failed — still pending under the same identity').toBe('pending');
    expect(first.errors, 'the failure is counted, not swallowed').toBeGreaterThan(0);

    const second = await runOpenItemsBacklogCleanup('tenant-1');
    expect(second.noticesEnqueued, 'the retry announces it once').toBe(1);
    expect(mocks.state.batches[0].state).toBe('sent');
    expect(mocks.state.prompts, 'the owner received exactly one message').toHaveLength(1);
  });

  it('a failed owed-flag clear retries from the SENT batch and never re-announces', async () => {
    mocks.state.items = [
      archivedOwedItem({ id: 'a1', title: 'Old vendor digest', sourceRef: 'r1' }),
      archivedOwedItem({ id: 'b1', title: 'Old newsletter sweep', sourceRef: 'r2' }),
    ];
    mocks.state.failOwedMarkIds.add('b1');

    const first = await runOpenItemsBacklogCleanup('tenant-1');
    expect(first.noticesEnqueued).toBe(1);
    const b1 = mocks.state.items.find((i: any) => i.id === 'b1');
    expect(b1.metadata.selfPruneNotice.owed).toBe(true);

    mocks.state.failOwedMarkIds.clear();
    const second = await runOpenItemsBacklogCleanup('tenant-1');
    expect(second.noticesEnqueued, 'clearing retried, nothing re-sent').toBe(0);
    expect(b1.metadata.selfPruneNotice.owed).toBe(false);
    expect(mocks.state.prompts).toHaveLength(1);
  });

  it('a concurrent metadata write between acceptance and clearing SURVIVES — the clear merges the fresh row (iteration-3 HIGH 3)', async () => {
    mocks.state.items = [archivedOwedItem()];
    mocks.state.onClearRead = (s) => {
      const row = s.items[0];
      row.metadata = { ...row.metadata, followUpAudit: 'written-by-another-worker' };
      row.updatedAt = new Date(Date.now() + 500);
    };

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.noticesEnqueued).toBe(1);
    const row = mocks.state.items[0];
    expect(row.metadata.followUpAudit, 'the newer field survives the clear').toBe('written-by-another-worker');
    expect(row.metadata.selfPruneNotice.owed).toBe(false);
  });

  it('staleThresholdDays=0 is the owner’s DISABLE, honored end to end (iteration-1 HIGH)', async () => {
    mocks.resolveOpenItemsSettings.mockResolvedValue({
      authority: 'found', value: { staleThresholdDays: 0 },
    });
    mocks.state.items = [
      staleItem({ id: 'q1', metadata: quarantinedStaleMeta(8) }),
      staleItem({ id: 'f1', sourceRef: 'ref-2', title: 'Draft the Karachi expansion memo' }),
    ];

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.recoveredZombie).toBe(1);
    expect(stats.quarantinedStale).toBe(0);
    expect(stats.archivedStale).toBe(0);
    const q1 = mocks.state.items.find((i: any) => i.id === 'q1');
    expect(q1.status).toBe('NEW');
    expect(q1.metadata.selfPrune.state).toBe('recovered');
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
  });

  it('an ORPHANED pair (no user row) has no settings authority: the sweep holds and the degradation is visible (iteration-3 HIGH 4)', async () => {
    mocks.resolveOpenItemsSettings.mockResolvedValue({ authority: 'no_user', value: null });
    mocks.state.items = [
      staleItem({ id: 'q1', metadata: quarantinedStaleMeta(8) }),
      staleItem({ id: 'f1', sourceRef: 'ref-2', title: 'Draft the Karachi expansion memo' }),
    ];

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.heldNoAuthority, 'the hold is counted, not silent').toBe(1);
    expect(stats.quarantinedStale, 'no new quarantine from fabricated defaults').toBe(0);
    expect(stats.archivedStale).toBe(0);
    expect(stats.recoveredZombie, 'and no release either — this pass cannot judge').toBe(0);
    expect(mocks.state.items.find((i: any) => i.id === 'q1').metadata.selfPrune.state)
      .toBe('quarantined');
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
  });

  it('an unreadable setting means HOLD: no new stale quarantine, and no release of an existing one', async () => {
    mocks.resolveOpenItemsSettings.mockRejectedValue(new Error('settings db down'));
    mocks.state.items = [
      staleItem({ id: 'q1', metadata: quarantinedStaleMeta(8) }),
      staleItem({ id: 'f1', sourceRef: 'ref-2', title: 'Draft the Karachi expansion memo' }),
    ];

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.quarantinedStale).toBe(0);
    expect(stats.archivedStale).toBe(0);
    expect(stats.recoveredZombie).toBe(0);
    expect(mocks.state.items.find((i: any) => i.id === 'q1').metadata.selfPrune.state)
      .toBe('quarantined');
  });

  it('duplicates never collapse across tenants, and the registry drives the sweep (iteration-2 CRITICAL closed)', async () => {
    mocks.state.tenants = ['tenant-1', 'tenant-2'];
    mocks.state.items = [
      staleItem({ id: 'a1', createdAt: daysAgo(2), updatedAt: daysAgo(2), title: 'Approve the Sialkot supplier contract' }),
      staleItem({
        id: 'b1', createdAt: daysAgo(1), updatedAt: daysAgo(1), clientNumber: 'tenant-2',
        title: 'Approve the Multan supplier contract',
      }), // same userId 7, same (sourceFeed, sourceRef) — different tenant
    ];

    const stats = await runOpenItemsBacklogCleanupForAllTenants();

    expect(stats.archivedDuplicate, 'each tenant keeps its own row').toBe(0);
    expect(mocks.state.items.every((i: any) => i.status === 'NEW')).toBe(true);
    expect(mocks.resolveOpenItemsSettings).toHaveBeenCalledWith(7, 'tenant-1');
    expect(mocks.resolveOpenItemsSettings).toHaveBeenCalledWith(7, 'tenant-2');
    assertAllQueriesTenantScoped();
  });

  it('duplicates inside one tenant still collapse to the oldest keeper', async () => {
    mocks.state.items = [
      staleItem({ id: 'old', createdAt: daysAgo(3), updatedAt: daysAgo(3), title: 'Approve the Sialkot supplier contract' }),
      staleItem({ id: 'new', createdAt: daysAgo(1), updatedAt: daysAgo(1), title: 'Review the Gwadar port schedule' }),
    ]; // same tenant, same (sourceFeed, sourceRef)

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.archivedDuplicate).toBe(1);
    const dup = mocks.state.items.find((i: any) => i.id === 'new');
    expect(dup.status).toBe('CANCELLED');
    expect(dup.metadata.duplicateOf).toBe('old');
    expect(dup.metadata.selfPruneNotice.owed, 'announced and cleared').toBe(false);
    expect(mocks.state.items.find((i: any) => i.id === 'old').status).toBe('NEW');
  });

  it('two owners in one sweep each get their own notice, under their own tenant', async () => {
    mocks.state.tenants = ['tenant-1', 'tenant-2'];
    mocks.state.items = [
      staleItem({ id: 'a1', title: '[smoke] harness residue alpha', createdAt: daysAgo(2), updatedAt: daysAgo(2) }),
      staleItem({
        id: 'b1', title: '[smoke] harness residue beta', userId: 9,
        clientNumber: 'tenant-2', createdAt: daysAgo(2), updatedAt: daysAgo(2), sourceRef: 'ref-9',
      }),
    ];

    const stats = await runOpenItemsBacklogCleanupForAllTenants();

    expect(stats.archivedSmoke).toBe(2);
    expect(stats.noticesEnqueued).toBe(2);
    const tenants = mocks.state.prompts.map((p: any) => [p.userId, p.clientNumber]);
    expect(tenants).toContainEqual([7, 'tenant-1']);
    expect(tenants).toContainEqual([9, 'tenant-2']);
    assertAllWritesGuarded();
  });

  it('DEF-191 — the dispatcher is OFF by default: withdrawals archive with their debt recorded, and NOTHING is announced', async () => {
    mocks.getBehaviorValue.mockResolvedValue(0); // the registry default
    mocks.state.items = [staleItem({ metadata: quarantinedStaleMeta(8) })];

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.archivedStale, 'the archive side is untouched by the gate').toBe(1);
    const row = mocks.state.items[0];
    expect(row.status).toBe('CANCELLED');
    expect(row.metadata.selfPruneNotice.owed, 'the debt is durable, waiting for the gate').toBe(true);
    expect(mocks.state.batches, 'no outbox batch while the owner has not opted in').toHaveLength(0);
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
    expect(mocks.getBehaviorValue).toHaveBeenCalledWith(
      'selfpruning.withdrawal_notice_enabled', { clientNumber: 'tenant-1' });
  });

  it('DEF-191 — an unreachable behavior config reads as OFF: when opt-in cannot be known, nothing is announced', async () => {
    mocks.getBehaviorValue.mockRejectedValue(new Error('config db down'));
    mocks.state.items = [archivedOwedItem()];

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.noticesEnqueued).toBe(0);
    expect(mocks.state.batches).toHaveLength(0);
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
  });

  it('a run that withdraws nothing enqueues nothing and mints no batch', async () => {
    mocks.state.items = [staleItem({ createdAt: daysAgo(2), updatedAt: daysAgo(2) })];

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.noticesEnqueued).toBe(0);
    expect(mocks.state.batches).toHaveLength(0);
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
  });
});

/**
 * DEF-202 — Codex iteration-4 HIGH 2 and HIGH 3, on the source.
 *
 * HIGH 2: "a sent batch permanently consumes an item ID and erases a later
 * withdrawal event … the old sent batch still places A in `claimed`, no new
 * batch is created, and `clearOwedFlags` clears the new `owed:true` as if it
 * belonged to the old event."
 *
 * HIGH 3: "two workers pass the read before either creates … create different
 * random dedup keys, and can enqueue two notices. The migration's only
 * uniqueness constraint is on random `dedup_key`, not on membership/event
 * identity."
 *
 * Both were regressions I introduced in DEF-190 by moving identity off the row
 * and onto an item-keyed batch. These read the committed source, with comments
 * stripped, because the guard must read code and not prose about it (DEF-195).
 */
describe('DEF-202 — identity belongs to the withdrawal EVENT, not to the item', () => {
  const code = (() => {
    const raw = fs.readFileSync(
      path.resolve(__dirname, '..', 'src/jobs/openItemsBacklogCleanupJob.ts'), 'utf8');
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  })();

  it('mints a fresh event token every time a withdrawal debt is recorded', () => {
    expect(code).toMatch(/function owedNotice\([^)]*\)/);
    expect(code).toMatch(/eventToken: randomUUID\(\)/);
    // ONE implementation. Five inline copies of the stamp would be
    // protection-with-two-implementations on the field that IS the identity.
    expect((code.match(/eventToken: randomUUID\(\)/g) ?? []).length).toBe(1);
    expect((code.match(/selfPruneNotice: owedNotice\(/g) ?? []).length).toBe(5);
  });

  it('claims batch membership by EVENT TOKEN, never by item id', () => {
    // Mutation: reverting to itemIdsOf here restores HIGH 2 — a re-withdrawn
    // item stays claimed by the old sent batch and is never announced again.
    expect(code).toMatch(/const claimed = new Set\(batches\.flatMap\(\(b\) => eventTokensOf\(b\)\)\)/);
    expect(code).not.toMatch(/const claimed = new Set\(batches\.flatMap\(\(b\) => itemIdsOf\(b\)\)\)/);
  });

  it('derives the dedup identity FROM the membership, so the unique index owns the event', () => {
    // HIGH 3: a random key cannot collide, so two creators both insert. A key
    // derived from the sorted member tokens makes the EXISTING unique index the
    // ownership constraint.
    expect(code).toMatch(/update\(tokens\.join\('\|'\)\)/);
    expect(code).not.toMatch(/update\(batchId\)/);
    // And the loser of the race must treat the collision as success, not error.
    expect(code).toMatch(/unique\|duplicate key/);
  });

  it('clears ONLY the event the batch claimed, so a later withdrawal survives', () => {
    expect(code).toMatch(/if \(owned\.size > 0 && !owned\.has\(key\)\)/);
    expect(code).toMatch(/eventTokenOf\(fresh\.metadata\)/);
    // Every path that CLAIMS or CLEARS hands the batch's own tokens down.
    // DEF-208 added the third: settleBatch now derives its owned-event set
    // inside the transaction, so the in-transaction claim filters on the same
    // identity the clear does.
    expect((code.match(/eventTokensOf\(batch\)/g) ?? []).length).toBe(3);
  });

  it('a pre-DEF-202 batch claims no event, so existing debt is not stranded', () => {
    // Nullable column + legacy fallback: the changeover must neither lose debt
    // nor announce it twice.
    expect(code).toMatch(/Array\.isArray\(batch\.eventTokens\)/);
    expect(code).toMatch(/`legacy:\$\{/);
  });

  it('the migration is additive and idempotent', () => {
    const sql = fs.readFileSync(path.resolve(
      __dirname, '..', 'prisma/migrations/20260817_self_prune_notice_event_tokens/migration.sql'), 'utf8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS event_tokens JSONB/);
    // Never destructive: hand-written idempotent migrations only (CLAUDE.md).
    expect(sql).not.toMatch(/DROP|DELETE|TRUNCATE|ALTER COLUMN/i);
  });

  it('the schema field is nullable, matching the migration', () => {
    const schema = fs.readFileSync(path.resolve(__dirname, '..', 'prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/eventTokens\s+Json\?\s+@map\("event_tokens"\)/);
  });
});

/**
 * DEF-208 — the announcement and the fact it asserts commit together.
 *
 * Codex said the same thing about iteration 3 and iteration 4, and he was right
 * both times: "the pre-send check is another guard above an asynchronous gap …
 * the owner restores the item while `brainPromptQueue.findFirst` or the imports
 * are pending, then enqueue runs; result = Brain tells the owner A withdrew
 * although it is active."
 *
 * The barrier below is placed where he asked for it — after the FINAL
 * revalidation and before the queue insertion — and it is inside the
 * transaction, which is the only place that window exists any more.
 */
describe('DEF-208 — a restore during the send window yields no withdrawal notice', () => {
  it('the item restored AFTER the final revalidation is never announced', async () => {
    mocks.state.items = [archivedOwedItem({ id: 'a1', title: 'Old vendor digest' })];
    // THE BARRIER: the owner restores it in the gap the old code awaited across.
    mocks.state.afterTxItemRead = (st: any) => {
      st.items[0].status = 'TRIAGED';
    };

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(mocks.state.prompts, 'no queued withdrawal fact').toHaveLength(0);
    expect(stats.noticesEnqueued).toBe(0);
    expect(mocks.state.batches[0].state, 'the batch cancels rather than sends').toBe('cancelled');
    expect(mocks.state.items[0].metadata.selfPruneNotice.announcedAt).toBeUndefined();
    // The debt survives: a restored item owes nothing NOW, but the flag is not
    // silently cleared by a notice that never went out.
    expect(mocks.state.items[0].metadata.selfPruneNotice.owed).toBe(true);
  });

  it('one member restored in the window is dropped; the others are still announced with the corrected count', async () => {
    mocks.state.items = [
      archivedOwedItem({ id: 'a1', title: 'Old vendor digest', sourceRef: 'r1' }),
      archivedOwedItem({ id: 'b1', title: 'Old newsletter sweep', sourceRef: 'r2' }),
    ];
    mocks.state.afterTxItemRead = (st: any) => {
      st.items.find((i: any) => i.id === 'b1').status = 'TRIAGED';
    };

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(stats.noticesEnqueued).toBe(1);
    expect(mocks.state.prompts).toHaveLength(1);
    // The count the owner reads is the count that survived the claim, not the
    // count the batch was formed with.
    const q = String(mocks.state.prompts[0].question);
    expect(q).toContain('"Old vendor digest"');
    expect(q).not.toContain('Old newsletter sweep');
    expect(mocks.state.prompts[0].metadata.selfPruneNotice.count).toBe(1);
    expect(mocks.state.prompts[0].metadata.selfPruneNotice.itemIds).toEqual(['a1']);
    // The restored row keeps its debt — it was never part of what was said.
    const b1 = mocks.state.items.find((i: any) => i.id === 'b1');
    expect(b1.metadata.selfPruneNotice.owed).toBe(true);
  });

  it('the claim is a compare-and-set on the item, not a read: it carries tenant, user, id, status AND the version token', async () => {
    mocks.state.items = [archivedOwedItem({ id: 'a1' })];
    await runOpenItemsBacklogCleanup('tenant-1');

    const claim = mocks.updateMany.mock.calls
      .map(([a]: any[]) => a)
      .find((a: any) => a.data?.metadata?.selfPruneNotice?.announcedAt);
    expect(claim, 'no claim write was issued').toBeDefined();
    expect(claim.where.clientNumber).toBe('tenant-1');
    expect(claim.where.userId).toBeDefined();
    expect(claim.where.id).toBe('a1');
    expect(claim.where.status).toBe('CANCELLED');
    expect(claim.where.updatedAt, 'without the version token this is a guard, not a CAS').toBeDefined();
  });

  it('the queue insert runs on the caller transaction, so it cannot commit without the claim', async () => {
    mocks.state.items = [archivedOwedItem({ id: 'a1' })];
    await runOpenItemsBacklogCleanup('tenant-1');

    expect(mocks.enqueueBrainPrompt).toHaveBeenCalledTimes(1);
    const input = mocks.enqueueBrainPrompt.mock.calls[0][0];
    expect(input.tx, 'the enqueue was not handed the transaction').toBeDefined();
    expect(input.dedupKey).toMatch(/^selfpruning_withdrawn:/);
  });

  it('a failing enqueue announces nothing and leaves the identity to the retry', async () => {
    mocks.state.items = [archivedOwedItem({ id: 'a1' })];
    mocks.state.enqueueFailNext = 1;

    const first = await runOpenItemsBacklogCleanup('tenant-1');
    expect(first.noticesEnqueued).toBe(0);
    expect(mocks.state.batches[0].state, 'still pending under the same dedup key').toBe('pending');
    expect(mocks.state.items[0].metadata.selfPruneNotice.announcedAt,
      'the claim rolled back with the failed insert').toBeUndefined();

    const second = await runOpenItemsBacklogCleanup('tenant-1');
    expect(second.noticesEnqueued).toBe(1);
    expect(mocks.state.prompts, 'exactly one message across both attempts').toHaveLength(1);
  });

  it('a sent-mark that matches NOTHING rolls back too — a count of 0 is a failure, not a note', async () => {
    mocks.state.items = [archivedOwedItem({ id: 'a1' })];
    mocks.state.batchMarkZeroNext = 1;

    const first = await runOpenItemsBacklogCleanup('tenant-1');

    // Someone else moved the batch out of pending. Committing the announcement
    // anyway would leave an owner-visible message the outbox has no record of
    // making — the exact split-brain the outbox exists to prevent.
    expect(mocks.state.prompts, 'nothing announced').toHaveLength(0);
    expect(first.noticesEnqueued).toBe(0);
    expect(first.errors, 'counted, not swallowed').toBeGreaterThan(0);
    expect(mocks.state.items[0].metadata.selfPruneNotice.announcedAt).toBeUndefined();
    expect(mocks.state.items[0].metadata.selfPruneNotice.owed).toBe(true);
  });

  it('a cancel-mark that matches nothing is a failure too — the batch is never left silently settled', async () => {
    mocks.state.items = [archivedOwedItem({ id: 'a1' })];
    mocks.state.afterTxItemRead = (st: any) => { st.items[0].status = 'TRIAGED'; };
    mocks.state.batchCancelZeroNext = 1;

    const stats = await runOpenItemsBacklogCleanup('tenant-1');

    expect(mocks.state.prompts).toHaveLength(0);
    expect(stats.errors, 'a cancel nobody applied must not read as success').toBeGreaterThan(0);
    expect(mocks.state.batches[0].state, 'still pending — the next tick decides again').toBe('pending');
  });

  it('pages PAST claimed rows: a permanently failing clear in the first page cannot starve row 201', async () => {
    // Codex iteration-4 MEDIUM 4, reproduced at the size it needs: 200 owed rows
    // already claimed by a SENT batch whose clears keep failing, and one newer
    // unclaimed row behind them.
    const stuck = Array.from({ length: 200 }, (_, i) =>
      archivedOwedItem({
        id: `s${i}`, title: `Stuck ${i}`, sourceRef: `sr${i}`,
        createdAt: new Date(2020, 0, 1 + i),
        metadata: {
          archivedReason: 'stale_no_engagement',
          selfPruneNotice: { owed: true, reason: 'stale_no_engagement', eventToken: `tok-${i}` },
        },
      }));
    const newer = archivedOwedItem({
      id: 'new1', title: 'Newer debt', sourceRef: 'srN',
      createdAt: new Date(2026, 0, 1),
      metadata: {
        archivedReason: 'stale_no_engagement',
        selfPruneNotice: { owed: true, reason: 'stale_no_engagement', eventToken: 'tok-new' },
      },
    });
    mocks.state.items = [...stuck, newer];
    mocks.state.batches = [{
      id: 'b-old', clientNumber: 'tenant-1', userId: stuck[0].userId,
      batchId: 'old-batch', dedupKey: 'selfpruning_withdrawn:old',
      itemIds: stuck.map((s: any) => s.id),
      eventTokens: stuck.map((_: any, i: number) => `tok-${i}`),
      titles: [], count: 200, state: 'sent', createdAt: new Date(2020, 0, 1),
    }];
    // Their clears never succeed, so they stay owed at the head of the query.
    for (const s of stuck) mocks.state.failOwedMarkIds.add(s.id);

    await runOpenItemsBacklogCleanup('tenant-1');

    const created = mocks.state.batches.find((b: any) => b.batchId !== 'old-batch');
    expect(created, 'the newer debt never got a batch — starved behind claimed rows').toBeDefined();
    expect(created.itemIds).toEqual(['new1']);
    expect(mocks.state.prompts).toHaveLength(1);
  });

  it('module resolution happens BEFORE the transaction opens — a dynamic import must not hold it', () => {
    const raw = fs.readFileSync(
      path.resolve(__dirname, '..', 'src/jobs/openItemsBacklogCleanupJob.ts'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const body = code.slice(code.indexOf('async function settleBatch'));
    const txAt = body.indexOf('prisma.$transaction');
    expect(txAt).toBeGreaterThan(0);
    expect(body.slice(0, txAt), 'both imports resolve first').toContain('enqueueBrainPrompt }');
    expect(body.slice(txAt), 'no await import() inside the boundary').not.toMatch(/await import\(/);
  });
});

/**
 * DEF-210 — Codex iteration-4 HIGH 3, closed with the test he named.
 *
 * His finding: *"overlapping cleanup invocations select the same unclaimed owed
 * row before either insert commits; result = two batches with different
 * UUID-derived dedup keys both satisfy the database constraints and both
 * enqueue. The migration's only uniqueness constraint is on random `dedup_key`,
 * not on membership/event identity."*
 *
 * His directive: *"Test two simultaneous dispatchers with the same owed event and
 * prove exactly one batch/dedup identity and one queue row."*
 *
 * That was true of the FIRST outbox, whose dedup key was a fresh `randomUUID()`
 * — two creators, two keys, no collision, two notices. DEF-202 replaced it with
 * a key DERIVED from the sorted member event tokens
 * (`sha256(tokens.join('|'))`), which turns the existing unique index into the
 * ownership constraint Codex asked for: same membership, same key, second writer
 * collides. The claim was made in DEF-202's row and never demonstrated. It is
 * demonstrated here, against a mock that enforces the real index.
 */
describe('DEF-210 — two dispatchers, one owed event', () => {
  it('produces exactly ONE batch, ONE dedup identity and ONE queue row', async () => {
    mocks.state.items = [
      archivedOwedItem({ id: 'a1', title: 'Old vendor digest', sourceRef: 'r1' }),
      archivedOwedItem({ id: 'b1', title: 'Old newsletter sweep', sourceRef: 'r2' }),
    ];

    // Genuinely overlapping: both start before either has created anything, so
    // both see the same rows as unclaimed. This is Codex's exact input.
    const [, ] = await Promise.all([
      runOpenItemsBacklogCleanup('tenant-1'),
      runOpenItemsBacklogCleanup('tenant-1'),
    ]);

    expect(mocks.state.batches, 'the loser collided on the unique index').toHaveLength(1);
    expect(mocks.state.prompts, 'the owner was told once').toHaveLength(1);
  });

  it('the dedup key is DERIVED from the member events, so both creators compute the same one', async () => {
    // Two separate runs over the SAME membership must agree on the identity —
    // that is the property a random UUID could never have. The first run creates
    // it; the second recomputes the identical key and is refused by the index.
    mocks.state.items = [archivedOwedItem({ id: 'a1' })];
    await runOpenItemsBacklogCleanup('tenant-1');
    const firstKey = mocks.state.batches[0].dedupKey;
    expect(firstKey).toMatch(/^selfpruning_withdrawn:[0-9a-f]{32}$/);

    // Re-arm the same debt under the same event token and run again.
    mocks.state.batches = [];
    mocks.state.items[0].metadata.selfPruneNotice.owed = true;
    delete mocks.state.items[0].metadata.selfPruneNotice.announcedAt;
    await runOpenItemsBacklogCleanup('tenant-1');

    expect(mocks.state.batches[0].dedupKey, 'same membership, same identity').toBe(firstKey);
  });

  it('a DIFFERENT withdrawal event gets a different identity — the constraint must not block real work', async () => {
    mocks.state.items = [archivedOwedItem({ id: 'a1' })];
    await runOpenItemsBacklogCleanup('tenant-1');
    const firstKey = mocks.state.batches[0].dedupKey;

    // The item is restored and later withdrawn again: a NEW event token, so a
    // new identity (DEF-202). If the key were membership-by-item-id, this second
    // withdrawal would collide and never be announced.
    mocks.state.batches = [];
    mocks.state.items[0].metadata.selfPruneNotice = {
      owed: true, reason: 'stale_no_engagement', eventToken: 'a-second-event',
    };
    await runOpenItemsBacklogCleanup('tenant-1');

    expect(mocks.state.batches).toHaveLength(1);
    expect(mocks.state.batches[0].dedupKey).not.toBe(firstKey);
  });

  it('the key is computed from the SORTED tokens, so member ordering cannot split one event in two', () => {
    const raw = fs.readFileSync(
      path.resolve(__dirname, '..', 'src/jobs/openItemsBacklogCleanupJob.ts'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toMatch(/const tokens = fresh\.map\([\s\S]{0,80}?\)\.sort\(\)/);
    expect(code).toMatch(/createHash\('sha256'\)\.update\(tokens\.join\('\|'\)\)/);
    expect(code, 'a random identity would give two creators two keys')
      .not.toMatch(/dedupKey = `selfpruning_withdrawn:\$\{randomUUID/);
  });
});
