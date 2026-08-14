/**
 * DEF-178 — delivery is tenant-scoped end to end
 * (Codex iteration-50 finding 2, AGENTS.md §2.1 invariant #1).
 *
 * `brainContactsUser` resolved everything from the userId alone: the caller
 * declared no tenant, and every suppression/dedup/rate/cap read on the
 * brain_user_messages ledger filtered by userId only. A bare integer was an
 * authorization. Now the caller MUST declare the tenant it acts for, the
 * declaration is verified against the resolved user (fail closed), and every
 * ledger read is scoped by (clientNumber, userId).
 *
 * The store below honours every filter a query states — and no filter it
 * does not — so a ledger read that drops `clientNumber` happily matches the
 * foreign rows seeded here, and the drop-the-filter mutant dies loudly.
 *
 * Mutants these tests kill:
 *   M1 — delete the tenant-mismatch guard: the mismatch test sees a real send.
 *   M2 — drop clientNumber from the dedupKey read: foreign-noise test is
 *        suppressed instead of sent.
 *   M3 — drop clientNumber from the content-fingerprint read: same.
 *   M4 — drop clientNumber from the daily-cap count: same.
 *   M5 — drop clientNumber from the per-kind rate read: same.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

const A = 'TMC-0001';
const B = 'OTHER-9';

const users: any[] = [];
let messages: any[] = [];
let nextMsgId = 1;
/** WHERE clause of every prisma.user query the service issued. */
let userQueries: any[] = [];

const msgMatches = (m: any, where: any): boolean => {
  if (!where) return true;
  if (where.clientNumber !== undefined && m.clientNumber !== where.clientNumber) return false;
  if (where.userId !== undefined && m.userId !== where.userId) return false;
  if (where.kind !== undefined) {
    if (typeof where.kind === 'string' && m.kind !== where.kind) return false;
    if (where.kind?.in && !where.kind.in.includes(m.kind)) return false;
  }
  if (where.dedupKey !== undefined && m.dedupKey !== where.dedupKey) return false;
  if (where.status?.in && !where.status.in.includes(m.status)) return false;
  if (where.createdAt?.gte && !(m.createdAt >= where.createdAt.gte)) return false;
  if (where.metadata?.path) {
    const key = where.metadata.path[0];
    if ((m.metadata ?? {})[key] !== where.metadata.equals) return false;
  }
  return true;
};

