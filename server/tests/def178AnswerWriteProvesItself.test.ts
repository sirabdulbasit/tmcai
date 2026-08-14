/**
 * DEF-178 — the answer write proves itself, or nothing else happens
 * (Codex iteration-50 CRITICAL, finding 1; finding 3 covered below).
 *
 * `recordAnswer` wrote with a scoped updateMany and returned void, so
 * `handlePromptReply` applied the side effect and acked "[recorded]" whether
 * or not any row actually transitioned. A prompt that was deleted, consumed
 * by a concurrent delivery of the same webhook, or resolved under the wrong
 * scope still changed owner state with no durable answer ledger behind it.
 *
 * These tests drive the REAL reply handler and the REAL queue service
 * against a stateful row store that honours every filter a query states —
 * and no filter it does not. The race is injected deterministically: the
 * relevance-classifier mock runs BETWEEN the candidate read and the answer
 * write, exactly where the production race window sits, and each test
 * mutates the store there.
 *
 * Mutants these tests kill:
 *   M1 — recordAnswer returns true unconditionally (ignore count again):
 *        the deleted/raced tests see a side effect that must not exist.
 *   M2 — recordAnswer drops the state guard: the already-consumed test sees
 *        the racer's persisted answer overwritten.
 *   M3 — handler ignores recordAnswer's result: same observable as M1.
 *   M4 — expireStalePrompts counts enumerated rows instead of transitioned
 *        rows: the sweep-race test sees expired=1 and an extra dispatch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const A = 'TMC-0001';
const B = 'OTHER-9';

let rows: any[] = [];
let openItems: any[] = [];
let nextId = 1;
/** Fires after brainPromptQueue.findMany returns — the enumeration/write
 *  race window for expireStalePrompts. */
let afterEnumerate: (() => void) | null = null;

const matches = (r: any, where: any): boolean => {
  if (!where) return true;
  if (where.clientNumber !== undefined && r.clientNumber !== where.clientNumber) return false;
  if (where.userId !== undefined && r.userId !== where.userId) return false;
  if (where.state !== undefined) {
    if (typeof where.state === 'string' && r.state !== where.state) return false;
    if (where.state?.in && !where.state.in.includes(r.state)) return false;
  }
  if (where.id !== undefined && typeof where.id !== 'object' && String(where.id) !== String(r.id)) return false;
  if (where.expiresAt?.lt && !(r.expiresAt < where.expiresAt.lt)) return false;
  if (where.sentAt) {
    if (where.sentAt.not === null && r.sentAt === null) return false;
    if (where.sentAt.gte && !(r.sentAt && r.sentAt >= where.sentAt.gte)) return false;
  }
  return true;
};

