/**
 * DEF-176 — one tenant cannot block, select, expire, correlate, or dispatch
 * another tenant's row (Codex iteration-42 CRITICAL).
 *
 * `sendNextPrompt(userId)` made owner-visible dispatch DECISIONS — which row
 * holds the conversational lock, which row goes next, which rows are stale —
 * from reads scoped only by userId. Under invariant #1 that is a cross-tenant
 * decision surface: tenant B's `awaiting_reply` could silence tenant A's
 * notice, and B's older row could win A's dispatch. That userId is a global PK
 * today is an accident of the schema, never authorization.
 *
 * These tests drive the REAL dispatcher against a stateful row store that
 * HONOURS every filter a query states — and no filter it does not. So a query
 * that omits `clientNumber` happily matches the other tenant's row here, which
 * is exactly what makes the drop-the-filter mutant die loudly instead of
 * passing on a store that quietly ignores tenancy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const A = 'TMC-0001';
const B = 'OTHER-9';

let rows: any[] = [];
let nextId = 1;
/** Raw-SQL calls (the backoff read) — recorded for the scoping assertion. */
let rawCalls: Array<{ sql: string; params: unknown[] }> = [];

const matches = (r: any, where: any): boolean => {
  if (!where) return true;
  if (where.clientNumber !== undefined && r.clientNumber !== where.clientNumber) return false;
  if (where.userId !== undefined && r.userId !== where.userId) return false;
  if (where.state !== undefined) {
    if (typeof where.state === 'string' && r.state !== where.state) return false;
    if (where.state?.in && !where.state.in.includes(r.state)) return false;
  }
  if (where.id !== undefined) {
    if (typeof where.id === 'object' && where.id?.in && !where.id.in.some((x: any) => String(x) === String(r.id))) return false;
    if (typeof where.id === 'object' && where.id?.notIn && where.id.notIn.some((x: any) => String(x) === String(r.id))) return false;
    if (typeof where.id !== 'object' && String(where.id) !== String(r.id)) return false;
  }
  if (where.expiresAt?.lt && !(r.expiresAt < where.expiresAt.lt)) return false;
  return true;
};

vi.mock('../src/db/prisma', () => {
  const brainPromptQueue = {
    findFirst: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where, distinct, select }: any) => {
      let out = rows.filter((r) => matches(r, where));
      if (distinct) {
        const seen = new Set<string>();
        out = out.filter((r) => {
          const key = (distinct as string[]).map((k) => String(r[k])).join('|');
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });
      }
      if (select) {
        return out.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])));
      }
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
  const empty: any = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0,
  };
  const p: any = new Proxy(
    {
      brainPromptQueue,
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) => { rawCalls.push({ sql, params }); return []; },
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
  __esModule: true,
  getConfig: async () => null,
}));

import {
  sendNextPrompt, dispatchDuePrompts, getAwaitingPrompt, recordAnswer, reviveExpiredPrompt,
} from '../src/services/brainPrompts/brainPromptQueueService';

const row = (over: Record<string, any> = {}) => ({
  id: nextId++,
  clientNumber: A, userId: 2,
  question: 'q', openItemId: null, dedupKey: null,
  criticality: 'routine', state: 'queued',
  queuedAt: new Date('2026-08-14T08:00:00Z'),
  sentAt: null, answeredAt: null, answerText: null,
  expiresAt: new Date('2026-08-15T08:00:00Z'),
  metadata: {},
  ...over,
});

beforeEach(() => { rows = []; sent.length = 0; rawCalls = []; nextId = 1; });

