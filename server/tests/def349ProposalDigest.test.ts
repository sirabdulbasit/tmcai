/**
 * DEF-349 — the pending-proposals digest (the SURFACING half of the Learn
 * loop), with DEF-350 — coverage derived from the LIVE QUEUE, not a cursor.
 *
 * DEF-349 works live (10-25: `learn_proposal_digest:2:2026-10-25`, state
 * queued, 5 memoryIds). But its original per-tenant time cursor could
 * DISAGREE with the queue in two ways that lose proposals forever (Codex's
 * DEF-349 review, findings #1 and #4 — the second live-scheduled: the queued
 * digest's 48h TTL expires 10-27 with both channels dark, and the cursor had
 * already advanced past all five proposals). DEF-350 removes the second
 * source of truth: a proposal is covered iff a digest row in a non-lost state
 * carries its id in metadata.memoryIds. No cursor, nothing to drift.
 *
 * Under test:
 *  - uncovered proposals → one digest per affected user through the one
 *    chokepoint, day-keyed dedup, expectsReply false, the COMPLETE id list in
 *    metadata (it IS the coverage record);
 *  - a live (queued) digest covers its ids → no re-send; an EXPIRED digest
 *    drops them → re-announced under a fresh day key (Codex #4);
 *  - a same-day 'duplicate' marks nothing covered, so a proposal first-fresh
 *    after today's digest survives to the next run (Codex #1);
 *  - blank-title proposals are excluded and counted, never claimed (Codex #2);
 *  - enqueue failure → tenantsFailed, coverage unchanged;
 *  - the marker round-trip: rendered payload accepted by the sanitizer's
 *    curated meaning; impossible payloads rejected, never repaired.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  tenants: [] as Array<{ clientNumber: string }>,
  pendingByTenant: {} as Record<string, any[]>,
  digestRowsByTenant: {} as Record<string, Array<{ state: string; metadata: any }>>,
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
    brainPromptQueue: {
      findMany: async (args: any) => state.digestRowsByTenant[args.where.clientNumber] ?? [],
    },
  };
  return { __esModule: true, default: p, prisma: p };
});

import {
  runProposalDigest, DIGEST_DEDUP_PREFIX, DIGEST_LOST_STATES,
  MAX_TITLES_PER_DIGEST, MAX_IDS_PER_DIGEST,
} from '../src/services/learning/proposalDigest';
import { renderLearnProposalDigest } from '../src/services/notifications/proactiveMessageText';
import { curatedMarkerMeaning } from '../src/services/knowledge/answerSanitizer';
import { stripMarkerEnvelope } from '../src/services/knowledge/systemMarker';

const mem = (id: string, userId: number | null, title: string, at: string) => ({
  id, userId, title, createdAt: new Date(at),
});
const digestRow = (st: string, ids: string[]) => ({ state: st, metadata: { memoryIds: ids } });

function harness(opts: { enqueueStatus?: string | Error; flag?: number } = {}) {
  const enqueued: any[] = [];
  return {
    enqueued,
    deps: {
      enqueue: async (input: any) => {
        if (opts.enqueueStatus instanceof Error) throw opts.enqueueStatus;
        enqueued.push(input);
        return { status: opts.enqueueStatus ?? 'queued' };
      },
      getBehavior: async () => opts.flag ?? 1,
    },
  };
}

beforeEach(() => { state.tenants = []; state.pendingByTenant = {}; state.digestRowsByTenant = {}; });

describe('DEF-349/DEF-350 — pending proposals reach the owner, and the queue itself is the coverage record', () => {
  it('uncovered proposals → ONE digest per user with day-dedup, expectsReply false, and the COMPLETE id list as the receipt', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.pendingByTenant['TMC-0001'] = [
      mem('m1', 2, 'Always report amounts in PKR', '2026-10-24T03:00:00Z'),
      mem('m2', 2, 'Prefer WhatsApp for urgent items', '2026-10-24T03:05:00Z'),
      mem('m3', 7, 'Weekly summary on Fridays', '2026-10-24T03:10:00Z'),
    ];
    const h = harness();
    const r = await runProposalDigest(h.deps);
    expect(r).toMatchObject({ tenants: 1, usersNotified: 2, duplicates: 0, tenantsFailed: 0 });
    expect(h.enqueued).toHaveLength(2);
    const forUser2 = h.enqueued.find((e) => e.userId === 2);
    expect(forUser2).toMatchObject({
      clientNumber: 'TMC-0001',
      criticality: 'routine',
      expectsReply: false,
      provenance: 'system_marker',
    });
    expect(forUser2.dedupKey).toMatch(new RegExp(`^${DIGEST_DEDUP_PREFIX}2:\\d{4}-\\d{2}-\\d{2}$`));
    expect(forUser2.metadata.memoryIds).toEqual(['m1', 'm2']); // complete — this IS the coverage record
    expect(stripMarkerEnvelope(forUser2.question)).toContain('"newSinceLast":2');
  });

  it('a LIVE (queued) digest covers its proposals — no re-send, no duplicate spam', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.pendingByTenant['TMC-0001'] = [mem('m1', 2, 'Rule', '2026-10-24T03:00:00Z')];
    state.digestRowsByTenant['TMC-0001'] = [digestRow('queued', ['m1'])];
    const h = harness();
    const r = await runProposalDigest(h.deps);
    expect(r.skippedAllCovered).toBe(1);
    expect(h.enqueued).toHaveLength(0);
  });

  it('CODEX #4 — an EXPIRED digest drops its proposals from coverage and they are RE-ANNOUNCED (the 10-27 TTL scenario)', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.pendingByTenant['TMC-0001'] = [
      mem('m1', 2, 'Always report amounts in PKR', '2026-10-24T03:00:00Z'),
      mem('m2', 2, 'Prefer WhatsApp for urgent items', '2026-10-24T03:05:00Z'),
    ];
    state.digestRowsByTenant['TMC-0001'] = [digestRow('expired', ['m1', 'm2'])];
    const h = harness();
    const r = await runProposalDigest(h.deps);
    expect(r.usersNotified).toBe(1); // regenerated from current truth, fresh day key
    expect(h.enqueued[0].metadata.memoryIds).toEqual(['m1', 'm2']);
    for (const lost of DIGEST_LOST_STATES) expect(['expired', 'cancelled', 'skipped']).toContain(lost);
  });

  it('CODEX #1 — a proposal first-fresh AFTER today\'s digest is not lost: the same-day duplicate marks nothing covered', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    // today's digest already queued, covering only m1; m2 arrived later today
    state.pendingByTenant['TMC-0001'] = [
      mem('m1', 2, 'Rule one', '2026-10-25T02:00:00Z'),
      mem('m2', 2, 'Rule two', '2026-10-25T14:00:00Z'),
    ];
    state.digestRowsByTenant['TMC-0001'] = [digestRow('queued', ['m1'])];
    const dup = harness({ enqueueStatus: 'duplicate' });
    const r1 = await runProposalDigest(dup.deps);
    expect(r1.duplicates).toBe(1); // today's key refused — and nothing marked m2 covered
    // next run (tomorrow: the queue accepts) — m2 is still uncovered and gets its digest
    const ok = harness();
    const r2 = await runProposalDigest(ok.deps);
    expect(r2.usersNotified).toBe(1);
    expect(ok.enqueued[0].metadata.memoryIds).toEqual(['m2']);
  });

  it('CODEX #2 — blank-title proposals are excluded and counted, never enqueued-then-eaten or claimed as announced', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.pendingByTenant['TMC-0001'] = [
      mem('m1', 2, '   ', '2026-10-24T03:00:00Z'),
      mem('m2', 2, 'A real rule', '2026-10-24T03:05:00Z'),
    ];
    const h = harness();
    const r = await runProposalDigest(h.deps);
    expect(r.unshowable).toBe(1);
    expect(r.usersNotified).toBe(1);
    expect(h.enqueued[0].metadata.memoryIds).toEqual(['m2']); // the blank one is never claimed
  });

  it('an enqueue failure fails the tenant and leaves coverage unchanged — the proposals retry next run', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.pendingByTenant['TMC-0001'] = [mem('m1', 2, 'Rule', '2026-10-24T03:00:00Z')];
    const h = harness({ enqueueStatus: new Error('queue down') });
    const r = await runProposalDigest(h.deps);
    expect(r.tenantsFailed).toBe(1);
    // coverage is the queue itself: no row was created, so a healthy next run announces
    const ok = harness();
    expect((await runProposalDigest(ok.deps)).usersNotified).toBe(1);
  });

  it('flag off → nothing; userId-null proposals counted, never mis-addressed; oversized batches bounded not lost', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.pendingByTenant['TMC-0001'] = [mem('m1', null, 'Tenant-wide rule', '2026-10-24T03:00:00Z')];
    const h = harness();
    const r = await runProposalDigest(h.deps);
    expect(r.tenantScopeSkipped).toBe(1);
    expect(h.enqueued).toHaveLength(0);

    const off = harness({ flag: 0 });
    state.pendingByTenant['TMC-0001'] = [mem('m2', 2, 'Rule', '2026-10-24T03:00:00Z')];
    expect((await runProposalDigest(off.deps)).skippedDisabled).toBe(1);

    // > MAX_IDS_PER_DIGEST fresh proposals: the digest is bounded; the overflow
    // stays uncovered and rolls to the next day — delay, never loss.
    state.pendingByTenant['TMC-0001'] = Array.from({ length: MAX_IDS_PER_DIGEST + 3 }, (_, i) =>
      mem(`b${i}`, 2, `Rule ${i}`, '2026-10-24T03:00:00Z'));
    const big = harness();
    await runProposalDigest(big.deps);
    expect(big.enqueued[0].metadata.memoryIds).toHaveLength(MAX_IDS_PER_DIGEST);
  });

  it('MARKER ROUND-TRIP: the rendered payload yields the curated FACT; impossible payloads are rejected, not repaired', () => {
    const marker = renderLearnProposalDigest({
      pendingTotal: 4, newSinceLast: 2, titles: ['Always report amounts in PKR', 'Prefer WhatsApp for urgent items'],
    });
    const meaning = curatedMarkerMeaning(stripMarkerEnvelope(marker));
    expect(meaning).toBeTruthy();
    expect(meaning).toContain('2 new memory proposals');
    expect(meaning).toContain('Nothing is applied until you approve');
    expect(curatedMarkerMeaning('[learn_proposal_digest: {"pendingTotal":1,"newSinceLast":5,"titles":["x"]}]')).toBeNull();
    expect(curatedMarkerMeaning('[learn_proposal_digest: {"pendingTotal":1,"newSinceLast":1,"titles":[]}]')).toBeNull();

    const capped = renderLearnProposalDigest({
      pendingTotal: 9, newSinceLast: 9, titles: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    const payload = JSON.parse(/\{.*\}/.exec(stripMarkerEnvelope(capped))![0]);
    expect(payload.titles).toHaveLength(MAX_TITLES_PER_DIGEST);
  });

  it('the nightly runs generate → activate → surface, and a digest failure cannot kill the night', () => {
    const fs = require('fs'); const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../src/scripts/nexeoLearnSweep.ts'), 'utf8');
    const sweepAt = src.indexOf('sweepQualifyingMemories({ dryRun })');
    const digestAt = src.indexOf('runProposalDigest()');
    expect(digestAt).toBeGreaterThan(sweepAt);
    expect(src).toContain('sweep already ran');
  });
});
