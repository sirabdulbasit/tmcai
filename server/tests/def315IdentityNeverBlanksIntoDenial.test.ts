/**
 * DEF-315 — `capability-fabrication`: a live regression of DEF-299, one day
 * after its deploy. Owner, 09-04 12:44, 113 seconds after changing Brain's
 * number: *"what is your number?"* → *"I don't have a phone number myself."*
 * He was holding the phone that number rings on.
 *
 * Two mechanisms, both closed here:
 *  1. The null-read fallback manufactured a WORLD-claim ("I do not currently
 *     have a WhatsApp number of my own connected") from an EMPTY READ. The
 *     DEF-085 discipline — unavailable ≠ none — now applies to identity: the
 *     fallback states a fact about the READ, which cannot be false.
 *  2. The 60s cache stored the transiently-empty identity, serving the denial
 *     for the full TTL. A NULL own-number is never cached now — identity
 *     absence heals at the NEXT read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  waRow: [{ connected_number: '+923710042740', status: 'connected' }] as any[],
  rawCalls: 0,
}));

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    count: async () => 0, groupBy: async () => [], aggregate: async () => ({}),
  };
  const p: any = new Proxy(
    {
      $queryRawUnsafe: async (sql: string) => {
        state.rawCalls += 1;
        if (sql.includes('whatsapp') || sql.includes('connected_number')) return state.waRow;
        return [];
      },
      $queryRaw: async () => [],
    },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

import {
  getSystemCapabilities,
  renderCapabilitiesBlock,
} from '../src/services/knowledge/systemCapabilitiesService';

const base = {
  userConnectors: [], tenantConnectors: [], feedCounts30d: {},
  wikiStats: {
    orgDocs: 0, projects: 0, policies: 0, senderHistories: 0,
    senderTopics: 0, entities: 0, gaps: 0, answers: 0,
  },
  promptQueue: {
    queued: 0, awaitingReplyTitle: null, awaitingReplySentAt: null,
    sentLast24h: 0, answeredLast7d: 0,
  },
} as any;
const render = (waIdentity: any) => renderCapabilitiesBlock({ ...base, waIdentity } as any);

beforeEach(() => {
  state.waRow = [{ connected_number: '+923710042740', status: 'connected' }];
  state.rawCalls = 0;
});

describe('DEF-315 — an empty identity read is a READ fact, never a world-claim', () => {
  const nullIdentity = {
    brainNumber: null, brainStatus: null,
    ownerPersonalNumber: null, ownerPersonalStatus: null,
  };

  it('THE 09-04 SHAPE: null number renders knowledge, forbids the denial, offers the recheck', () => {
    const block = render(nullIdentity);
    expect(block).toContain('could not be read just now');
    expect(block).toContain('a statement about THIS read, not about the world');
    expect(block).toMatch(/NEVER say I do not have one/);
    expect(block).toContain('offer to check again');
    // The exact fabricated sentence's source string is gone.
    expect(block).not.toContain('do not currently have a WhatsApp number');
  });

  it('a present number still renders as the owned fact (DEF-299 regression guard)', () => {
    const block = render({
      brainNumber: '+923710042740', brainStatus: 'connected',
      ownerPersonalNumber: null, ownerPersonalStatus: null,
    });
    expect(block).toContain('MY OWN WhatsApp number, the number people message ME on: +923710042740');
    expect(block).not.toContain('could not be read just now');
  });
});

describe('DEF-315 — a NULL own-number is never cached; identity absence heals at the next read', () => {
  it('null identity → the next call re-reads and picks up the new number immediately', async () => {
    state.waRow = []; // the transient empty window, exactly the 09-04 state
    const first = await getSystemCapabilities('TMC-0315', 91);
    expect(first.waIdentity.brainNumber).toBeNull();
    // The number appears (re-pair completed) — the VERY NEXT read must see it.
    state.waRow = [{ connected_number: '+923330000001', status: 'connected' }];
    const second = await getSystemCapabilities('TMC-0315', 91);
    // Mutation: restoring the unconditional cache.set dies here — the second
    // call would serve the cached null for the full TTL.
    expect(second.waIdentity.brainNumber).toBe('+923330000001');
  });

  it('a PRESENT number is still cached — the hot path stays hot', async () => {
    await getSystemCapabilities('TMC-0316', 92);
    const callsAfterFirst = state.rawCalls;
    await getSystemCapabilities('TMC-0316', 92);
    expect(state.rawCalls).toBe(callsAfterFirst); // served from cache, no new reads
  });
});
