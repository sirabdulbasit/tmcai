/**
 * DEF-186 — C-3 increment 3: junk withdraws itself, and the owner is told once.
 *
 * Three surfaces, one chain:
 *
 *   1. `zombieItemPolicy` — 'stale_no_engagement' joins the SAME reversible
 *      quarantine → grace → soft-close lifecycle as malformed residue. The
 *      engagement definition is `hasEngagementEvidence`, once, in the policy —
 *      the cleanup job's former private definition (notes+delegation only)
 *      was the protection-with-two-implementations shape.
 *   2. `renderSelfPruneNotice` ↔ `curatedMarkerMeaning` — the withdrawal
 *      notice is the sanctioned form: a provenance-stamped marker with a JSON
 *      payload (the field boundary, DEF-175), whose parser REJECTS what the
 *      constructor cannot have produced (DEF-176's clamp/reject split).
 *   3. `runOpenItemsBacklogCleanup` — stale items are quarantined first and
 *      archived only after the grace period, with the audit block on the row;
 *      a run that withdrew anything enqueues exactly ONE notice per
 *      (user, tenant) through the ordinary prompt queue, tenant declared.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  getOpenItemsSettings: vi.fn(),
  enqueueBrainPrompt: vi.fn(),
}));

vi.mock('../src/db/prisma', () => ({
  default: {
    openItem: {
      findMany: mocks.findMany,
      update: mocks.update,
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({});
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
    // The draft-ask job calls planZombieLifecycle(item, now) with no window;
    // a stale-quarantined item looks healthy to it by construction.
    const plan = planZombieLifecycle(staleItem({ metadata: quarantinedStaleMeta(8) }), new Date());
    expect(plan.action).toBe('none');
  });

  it('disabling the stale sweep releases an existing stale quarantine', () => {
    const plan = planZombieLifecycle(
      staleItem({ metadata: quarantinedStaleMeta(8) }), new Date(), undefined, { staleAfterDays: 0 });
    expect(plan.action).toBe('recover');
  });
});

describe('DEF-186 — the cleanup job: quarantine, soft-close after grace, one notice per owner', () => {
  it('first sighting quarantines — no status change, no notice', async () => {
    mocks.findMany.mockResolvedValue([staleItem()]);

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.quarantinedStale).toBe(1);
    expect(stats.archivedStale).toBe(0);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.status, 'quarantine never touches status').toBeUndefined();
    expect(data.metadata.selfPrune.state).toBe('quarantined');
    expect(data.metadata.selfPrune.reason).toBe('stale_no_engagement');
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
  });

  it('after the grace period the item soft-closes with its audit block, and the owner is told once', async () => {
    mocks.findMany.mockResolvedValue([staleItem({ metadata: quarantinedStaleMeta(8) })]);

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.archivedStale).toBe(1);
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.status).toBe('CANCELLED');
    expect(data.metadata.archivedReason).toBe('stale_no_engagement');
    expect(data.metadata.selfPrune.state).toBe('archived');
    expect(data.metadata.inactivationReason).toContain('quarantine');

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
  });

  it('engagement during quarantine recovers on the row and announces nothing', async () => {
    mocks.findMany.mockResolvedValue([
      staleItem({ metadata: quarantinedStaleMeta(8), dueDate: daysAgo(1) }),
    ]);

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.recoveredZombie).toBe(1);
    expect(stats.archivedStale).toBe(0);
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.status).toBeUndefined();
    expect(data.metadata.selfPrune.state).toBe('recovered');
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
  });

  it('a run that withdraws nothing enqueues nothing', async () => {
    mocks.findMany.mockResolvedValue([staleItem({ createdAt: daysAgo(2), updatedAt: daysAgo(2) })]);

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.noticesEnqueued).toBe(0);
    expect(mocks.enqueueBrainPrompt).not.toHaveBeenCalled();
  });

  it('two owners in one run each get their own notice, under their own tenant', async () => {
    // Young enough that the stale path stays out of the way — these reach the
    // smoke branch, which archives immediately.
    mocks.findMany.mockResolvedValue([
      staleItem({ id: 'a1', title: '[smoke] harness residue alpha', userId: 7, clientNumber: 'tenant-1', createdAt: daysAgo(2) }),
      staleItem({ id: 'b1', title: '[smoke] harness residue beta', userId: 9, clientNumber: 'tenant-2', createdAt: daysAgo(2) }),
    ]);

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.archivedSmoke).toBe(2);
    expect(stats.noticesEnqueued).toBe(2);
    const tenants = mocks.enqueueBrainPrompt.mock.calls.map((c: any[]) => [c[0].userId, c[0].clientNumber]);
    expect(tenants).toContainEqual([7, 'tenant-1']);
    expect(tenants).toContainEqual([9, 'tenant-2']);
  });

  it('a notice failure never fails the cleanup — the withdrawal itself is already durable', async () => {
    mocks.findMany.mockResolvedValue([staleItem({ metadata: quarantinedStaleMeta(8) })]);
    mocks.enqueueBrainPrompt.mockRejectedValue(new Error('queue down'));

    const stats = await runOpenItemsBacklogCleanup();

    expect(stats.archivedStale).toBe(1);
    expect(stats.noticesEnqueued).toBe(0);
    expect(stats.errors).toBe(1);
  });
});
