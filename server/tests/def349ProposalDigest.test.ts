/**
 * DEF-349 — the pending-proposals digest: the SURFACING half of the Learn loop.
 *
 * DEF-348 generates governed-memory proposals (live-confirmed 10-24: pending
 * 0→2, the first ever), but nothing told the owner they exist — they sat in a
 * Settings tab he never opens, so the human gate was a click that never comes
 * and Learn manifested nothing in practice. Builder, scorer, Codex and the
 * analyst all named this increment.
 *
 * Under test:
 *  - a tenant with NEW pending proposals enqueues ONE digest per affected user
 *    through the one chokepoint, day-keyed dedup, expectsReply false, the
 *    receipt (memoryIds) in metadata, and the marker payload carrying exact
 *    counts + titles;
 *  - the per-tenant cursor is FAIL-CLOSED (held on enqueue failure, advanced
 *    on success or same-day dedup);
 *  - nothing new since the cursor → no enqueue; flag off → nothing;
 *    tenant-scope (userId null) proposals are counted, not mis-addressed;
 *  - the marker round-trip: the rendered payload is accepted by
 *    answerSanitizer's curated meaning, a payload the constructor could not
 *    produce is rejected (null), and the raw marker never reaches prose.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  tenants: [] as Array<{ clientNumber: string }>,
  pendingByTenant: {} as Record<string, any[]>,
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/db/prisma', () => {
  const p: any = {
    governedBrainMemory: {
      groupBy: async () => state.tenants,
      findMany: async (args: any) => state.pendingByTenant[args.where.clientNumber] ?? [],
    },
  };
  return { __esModule: true, default: p, prisma: p };
});

import { runProposalDigest, DIGEST_CURSOR_KEY, MAX_TITLES_PER_DIGEST } from '../src/services/learning/proposalDigest';
import { renderLearnProposalDigest } from '../src/services/notifications/proactiveMessageText';
import { curatedMarkerMeaning } from '../src/services/knowledge/answerSanitizer';
import { stripMarkerEnvelope } from '../src/services/knowledge/systemMarker';

const mem = (id: string, userId: number | null, title: string, at: string) => ({
  id, userId, title, createdAt: new Date(at),
});

function harness(opts: { enqueueStatus?: string | Error; flag?: number; cursor?: string | null } = {}) {
  const enqueued: any[] = [];
  const cursors: Record<string, string> = {};
  return {
    enqueued, cursors,
    deps: {
      enqueue: async (input: any) => {
        if (opts.enqueueStatus instanceof Error) throw opts.enqueueStatus;
        enqueued.push(input);
        return { status: opts.enqueueStatus ?? 'queued' };
      },
      getBehavior: async () => opts.flag ?? 1,
      getConfig: async () => opts.cursor ?? null,
      setConfig: async (c: string, _k: string, v: string) => { cursors[c] = v; },
    },
  };
}

beforeEach(() => { state.tenants = []; state.pendingByTenant = {}; });

describe('DEF-349 — pending proposals reach the owner through the one chokepoint', () => {
  it('new pending proposals → ONE digest per user, day-keyed dedup, receipt in metadata, cursor advanced', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.pendingByTenant['TMC-0001'] = [
      mem('m1', 2, 'Always report amounts in PKR', '2026-10-24T03:00:00Z'),
      mem('m2', 2, 'Prefer WhatsApp over email for urgent items', '2026-10-24T03:05:00Z'),
      mem('m3', 7, 'Weekly summary on Fridays', '2026-10-24T03:10:00Z'),
    ];
    const h = harness();
    const r = await runProposalDigest(h.deps);
    expect(r).toMatchObject({ tenants: 1, usersNotified: 2, duplicates: 0, tenantsFailed: 0 });
    expect(h.enqueued).toHaveLength(2); // one per affected user, never per proposal
    const forUser2 = h.enqueued.find((e) => e.userId === 2);
    expect(forUser2).toMatchObject({
      clientNumber: 'TMC-0001',
      criticality: 'routine',
      expectsReply: false,
      provenance: 'system_marker',
    });
    expect(forUser2.dedupKey).toMatch(/^learn_proposal_digest:2:\d{4}-\d{2}-\d{2}$/);
    expect(forUser2.metadata.memoryIds).toEqual(['m1', 'm2']); // the receipt
    expect(forUser2.metadata.pendingTotal).toBe(2);
    // marker payload carries the exact counts
    const body = stripMarkerEnvelope(forUser2.question);
    expect(body).toContain('"pendingTotal":2');
    expect(body).toContain('"newSinceLast":2');
    // cursor advanced to the newest fresh proposal
    expect(h.cursors['TMC-0001']).toBe(new Date('2026-10-24T03:10:00Z').toISOString());
  });

  it('FAIL-CLOSED: an enqueue failure holds the cursor so the same proposals re-trigger next run', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.pendingByTenant['TMC-0001'] = [mem('m1', 2, 'Rule', '2026-10-24T03:00:00Z')];
    const h = harness({ enqueueStatus: new Error('queue down') });
    const r = await runProposalDigest(h.deps);
    expect(r.tenantsFailed).toBe(1);
    expect(h.cursors).toEqual({}); // never announced-into-the-void and forgotten
  });

  it('same-day duplicate counts as announced (the queue refused a second today) and the cursor still advances', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.pendingByTenant['TMC-0001'] = [mem('m1', 2, 'Rule', '2026-10-24T03:00:00Z')];
    const h = harness({ enqueueStatus: 'duplicate' });
    const r = await runProposalDigest(h.deps);
    expect(r.duplicates).toBe(1);
    expect(r.usersNotified).toBe(0);
    expect(h.cursors['TMC-0001']).toBe(new Date('2026-10-24T03:00:00Z').toISOString());
  });

  it('nothing new since the cursor → no enqueue; flag off → nothing; tenant-scope rows counted, never mis-addressed', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }, { clientNumber: 'TMC-0002' }];
    state.pendingByTenant['TMC-0001'] = [mem('m1', 2, 'Old rule', '2026-10-20T00:00:00Z')];
    state.pendingByTenant['TMC-0002'] = [mem('m2', null, 'Tenant-wide rule', '2026-10-24T03:00:00Z')];
    const h = harness({ cursor: '2026-10-23T00:00:00Z' });
    const r = await runProposalDigest(h.deps);
    expect(r.skippedNoNew).toBe(1);        // TMC-0001: pending but not new
    expect(r.tenantScopeSkipped).toBe(1);  // TMC-0002: no single recipient
    expect(h.enqueued).toHaveLength(0);

    const off = harness({ flag: 0 });
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.pendingByTenant['TMC-0001'] = [mem('m3', 2, 'New rule', '2026-10-24T05:00:00Z')];
    const r2 = await runProposalDigest(off.deps);
    expect(r2.skippedDisabled).toBe(1);
    expect(off.enqueued).toHaveLength(0);
  });

  it('MARKER ROUND-TRIP: the rendered payload yields the curated FACT; an impossible payload is rejected, not repaired', () => {
    const marker = renderLearnProposalDigest({
      pendingTotal: 4, newSinceLast: 2, titles: ['Always report amounts in PKR', 'Prefer WhatsApp for urgent items'],
    });
    const meaning = curatedMarkerMeaning(stripMarkerEnvelope(marker));
    expect(meaning).toBeTruthy();
    expect(meaning).toContain('2 new memory proposals');
    expect(meaning).toContain('Always report amounts in PKR');
    expect(meaning).toContain('Settings → Brain Memories');
    expect(meaning).toContain('4 waiting in total');
    expect(meaning).toContain('Nothing is applied until you approve');

    // newSinceLast > pendingTotal is a payload the constructor cannot produce → rejected
    expect(curatedMarkerMeaning('[learn_proposal_digest: {"pendingTotal":1,"newSinceLast":5,"titles":["x"]}]')).toBeNull();
    // empty titles rejected
    expect(curatedMarkerMeaning('[learn_proposal_digest: {"pendingTotal":1,"newSinceLast":1,"titles":[]}]')).toBeNull();
    // and the constructor clamps rather than emits an impossible payload
    const clamped = renderLearnProposalDigest({ pendingTotal: 1, newSinceLast: 9, titles: ['t'] });
    expect(curatedMarkerMeaning(stripMarkerEnvelope(clamped))).toBeTruthy();
  });

  it(`titles are capped at ${MAX_TITLES_PER_DIGEST} and the digest flows through the nightly after the sweep`, () => {
    const marker = renderLearnProposalDigest({
      pendingTotal: 9, newSinceLast: 9,
      titles: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
    const payload = JSON.parse(/\{.*\}/.exec(stripMarkerEnvelope(marker))![0]);
    expect(payload.titles).toHaveLength(MAX_TITLES_PER_DIGEST);

    const fs = require('fs'); const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../src/scripts/nexeoLearnSweep.ts'), 'utf8');
    const sweepAt = src.indexOf('sweepQualifyingMemories({ dryRun })');
    const digestAt = src.indexOf('runProposalDigest()');
    expect(digestAt).toBeGreaterThan(sweepAt); // generate → activate → surface, in that order
    expect(src).toContain('sweep already ran'); // a digest failure cannot kill the night
  });
});