describe('DEF-176 — BLOCK: another tenant\'s lock is not this tenant\'s lock', () => {
  it("B's awaiting_reply does not silence A's queued notice", async () => {
    const bLock = row({ clientNumber: B, state: 'awaiting_reply', sentAt: new Date() });
    const aQueued = row({ question: 'A tenant message' });
    rows = [bLock, aQueued];

    const r = await sendNextPrompt(2, A);
    expect(r, "A's dispatch proceeds as if B did not exist").not.toBeNull();
    expect(sent[0]?.body).toBe('A tenant message');
    expect(bLock.state, "B's lock untouched").toBe('awaiting_reply');
  });

  it("B's STALE lock is not expired by A's dispatch — no cross-tenant expiry", async () => {
    // Old enough that the stale-lock release would fire if A could see it.
    const bStale = row({
      clientNumber: B, state: 'awaiting_reply',
      sentAt: new Date(Date.now() - 48 * 3600_000),
    });
    rows = [bStale, row()];
    await sendNextPrompt(2, A);
    expect(bStale.state, "only B's own dispatch may expire B's lock").toBe('awaiting_reply');
  });
});

describe('DEF-176 — SELECT: candidates come from the tenant, not the user id', () => {
  it("B's older row cannot win A's dispatch", async () => {
    const bOld = row({ clientNumber: B, question: 'B message', queuedAt: new Date('2026-08-14T06:00:00Z') });
    const aNew = row({ question: 'A message', queuedAt: new Date('2026-08-14T09:00:00Z') });
    rows = [bOld, aNew];

    const r = await sendNextPrompt(2, A);
    expect(String(r?.promptId)).toBe(String(aNew.id));
    expect(sent[0]?.body).toBe('A message');
    expect(bOld.state, "B's row still queued for B's own sweep").toBe('queued');
  });

  it('the backoff read is tenant-scoped SQL, not user-only', async () => {
    rows = [row()];
    await sendNextPrompt(2, A);
    const backoff = rawCalls.find((c) => /retryAfter/.test(c.sql));
    expect(backoff, 'the backoff query ran').toBeTruthy();
    expect(backoff!.sql).toMatch(/client_number\s*=\s*\$2/);
    expect(backoff!.params).toContain(A);
  });
});

describe('DEF-176 — DISPATCH: the sweep hands each row to its OWN tenant', () => {
  it('two tenants, same userId — each message goes out under its own tenant', async () => {
    rows = [
      row({ question: 'for A' }),
      row({ clientNumber: B, question: 'for B' }),
    ];
    const out = await dispatchDuePrompts();
    expect(out.users, 'distinct (userId, tenant) pairs, not distinct userId').toBe(2);
    expect(out.sent).toBe(2);
    expect(sent.map((s) => s.body).sort()).toEqual(['for A', 'for B']);
  });
});

describe('DEF-176 — CORRELATE: replies attach inside the tenant only', () => {
  it("getAwaitingPrompt never returns another tenant's question", async () => {
    rows = [row({ clientNumber: B, state: 'awaiting_reply', sentAt: new Date() })];
    await expect(getAwaitingPrompt(2, A)).resolves.toBeNull();
  });

  it("recordAnswer with A's scope cannot write B's row", async () => {
    const bRow = row({ clientNumber: B, state: 'awaiting_reply', sentAt: new Date() });
    rows = [bRow];
    await recordAnswer(bRow.id, 'hijacked', { userId: 2, clientNumber: A });
    expect(bRow.state, 'a wrong-tenant id writes NOTHING').toBe('awaiting_reply');
    expect(bRow.answerText).toBeNull();
  });

  it("reviveExpiredPrompt with A's scope cannot revive B's row", async () => {
    const bRow = row({ clientNumber: B, state: 'expired' });
    rows = [bRow];
    await reviveExpiredPrompt(bRow.id, { userId: 2, clientNumber: A });
    expect(bRow.state).toBe('expired');
  });

  it('and the same calls under the OWN tenant still work — scoping is not breakage', async () => {
    const aRow = row({ state: 'awaiting_reply', sentAt: new Date() });
    rows = [aRow];
    await expect(getAwaitingPrompt(2, A)).resolves.not.toBeNull();
    await recordAnswer(aRow.id, 'real answer', { userId: 2, clientNumber: A });
    expect(aRow.state).toBe('answered');
    expect(aRow.answerText).toBe('real answer');
  });
});
