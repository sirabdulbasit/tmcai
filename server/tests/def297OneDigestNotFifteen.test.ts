/**
 * DEF-297 — the anti-spam mechanism spammed him fifteen times in one second.
 *
 * 2026-09-03 12:57:40–41. He asked who had messaged him and got **15 near-identical digests
 * inside two seconds**, each with a different total: 717, 725, 722, 713, 680, 676, 674, 721, 687,
 * 716, 719, 714, 732, 715, 668.
 *
 * `maybeSendSuppressionDigest` is fired `void`-style on every budget hold, so a burst of 37 held
 * draft-asks in one tick starts 37 concurrent calls. **Three guards already stood in their way**
 * — a compose-time "already sent?" read, a constant `dedupKey`, and the per-kind 60s limiter —
 * and all three are read-then-act, so the burst defeated all three at once: every call read
 * "none sent yet" before any had written. Each then made its own model call (hence the differing
 * wording) and counted `held.length` at its own moment (hence the differing numbers).
 *
 * The missing guard was never a fourth check of the same kind. It is MUTUAL EXCLUSION, and it has
 * to be claimed synchronously — before the first `await` — or it races exactly like the others.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
const findFirst = vi.fn();
const contactsUser = vi.fn();
const callLLM = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    brainUserMessage: {
      findMany: (...a: any[]) => findMany(...a),
      findFirst: (...a: any[]) => findFirst(...a),
      create: vi.fn(async () => ({ id: 1n })),
      count: vi.fn(async () => 0),
    },
    user: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock('../src/services/llmRouter', () => ({ callLLM: (...a: any[]) => callLLM(...a) }));

import { maybeSendSuppressionDigest } from '../src/services/notifications/brainOutboundService';

const USER = { id: 2, clientNumber: 'TMC-0001' };

beforeEach(() => {
  vi.clearAllMocks();
  // 37 held notifications, as on the day.
  findMany.mockResolvedValue(Array.from({ length: 37 }, (_, i) => ({
    kind: 'open_item_draft_ask', summary: `held ${i}`,
  })));
  findFirst.mockResolvedValue(null);           // no digest sent yet — the racy read
  callLLM.mockResolvedValue({ text: 'I held some notifications today.' });
});

describe('DEF-297 — a burst produces ONE digest', () => {
  it('THE REGRESSION: 37 concurrent holds do the work ONCE', async () => {
    // Exactly the shape of the incident: every call starts before any finishes.
    //
    // Asserted on `findMany` — the FIRST await in the function, so it is reached on every path
    // that gets past the claim. An earlier version of this test asserted on the model call and
    // passed with the claim REMOVED, i.e. it proved nothing; `findMany` is sensitive because the
    // claim is the only thing standing between 37 calls and 37 queries.
    await Promise.all(Array.from({ length: 37 }, () => maybeSendSuppressionDigest(USER)));
    expect(findMany.mock.calls.length).toBe(1);
  });

  it('the claim is taken BEFORE any await, or it races like the rest', () => {
    // A claim taken after an await is just a fourth read-then-act guard.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'notifications', 'brainOutboundService.ts'), 'utf-8');
    // Comments stripped first: the comment in that function contains the word "await", so an
    // unstripped slice ends before reaching the claim. My own comment breaking my own test —
    // BLD-009, and the fifth variant of it today.
    const fnRaw = src.slice(src.indexOf('export async function maybeSendSuppressionDigest'));
    const fn = fnRaw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const head = fn.slice(0, fn.indexOf('await'));
    expect(head).toContain('digestInFlight.has(claim)');
    expect(head).toContain('digestInFlight.add(claim)');
  });

  it('a later burst still gets its digest — the claim is not a permanent latch', async () => {
    await maybeSendSuppressionDigest(USER);
    const first = callLLM.mock.calls.length;
    await maybeSendSuppressionDigest(USER);
    expect(callLLM.mock.calls.length).toBeGreaterThan(first);
  });

  it('a throw does not wedge the claim and silence every future digest', async () => {
    // Released in `finally` for this reason: the opposite failure is worse than a duplicate.
    callLLM.mockRejectedValue(new Error('model down'));
    await maybeSendSuppressionDigest(USER);
    callLLM.mockResolvedValue({ text: 'ok now' });
    findFirst.mockResolvedValue(null);
    await maybeSendSuppressionDigest(USER);
    expect(callLLM.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('claims per user, so one owner cannot block another', async () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'notifications', 'brainOutboundService.ts'), 'utf-8');
    expect(src).toContain('`${user.clientNumber}:${user.id}`');
  });

  it('says nothing at all when nothing was held', async () => {
    findMany.mockResolvedValue([]);
    await maybeSendSuppressionDigest(USER);
    expect(contactsUser).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });
});