vi.mock('../src/db/prisma', () => {
  const brainUserMessage = {
    findFirst: async ({ where }: any) => messages.find((m) => msgMatches(m, where)) ?? null,
    count: async ({ where }: any) => messages.filter((m) => msgMatches(m, where)).length,
    create: async ({ data }: any) => {
      const m = { id: nextMsgId++, createdAt: new Date(), ...data };
      messages.push(m);
      return m;
    },
  };
  // DEF-179: the user store records every query's WHERE so the tests can
  // assert that no user read on this path omits the tenant — the invariant
  // is that the QUERY is constrained, not that foreign data is read and
  // rejected afterwards.
  const user = {
    findFirst: async ({ where }: any) => {
      userQueries.push(where);
      return users.find((u) =>
        (where.id === undefined || u.id === where.id)
        && (where.clientNumber === undefined || u.clientNumber === where.clientNumber)) ?? null;
    },
    findUnique: async ({ where }: any) => {
      userQueries.push(where);
      return users.find((u) => u.id === where.id) ?? null;
    },
  };
  const empty: any = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0,
  };
  const p: any = new Proxy(
    { brainUserMessage, user, $queryRawUnsafe: async () => [] },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

const delivered: Array<{ clientNumber: string; phone: string; body: string }> = [];
vi.mock('../src/services/notifications/tenantWhatsappSender', () => ({
  __esModule: true,
  sendTenantWhatsAppText: async (clientNumber: string, phone: string, body: string) => {
    delivered.push({ clientNumber, phone, body });
    return { ok: true, waMessageId: 'wamid.SENT' };
  },
  sendTenantWhatsAppVoiceNote: async () => ({ ok: false, error: 'not in this test' }),
}));

vi.mock('../src/services/notifications/whatsappNotifierService', () => ({
  __esModule: true,
  sendCallNudgeViaNotifier: async () => ({ ok: false, error: 'not in this test' }),
  initiateBusinessCall: async () => ({ ok: false, error: 'not in this test' }),
}));

// Office hours wide open — these tests are about tenancy, not the clock.
vi.mock('../src/services/behaviorConfig', () => ({
  __esModule: true,
  getBehaviorValue: async (key: string) =>
    key === 'notify.office_start_hour' ? 0
    : key === 'notify.office_end_hour' ? 24
    : key === 'notify.office_days_mask' ? 127
    : 25,
}));

vi.mock('../src/services/userTimezoneService', () => ({
  __esModule: true,
  resolveUserTimezone: async () => 'UTC',
  isValidTimezone: () => false,
}));

vi.mock('../src/services/whatsapp/sessionHistoryService', () => ({
  __esModule: true, appendBrainTurnToSession: async () => undefined,
}));
vi.mock('../src/services/knowledge/brainActionArtifactService', () => ({
  __esModule: true, recordArtifact: async () => undefined,
}));
vi.mock('../src/services/gmailService', () => ({
  __esModule: true, sendUserEmail: async () => ({ success: false, error: 'not in this test' }),
}));

import { brainContactsUser } from '../src/services/notifications/brainOutboundService';

const contentHash = (body: string) =>
  crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);

const seedMsg = (over: Record<string, any> = {}) => {
  const m = {
    id: nextMsgId++,
    clientNumber: B, userId: 2, kind: 'critical_bundle',
    channel: 'text', urgency: 'normal', summary: 'seed',
    dedupKey: null, status: 'sent', metadata: {},
    createdAt: new Date(),
    ...over,
  };
  messages.push(m);
  return m;
};

beforeEach(() => {
  users.length = 0; messages = []; delivered.length = 0; nextMsgId = 1; userQueries = [];
  users.push({
    id: 2, name: 'Owner A', email: null, clientNumber: A, isActive: true,
    contactNumber: '+920000000001',
    notificationPreferences: { brain_channel: { outboundEnabled: true } },
  });
});

describe('DEF-178/179 — the declared tenant constrains the query itself', () => {
  it("a foreign user id resolves to NO ROW — refused without the user ever being read", async () => {
    // User 2 exists and belongs to tenant A; the caller declares tenant B.
    const r = await brainContactsUser({
      userId: 2, clientNumber: B,
      kind: 'critical_bundle', summary: 's', body: 'should never leave',
    });
    expect(r.sent).toBe(false);
    // Wrong-tenant is indistinguishable from nonexistent — that is the point:
    // distinguishing them would require reading the foreign row.
    expect(r.reason).toBe('user_not_found');
    expect(delivered.length, 'nothing reaches the transport').toBe(0);
    expect(messages.length, 'no audit row on the tenant it failed to reach').toBe(0);
  });

  it('every user read on this path carries the tenant in the WHERE — none reads by bare id', async () => {
    await brainContactsUser({
      userId: 2, clientNumber: B,
      kind: 'critical_bundle', summary: 's', body: 'never',
    });
    await brainContactsUser({
      userId: 2, clientNumber: A,
      kind: 'critical_bundle', summary: 's', body: 'delivered fine',
    });
    expect(userQueries.length).toBeGreaterThan(0);
    for (const where of userQueries) {
      expect(where.clientNumber, `user query must be tenant-constrained, got WHERE ${JSON.stringify(where)}`)
        .toBeDefined();
    }
  });
});

describe("DEF-178 — another tenant's ledger rows influence nothing", () => {
  it('foreign daily-cap, dedup-key, content-hash and rate rows do not suppress this tenant', async () => {
    const body = 'the one real message';
    // Tenant B noise under the SAME userId: over the daily cap, a fresh
    // matching dedupKey, the identical content hash, and a fresh same-kind
    // row for the 60s rate limit. Every unscoped read would hit one of these.
    for (let i = 0; i < 25; i++) seedMsg();
    seedMsg({ dedupKey: 'k1' });
    seedMsg({ metadata: { contentHash: contentHash(body) } });

    const r = await brainContactsUser({
      userId: 2, clientNumber: A,
      kind: 'critical_bundle', summary: 's', body, dedupKey: 'k1',
    });
    expect(r.reason ?? '(none)').toBe('(none)');
    expect(r.sent, "tenant A's send proceeds as if B's ledger did not exist").toBe(true);
    expect(delivered.length).toBe(1);
    expect(delivered[0].clientNumber, 'delivered under the user\'s own tenant').toBe(A);
  });

  it("and the OWN tenant's ledger still suppresses — scoping is not breakage", async () => {
    seedMsg({ clientNumber: A, dedupKey: 'k2' });
    const r = await brainContactsUser({
      userId: 2, clientNumber: A,
      kind: 'critical_bundle', summary: 's', body: 'a different body', dedupKey: 'k2',
    });
    expect(r.sent).toBe(false);
    expect(String(r.reason)).toMatch(/^suppressed/);
    expect(delivered.length).toBe(0);
  });

  it('own-tenant daily cap still counts', async () => {
    for (let i = 0; i < 20; i++) seedMsg({ clientNumber: A, kind: `k${i}` });
    const r = await brainContactsUser({
      userId: 2, clientNumber: A,
      kind: 'critical_bundle', summary: 's', body: 'over the cap',
    });
    expect(r.sent).toBe(false);
    expect(String(r.reason)).toMatch(/^daily_cap_exceeded/);
    expect(delivered.length).toBe(0);
  });
});
