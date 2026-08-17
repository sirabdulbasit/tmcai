/**
 * DEF-208 — a producer can make the queue row part of ITS OWN transaction.
 *
 * Codex, twice, on two different iterations of the same code: *"the pre-send
 * check is another guard above an asynchronous gap … the owner restores the item
 * while `brainPromptQueue.findFirst` or the imports are pending, then enqueue
 * runs; result = Brain tells the owner A withdrew although it is active."*
 *
 * No re-read closes that. The producer checked, awaited, and then wrote an
 * owner-visible fact from a snapshot that could already be false — two commits
 * with an unbounded gap. `tx` makes them one.
 *
 * Two behaviours are withheld on that path, and both withholdings are the point
 * rather than a limitation:
 *
 *   - IMMEDIATE DISPATCH. A WhatsApp message cannot be rolled back. Sending from
 *     inside a transaction that then aborts leaves the owner holding a message
 *     the database says was never queued — the same class of lie, arrived at
 *     from the opposite direction.
 *   - DIGESTING. The digest policy enqueues a second prompt and files the first
 *     on the ambient client, which would escape the caller's boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ambientCreate = vi.hoisted(() => vi.fn());
const ambientFindFirst = vi.hoisted(() => vi.fn());
const queryRawUnsafe = vi.hoisted(() => vi.fn());
const brainContactsUser = vi.hoisted(() => vi.fn());
const decideDigest = vi.hoisted(() => vi.fn());

vi.mock('../src/db/prisma', () => ({
  default: {
    brainPromptQueue: {
      create: ambientCreate,
      findFirst: ambientFindFirst,
      findMany: vi.fn(async () => []),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $queryRawUnsafe: queryRawUnsafe,
    user: { findUnique: vi.fn(async () => null) },
    brainUserMessage: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock('../src/services/notifications/brainOutboundService', () => ({ brainContactsUser }));
vi.mock('../src/services/selfpruning/digestPolicy', () => ({ decideDigest }));
vi.mock('../src/utils/logger', () => ({
  default: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { enqueueBrainPrompt } from '../src/services/brainPrompts/brainPromptQueueService';

const txCreate = vi.fn();
const txFindFirst = vi.fn();
const tx = { brainPromptQueue: { create: txCreate, findFirst: txFindFirst } };

const input = (over: Record<string, unknown> = {}) => ({
  userId: 7,
  clientNumber: 'tenant-1',
  question: '[selfpruning_withdrawn: {"count":1}]',
  criticality: 'routine' as const,
  provenance: 'system_marker' as const,
  ...over,
});

beforeEach(() => {
  ambientCreate.mockReset();
  ambientFindFirst.mockReset();
  queryRawUnsafe.mockReset();
  brainContactsUser.mockReset();
  decideDigest.mockReset();
  txCreate.mockReset();
  txFindFirst.mockReset();
  txFindFirst.mockResolvedValue(null);
  txCreate.mockResolvedValue({ id: 42n });
  ambientFindFirst.mockResolvedValue(null);
  ambientCreate.mockResolvedValue({ id: 99n });
  queryRawUnsafe.mockResolvedValue([]);
});

describe('DEF-208 — the row is created on the caller transaction', () => {
  it('inserts through tx and never through the ambient client', async () => {
    const r = await enqueueBrainPrompt(input({ tx }));

    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(ambientCreate).not.toHaveBeenCalled();
    expect(r.status).toBe('queued');
    expect(r.promptId).toBe('42');
  });

  it('probes for the dedup key on tx too — a probe outside the boundary cannot see the caller writes', async () => {
    await enqueueBrainPrompt(input({ tx, dedupKey: 'selfpruning_withdrawn:abc' }));

    expect(txFindFirst).toHaveBeenCalledTimes(1);
    expect(ambientFindFirst).not.toHaveBeenCalled();
    const where = txFindFirst.mock.calls[0][0].where;
    expect(where.clientNumber).toBe('tenant-1');   // DEF-175 — still tenant-scoped
    expect(where.userId).toBe(7);
    expect(where.dedupKey).toBe('selfpruning_withdrawn:abc');
  });

  it('reports an existing live row as duplicate without inserting', async () => {
    txFindFirst.mockResolvedValue({ id: 5n });

    const r = await enqueueBrainPrompt(input({ tx, dedupKey: 'k' }));

    expect(r.status).toBe('duplicate');
    expect(txCreate).not.toHaveBeenCalled();
  });
});

describe('DEF-208 — what a transaction must not do', () => {
  it('does NOT dispatch immediately: an outbound message cannot be rolled back', async () => {
    const r = await enqueueBrainPrompt(input({ tx }));

    // sendNextPrompt claims the awaiting_reply slot with a raw query; not
    // reaching it is the proof that nothing was sent inside the boundary.
    expect(queryRawUnsafe).not.toHaveBeenCalled();
    expect(brainContactsUser).not.toHaveBeenCalled();
    expect(r.status).toBe('queued');
  });

  it('still dispatches on the ordinary path — the withholding is scoped to tx callers', async () => {
    decideDigest.mockResolvedValue({ action: 'send', reason: 'not an item push' });

    await enqueueBrainPrompt(input());

    expect(ambientCreate).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafe, 'the normal path still tries to send now').toHaveBeenCalled();
  });

  it('does NOT run the digest policy inside a transaction — it writes on the ambient client', async () => {
    await enqueueBrainPrompt(input({ tx }));
    expect(decideDigest).not.toHaveBeenCalled();
  });

  it('rejects top criticality rather than silently downgrading it', async () => {
    await expect(enqueueBrainPrompt(input({ tx, criticality: 'top' as const })))
      .rejects.toThrow(/cannot run inside a transaction/i);

    // The rejection happens BEFORE the call places anything.
    expect(brainContactsUser).not.toHaveBeenCalled();
    expect(txCreate).not.toHaveBeenCalled();
  });
});
