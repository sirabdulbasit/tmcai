/**
 * DEF-158 — a failed relay was a log line, so the message was gone.
 *
 * DEF-157 restored completeness to the unattached-reply path and I wrote this
 * falsifier into the capability block:
 *
 *   > any inbound from an unattached sender that reaches neither the owner nor a
 *   > durable record.
 *
 * Codex's iteration-14 HIGH #1: that was already false, and my test did not check
 * it. `notifyOwnerOfUnattachedReply` wrapped everything in one `try`, and the
 * `catch` logged and returned. So if `enqueueBrainPrompt` rejected — database
 * unavailable, a queue constraint, anything — the counterpart's words reached
 * neither the owner nor any record. Only a log line, which rotates away.
 *
 * The failure is worse than it sounds because of WHEN it runs: only when
 * something is already wrong. The path that exists to cope with trouble was the
 * one that lost data, and it was invisible precisely then.
 *
 * `recordFinding` is the durable, queryable surface this file already uses for
 * the same class (`reply_consume_failed`). The counterpart's words go into the
 * evidence, so *"a real person wrote to us and it went nowhere"* becomes a row.
 *
 * WHY THIS IS EXPORTED RATHER THAN TESTED THROUGH THE CATCH: a test that could
 * only read the source would assert that a `catch` block exists, which is not the
 * property. The property is that the message survives, and that needs the
 * function called and the record inspected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Every finding the code under test recorded. */
const findings: any[] = [];

vi.mock('../src/services/selfheal/healthFindingService', () => ({
  __esModule: true,
  recordFinding: async (f: any) => { findings.push(f); return 'finding-1'; },
}));

vi.mock('../src/db/prisma', () => {
  const model = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    upsert: async () => ({}), count: async () => 0, aggregate: async () => ({}),
    groupBy: async () => [], deleteMany: async () => ({ count: 0 }),
  };
  const p: any = new Proxy(
    { $queryRaw: async () => [], $queryRawUnsafe: async () => [], $executeRaw: async () => 0 },
    { get: (t: any, k: string) => (k in t ? t[k] : model) },
  );
  return { __esModule: true, default: p, prisma: p };
});

import { retainUnrelayedInbound } from '../src/services/delegation/delegationCaptureService';

const URGENT = 'urgent: the server is down, call me';

describe('DEF-158 — an inbound that could not be relayed is still recoverable', () => {
  beforeEach(() => { findings.length = 0; });

  it('records the counterpart\'s WORDS, not just that something failed', () => {
    // The whole point. A finding saying "relay failed" and nothing else would be
    // the same data loss with better telemetry.
    return retainUnrelayedInbound({
      clientNumber: 'TMC-0001',
      ownerUserId: 2,
      who: 'Hamna Latif Bhutta',
      body: URGENT,
      sourceId: 'wamid.ABC',
      reason: 'enqueue rejected: database unavailable',
    }).then(() => {
      expect(findings.length, 'nothing was retained').toBe(1);
      expect(findings[0].evidence.body, 'the message itself must survive').toBe(URGENT);
      expect(findings[0].evidence.who).toBe('Hamna Latif Bhutta');
      expect(findings[0].evidence.reason).toContain('database unavailable');
    });
  });

  it('is an ERROR the owner has not seen, not a warning about internals', () => {
    return retainUnrelayedInbound({
      clientNumber: 'TMC-0001', ownerUserId: 2, who: 'A', body: 'hello',
      sourceId: 's1', reason: 'boom',
    }).then(() => {
      expect(findings[0].severity).toBe('error');
      expect(findings[0].kind).toBe('unattached_reply_undelivered');
      // The summary says the consequence, so a human scanning findings knows what
      // is at stake rather than reading a stack trace.
      expect(findings[0].summary).toContain('the owner has not seen this');
    });
  });

  it('is scoped to the tenant and attributed to the owner', () => {
    // Invariant #1 — every record carries its tenant. A finding that cannot be
    // scoped is a finding nobody can query.
    return retainUnrelayedInbound({
      clientNumber: 'TMC-0001', ownerUserId: 2, who: 'A', body: 'hello',
      sourceId: 's1', reason: 'boom',
    }).then(() => {
      expect(findings[0].clientNumber).toBe('TMC-0001');
      expect(findings[0].userId).toBe(2);
      expect(findings[0].subjectId, 'the message id makes it dedupable').toBe('s1');
    });
  });

  it('truncates the retained body the way the relay does', () => {
    const long = 'x'.repeat(400);
    return retainUnrelayedInbound({
      clientNumber: 'TMC-0001', ownerUserId: 2, who: 'A', body: long,
      sourceId: 's1', reason: 'boom',
    }).then(() => {
      expect(findings[0].evidence.body.length).toBe(300);
    });
  });

  it('never throws — a retention failure must not break capture', () => {
    // If recording the finding itself fails there is nothing more to be done, and
    // taking down the inbound path on top of it would turn one lost message into
    // a stopped pipeline.
    return expect(retainUnrelayedInbound({
      clientNumber: 'TMC-0001', ownerUserId: null, who: 'A', body: 'hello',
      reason: 'boom',
    })).resolves.toBeUndefined();
  });

  describe('the contracts that invited the DEF-156 regression are corrected', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

    it('the capture service no longer claims a burst arrives as one notice', () => {
      // Codex's iteration-14 LOW #4: the comments still described DEF-156's
      // behaviour, so a maintainer could "restore" documented batching by passing
      // `retained: true` and silently drop nine messages again. A comment that
      // describes an unreachable path is a trap, not documentation.
      const capture = read('services/delegation/delegationCaptureService.ts');
      expect(capture).toContain('a burst does NOT arrive');
      expect(capture, 'the trap must be named explicitly')
        .toContain('Do not "restore" batching by passing `true`');
    });

    it('the seam leads with what production actually does', () => {
      const seam = read('services/notifications/proactiveDecision.ts');
      expect(seam).toContain('CURRENT REALITY');
      expect(seam).toContain('correct and inert');
    });
  });
});
