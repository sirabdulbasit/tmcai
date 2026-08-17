/**
 * DEF-186 / DEF-187 / DEF-188 — C-3 increment 3: junk withdraws itself, the
 * owner is told once, and the telling can be neither false nor lost.
 *
 * Three surfaces, one chain:
 *
 *   1. `zombieItemPolicy` — 'stale_no_engagement' joins the SAME reversible
 *      quarantine → grace → soft-close lifecycle as malformed residue, with
 *      the ONE engagement definition (`hasEngagementEvidence`).
 *   2. `renderSelfPruneNotice` ↔ `curatedMarkerMeaning` — the withdrawal
 *      notice is the sanctioned form: a provenance-stamped marker with a JSON
 *      payload (the field boundary, DEF-175), whose parser REJECTS what the
 *      constructor cannot have produced (DEF-176's clamp/reject split).
 *   3. `runOpenItemsBacklogCleanup` — Codex iteration-1 findings (DEF-187/188):
 *      every mutation is (id, clientNumber, userId)-constrained updateMany
 *      whose count is checked (fail closed — a failed write is an error, never
 *      a withdrawal); the archiving write itself records `selfPruneNotice.owed`
 *      so the notice is durable; a dispatcher announces owed rows per
 *      (tenant, user) and clears the debt only on queue acceptance; the
 *      owner's staleThresholdDays=0 disable passes through end to end; and
 *      selection/dedup/settings are partitioned per tenant.
 *
 * The prisma mock honours EVERY stated filter (tenant, user, status, JSON
 * path) against an in-memory table — dropping `clientNumber` from any query
 * or write in the job turns these tests red, which is the DEF-175 mock
 * principle.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    items: [] as any[],
    /** updateMany targeting one of these ids throws — a rejected write. */
    failUpdateIds: new Set<string>(),
    /** updateMany cannot see these ids — a row that moved: count 0. */
    vanishIds: new Set<string>(),
  };

  function matches(item: any, where: any): boolean {
    if (!where) return true;
    if (where.id !== undefined && item.id !== where.id) return false;
    if (where.clientNumber !== undefined && item.clientNumber !== where.clientNumber) return false;
    if (where.userId !== undefined && item.userId !== where.userId) return false;
    if (where.status?.in && !where.status.in.includes(item.status)) return false;
    if (where.priority?.not !== undefined && item.priority === where.priority.not) return false;
    if (where.metadata?.path) {
      const [a, b] = where.metadata.path;
      if (item.metadata?.[a]?.[b] !== where.metadata.equals) return false;
    }
    return true;
  }

  const findMany = vi.fn(async (args: any) => {
    let rows = state.items.filter((i) => matches(i, args?.where));
    if (args?.orderBy?.createdAt === 'asc') {
      rows = [...rows].sort((x, y) => +new Date(x.createdAt) - +new Date(y.createdAt));
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
    if (args?.take) rows = rows.slice(0, args.take);
    return rows.map((r) => ({ ...r }));
  });

  const updateMany = vi.fn(async (args: any) => {
    const targets = state.items.filter(
      (i) => matches(i, args?.where) && !state.vanishIds.has(i.id),
    );
    if (targets.some((t) => state.failUpdateIds.has(t.id))) {
      throw new Error('update rejected (test)');
    }
    for (const t of targets) {
      if (args.data.status !== undefined) t.status = args.data.status;
      if (args.data.metadata !== undefined) t.metadata = args.data.metadata;
    }
    return { count: targets.length };
  });

  return {
    state,
    findMany,
    updateMany,
    getOpenItemsSettings: vi.fn(),
    enqueueBrainPrompt: vi.fn(),
  };
});

vi.mock('../src/db/prisma', () => ({
  default: {
    openItem: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
    },
  },
}));

vi.mock('../src/services/openItems/openItemsSettings', () => ({
  getOpenItemsSettings: mocks.getOpenItemsSettings,
}));

vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  enqueueBrainPrompt: mocks.enqueueBrainPrompt,
}));