vi.mock('../src/db/prisma', () => {
  const brainPromptQueue = {
    findFirst: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where, select }: any) => {
      let out = rows.filter((r) => matches(r, where));
      if (select) out = out.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])));
      const hook = afterEnumerate; afterEnumerate = null;
      hook?.();
      return out;
    },
    update: async ({ where, data }: any) => {
      const r = rows.find((x) => String(x.id) === String(where.id));
      if (!r) throw new Error('not found');
      Object.assign(r, data);
      return { ...r };
    },
    updateMany: async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    create: async ({ data }: any) => { const r = { id: nextId++, ...data }; rows.push(r); return { id: r.id }; },
    count: async () => 0,
  };
  const openItem = {
    findFirst: async ({ where }: any) =>
      openItems.find((o) => String(o.id) === String(where.id)
        && (where.clientNumber === undefined || o.clientNumber === where.clientNumber)) ?? null,
    update: async ({ where, data }: any) => {
      const o = openItems.find((x) => String(x.id) === String(where.id));
      if (!o) throw new Error('not found');
      Object.assign(o, data);
      return { ...o };
    },
  };
  const empty: any = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0,
  };
  const p: any = new Proxy(
    {
      brainPromptQueue, openItem,
      user: { findUnique: async () => ({ clientNumber: A }) },
      $queryRawUnsafe: async () => [],
    },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

const sent: Array<{ userId: number; body: string }> = [];
vi.mock('../src/services/notifications/brainOutboundService', () => ({
  __esModule: true,
  brainContactsUser: async (req: any) => {
    sent.push({ userId: req.userId, body: req.body });
    return { sent: true, channelsUsed: ['text'], waMessageIds: ['wamid.T'] };
  },
}));

vi.mock('../src/services/configService', () => ({
  __esModule: true, getConfig: async () => null,
}));

vi.mock('../src/services/behaviorConfig', () => ({
  __esModule: true,
  getBehaviorValue: async (key: string) =>
    key === 'prompt_reply.lookback_hours' ? 24
    : key === 'prompt_reply.max_candidates' ? 5
    : 0,
}));

vi.mock('../src/services/delegation/delegationCaptureService', () => ({
  __esModule: true, rerenderOwnerQuestion: () => null,
}));

/** Runs inside the classifier — i.e. between the candidate read and the
 *  answer write. This is where each test injects its race. */
let raceInjection: (() => void) | null = null;
vi.mock('../src/services/brainPrompts/promptReplyRelevance', () => ({
  __esModule: true,
  classifyPromptReplyRelevance: async () => {
    const hook = raceInjection; raceInjection = null;
    hook?.();
    return { relevance: 'direct_answer', confidence: 0.95 };
  },
  mayConsumeAsAnswer: (v: any) => v?.relevance === 'direct_answer',
  mayConsumePartially: () => false,
}));

import { handlePromptReply } from '../src/services/brainPrompts/promptReplyHandler';
import { recordAnswer, expireStalePrompts } from '../src/services/brainPrompts/brainPromptQueueService';

const row = (over: Record<string, any> = {}) => ({
  id: nextId++,
  clientNumber: A, userId: 2,
  question: 'What is the figure?', openItemId: null, dedupKey: null,
  criticality: 'routine', state: 'awaiting_reply',
  sideEffect: { kind: 'free_form_note', openItemId: 'oi-1' },
  queuedAt: new Date(Date.now() - 3600_000),
  sentAt: new Date(Date.now() - 1800_000),
  answeredAt: null, answerText: null,
  ackMessageId: null,
  expiresAt: new Date(Date.now() + 3600_000),
  metadata: {},
  ...over,
});

const input = { userId: 2, clientNumber: A, text: 'the figure is forty' };

beforeEach(() => {
  rows = []; sent.length = 0; nextId = 1;
  raceInjection = null; afterEnumerate = null;
  openItems = [{ id: 'oi-1', clientNumber: A, title: 'Figures', notes: [] }];
});

describe('DEF-178 — an answer that did not persist mutates nothing', () => {
  it('prompt deleted between read and write → handled:false, no side effect, no ack', async () => {
    const r = row();
    rows = [r];
    raceInjection = () => { rows = []; };  // another process deleted the prompt

    const out = await handlePromptReply(input);
    expect(out.handled, 'no persisted answer → not handled').toBe(false);
    expect(out.ackMessage, 'nothing to ack').toBeUndefined();
    expect(openItems[0].notes, 'the side effect must NOT run').toEqual([]);
  });

  it('prompt consumed concurrently → the racer\'s answer survives, ours mutates nothing', async () => {
    const r = row();
    rows = [r];
    raceInjection = () => {
      // The same webhook delivered twice; the other delivery won.
      r.state = 'answered';
      r.answerText = 'the racer answer';
      r.answeredAt = new Date();
    };

    const out = await handlePromptReply(input);
    expect(out.handled).toBe(false);
    expect(r.answerText, 'the persisted answer is not overwritten').toBe('the racer answer');
    expect(openItems[0].notes, 'the loser applies no side effect').toEqual([]);
  });

  it('expired candidate consumed before revival → handled:false', async () => {
    const r = row({ state: 'expired' });
    rows = [r];
    raceInjection = () => { r.state = 'answered'; r.answerText = 'already taken'; };

    const out = await handlePromptReply(input);
    expect(out.handled).toBe(false);
    expect(r.answerText).toBe('already taken');
  });

  it('recordAnswer is a CAS: already-consumed and wrong-tenant both return false and write nothing', async () => {
    const consumed = row({ state: 'answered', answerText: 'first delivery' });
    const foreign = row({ clientNumber: B, userId: 2 });
    rows = [consumed, foreign];

    await expect(recordAnswer(consumed.id, 'second delivery', { userId: 2, clientNumber: A }))
      .resolves.toBe(false);
    expect(consumed.answerText).toBe('first delivery');

    await expect(recordAnswer(foreign.id, 'hijacked', { userId: 2, clientNumber: A }))
      .resolves.toBe(false);
    expect(foreign.state, 'a wrong-tenant id writes NOTHING').toBe('awaiting_reply');
    expect(foreign.answerText).toBeNull();
  });

  it('and the honest path still works: persisted answer → handled, acked, side effect applied', async () => {
    const r = row();
    rows = [r];

    const out = await handlePromptReply(input);
    expect(out.handled).toBe(true);
    expect(out.ackMessage).toBeTruthy();
    expect(r.state).toBe('answered');
    expect(r.answerText).toBe('the figure is forty');
    expect(openItems[0].notes.length, 'free_form_note applied exactly once').toBe(1);
    expect(openItems[0].notes[0].text).toBe('the figure is forty');
  });
});

describe('DEF-178 — stale expiry counts its own writes (Codex iteration-50 finding 3)', () => {
  it('a row answered between enumeration and the guarded write is NOT reported expired and frees no slot', async () => {
    const racing = row({ expiresAt: new Date(Date.now() - 60_000) });
    const nextQueued = row({ state: 'queued', sentAt: null, expiresAt: new Date(Date.now() + 3600_000) });
    rows = [racing, nextQueued];
    afterEnumerate = () => { racing.state = 'answered'; racing.answerText = 'made it in time'; };

    const out = await expireStalePrompts();
    expect(out.expired, 'zero rows transitioned → zero expired').toBe(0);
    expect(racing.state, 'the answered row is not clobbered').toBe('answered');
    expect(sent.length, 'no slot freed → no extra dispatch').toBe(0);
    expect(nextQueued.state).toBe('queued');
  });

  it('a genuinely stale row still expires and advances the queue — counting is not breakage', async () => {
    const stale = row({ expiresAt: new Date(Date.now() - 60_000) });
    const nextQueued = row({ state: 'queued', sentAt: null, question: 'next up', expiresAt: new Date(Date.now() + 3600_000) });
    rows = [stale, nextQueued];

    const out = await expireStalePrompts();
    expect(out.expired).toBe(1);
    expect(stale.state).toBe('expired');
    expect(sent.map((s) => s.body)).toContain('next up');
  });
});