vi.mock('../src/utils/logger', () => ({
  default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { runOpenItemsBacklogCleanup } from '../src/jobs/openItemsBacklogCleanupJob';
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

/** Every updateMany the job issued must be tenant+user+id constrained. */
function assertAllWritesTenantScoped() {
  expect(mocks.updateMany.mock.calls.length).toBeGreaterThan(0);
  for (const [args] of mocks.updateMany.mock.calls) {
    expect(args.where.id, JSON.stringify(args.where)).toBeDefined();
    expect(args.where.clientNumber, JSON.stringify(args.where)).toBeDefined();
    expect(args.where.userId, JSON.stringify(args.where)).toBeDefined();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.items = [];
  mocks.state.failUpdateIds.clear();
  mocks.state.vanishIds.clear();
  mocks.getOpenItemsSettings.mockResolvedValue({ staleThresholdDays: 30 });
  mocks.enqueueBrainPrompt.mockResolvedValue({ status: 'queued', promptId: 'p1' });
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

describe('DEF-187/DEF-188 — the cleanup job: fail-closed writes, durable notice, tenant partition', () => {
  it('first sighting quarantines — tenant-scoped write, no status change, no notice', async () => {
    mocks.state.items = [staleItem()];

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.quarantinedStale).toBe(1);
    expect(stats.archivedStale).toBe(0);
    const row = mocks.state.items[0];
    expect(row.status, 'quarantine never touches status').toBe('NEW');
    expect(row.metadata.selfPrune.state).toBe('quarantined');
    expect(row.metadata.selfPrune.reason).toBe('stale_no_engagement');
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
    assertAllWritesTenantScoped();
    expect(mocks.getOpenItemsSettings).toHaveBeenCalledWith(7, 'tenant-1');
  });

  it('after the grace period: confirmed soft-close records the owed notice IN the archiving write, and the same tick announces and clears it', async () => {
    mocks.state.items = [staleItem({ metadata: quarantinedStaleMeta(8) })];

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.archivedStale).toBe(1);
    const row = mocks.state.items[0];
    expect(row.status).toBe('CANCELLED');
    expect(row.metadata.archivedReason).toBe('stale_no_engagement');
    expect(row.metadata.selfPrune.state).toBe('archived');
    expect(row.metadata.inactivationReason).toContain('quarantine');
    expect(row.metadata.selfPruneNotice.owed, 'debt recorded then cleared on acceptance').toBe(false);
    expect(row.metadata.selfPruneNotice.enqueueStatus).toBe('queued');

    expect(stats.noticesEnqueued).toBe(1);
    expect(mocks.enqueueBrainPrompt).toHaveBeenCalledTimes(1);
    const enq = mocks.enqueueBrainPrompt.mock.calls[0][0];
    expect(enq.clientNumber, 'the tenant is declared, not inferred').toBe('tenant-1');
    expect(enq.userId).toBe(7);
    expect(enq.expectsReply, 'a notice never holds the conversation lock').toBe(false);
    expect(enq.provenance).toBe('system_marker');
    expect(enq.dedupKey).toMatch(/^selfpruning_withdrawn:/);
    const curated = curatedMarkerMeaning(stripMarkerEnvelope(enq.question));
    expect(curated, 'the enqueued question is the sanctioned marker with a vetted meaning').not.toBeNull();
    expect(curated!).toContain('1 open item withdrew');
    expect(curated!).toContain('"Prepare Q2 hiring plan for the Lahore office"');
    assertAllWritesTenantScoped();
  });

  it('a REJECTED archive write is an error, not a withdrawal — no stat, no owed state, no notice (Codex CRITICAL)', async () => {
    mocks.state.items = [staleItem({ metadata: quarantinedStaleMeta(8) })];
    mocks.state.failUpdateIds.add('item-stale-1');

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.archivedStale).toBe(0);
    expect(stats.errors).toBeGreaterThanOrEqual(1);
    const row = mocks.state.items[0];
    expect(row.status, 'the item is still active').toBe('NEW');
    expect(row.metadata.selfPruneNotice).toBeUndefined();
    expect(mocks.enqueueBrainPrompt, 'no false notice').not.toHaveBeenCalled();
  });

  it('a ZERO-ROW write (row moved under us) is equally not a withdrawal', async () => {
    mocks.state.items = [staleItem({ metadata: quarantinedStaleMeta(8) })];
    mocks.state.vanishIds.add('item-stale-1');

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.archivedStale).toBe(0);
    expect(stats.errors).toBeGreaterThanOrEqual(1);
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
  });

  it('a transient enqueue failure keeps the debt durable; the next tick delivers exactly once (Codex HIGH)', async () => {
    mocks.state.items = [staleItem({ metadata: quarantinedStaleMeta(8) })];
    mocks.enqueueBrainPrompt.mockRejectedValueOnce(new Error('queue down'));

    // Tick 1: archive commits, enqueue fails, debt survives on the row.
    const first = await runOpenItemsBacklogCleanup();
    expect(first.archivedStale).toBe(1);
    expect(first.noticesEnqueued).toBe(0);
    expect(first.errors).toBeGreaterThanOrEqual(1);
    const row = mocks.state.items[0];
    expect(row.status).toBe('CANCELLED');
    expect(row.metadata.selfPruneNotice.owed, 'the debt is discoverable next tick').toBe(true);

    // Tick 2: the row is CANCELLED and gone from the candidate set, but the
    // dispatcher finds it by its owed state and delivers.
    const second = await runOpenItemsBacklogCleanup();
    expect(second.noticesEnqueued).toBe(1);
    expect(row.metadata.selfPruneNotice.owed).toBe(false);
    const successfulSends = mocks.enqueueBrainPrompt.mock.settledResults
      .filter((r) => r.type === 'fulfilled');
    expect(successfulSends).toHaveLength(1);

    // Tick 3: nothing owed, nothing sent — exactly once overall.
    const third = await runOpenItemsBacklogCleanup();
    expect(third.noticesEnqueued).toBe(0);
    expect(mocks.enqueueBrainPrompt).toHaveBeenCalledTimes(2); // 1 failed + 1 delivered
  });

  it('staleThresholdDays=0 is the owner’s DISABLE, honored end to end: a stale quarantine recovers and nothing is cancelled or announced (Codex HIGH)', async () => {
    mocks.getOpenItemsSettings.mockResolvedValue({ staleThresholdDays: 0 });
    mocks.state.items = [
      staleItem({ id: 'q1', metadata: quarantinedStaleMeta(8) }), // would have archived under 30
      staleItem({ id: 'f1', sourceRef: 'ref-2', title: 'Draft the Karachi expansion memo' }),
    ];

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.recoveredZombie).toBe(1);
    expect(stats.quarantinedStale).toBe(0);
    expect(stats.archivedStale).toBe(0);
    const q1 = mocks.state.items.find((i: any) => i.id === 'q1');
    expect(q1.status).toBe('NEW');
    expect(q1.metadata.selfPrune.state).toBe('recovered');
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
  });

  it('an unreadable setting means HOLD: no new stale quarantine, and no release of an existing one', async () => {
    mocks.getOpenItemsSettings.mockRejectedValue(new Error('settings db down'));
    mocks.state.items = [
      staleItem({ id: 'q1', metadata: quarantinedStaleMeta(8) }),
      staleItem({ id: 'f1', sourceRef: 'ref-2', title: 'Draft the Karachi expansion memo' }),
    ];

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.quarantinedStale).toBe(0);
    expect(stats.archivedStale).toBe(0);
    expect(stats.recoveredZombie).toBe(0);
    expect(mocks.state.items.find((i: any) => i.id === 'q1').metadata.selfPrune.state)
      .toBe('quarantined');
  });

  it('duplicates never collapse across tenants — the maps live inside the partition (Codex carried CRITICAL)', async () => {
    mocks.state.items = [
      staleItem({ id: 'a1', createdAt: daysAgo(2), title: 'Approve the Sialkot supplier contract' }),
      staleItem({
        id: 'b1', createdAt: daysAgo(1), clientNumber: 'tenant-2',
        title: 'Approve the Multan supplier contract',
      }), // same userId 7, same (sourceFeed, sourceRef) — different tenant
    ];

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.archivedDuplicate, 'each tenant keeps its own row').toBe(0);
    expect(mocks.state.items.every((i: any) => i.status === 'NEW')).toBe(true);
    expect(mocks.getOpenItemsSettings).toHaveBeenCalledWith(7, 'tenant-1');
    expect(mocks.getOpenItemsSettings).toHaveBeenCalledWith(7, 'tenant-2');
  });

  it('duplicates inside one tenant still collapse to the oldest keeper', async () => {
    mocks.state.items = [
      staleItem({ id: 'old', createdAt: daysAgo(3), title: 'Approve the Sialkot supplier contract' }),
      staleItem({ id: 'new', createdAt: daysAgo(1), title: 'Review the Gwadar port schedule' }),
    ]; // same tenant, same (sourceFeed, sourceRef)

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.archivedDuplicate).toBe(1);
    const dup = mocks.state.items.find((i: any) => i.id === 'new');
    expect(dup.status).toBe('CANCELLED');
    expect(dup.metadata.duplicateOf).toBe('old');
    expect(dup.metadata.selfPruneNotice.owed, 'announced and cleared').toBe(false);
    expect(mocks.state.items.find((i: any) => i.id === 'old').status).toBe('NEW');
  });

  it('two owners in one run each get their own notice, under their own tenant', async () => {
    mocks.state.items = [
      staleItem({ id: 'a1', title: '[smoke] harness residue alpha', createdAt: daysAgo(2) }),
      staleItem({
        id: 'b1', title: '[smoke] harness residue beta', userId: 9,
        clientNumber: 'tenant-2', createdAt: daysAgo(2), sourceRef: 'ref-9',
      }),
    ];

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.archivedSmoke).toBe(2);
    expect(stats.noticesEnqueued).toBe(2);
    const tenants = mocks.enqueueBrainPrompt.mock.calls.map((c: any[]) => [c[0].userId, c[0].clientNumber]);
    expect(tenants).toContainEqual([7, 'tenant-1']);
    expect(tenants).toContainEqual([9, 'tenant-2']);
    assertAllWritesTenantScoped();
  });

  it('a run that withdraws nothing enqueues nothing', async () => {
    mocks.state.items = [staleItem({ createdAt: daysAgo(2), updatedAt: daysAgo(2) })];

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.noticesEnqueued).toBe(0);
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
  });
});
