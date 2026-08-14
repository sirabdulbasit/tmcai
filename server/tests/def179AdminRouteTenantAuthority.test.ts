/**
 * DEF-179 — tenant authority comes from the REQUESTER, never from the target
 * row (Codex iteration-53 CRITICAL).
 *
 * The DEF-178 version of the two admin messaging routes looked the target up
 * by bare id and passed back whatever tenant the row carried — so an
 * authenticated admin of tenant A holding a foreign `toUserId` had that
 * user's tenant laundered into an apparently valid declaration, and the
 * cross-tenant message proceeded. Type presence is not tenant authorization.
 *
 * These tests drive the REAL router over HTTP (supertest). The user store
 * honours every filter a query states — and records every WHERE — so the
 * central assertions are observable, not structural: a valid foreign
 * `toUserId` yields 404, no dispatch, and no user query that omits the
 * tenant ever runs.
 *
 * Mutants these tests kill:
 *   M1 — target looked up by bare id again (drop clientNumber from the
 *        route's findFirst): the foreign-id tests see a dispatch.
 *   M2 — allowedTenant taken from the body for a NON-SuperAdmin: the
 *        override-attempt test sees a dispatch under tenant B.
 *   M3 — allowedTenant discovered from the target row: same observables as
 *        M1 (the declaration would follow the target, not the requester).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const A = 'TMC-0001';
const B = 'OTHER-9';

const users = [
  { id: 2, clientNumber: A, isActive: true },
  { id: 9, clientNumber: B, isActive: true },
];
/** WHERE clause of every prisma.user query any code under test issued. */
let userQueries: any[] = [];

vi.mock('../src/db/prisma', () => {
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
    { user, $queryRawUnsafe: async () => [] },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

const dispatched: Array<{ userId: number; clientNumber: string; kind: string }> = [];
vi.mock('../src/services/notifications/brainOutboundService', () => ({
  __esModule: true,
  brainContactsUser: async (req: any) => {
    dispatched.push({ userId: req.userId, clientNumber: req.clientNumber, kind: req.kind });
    return { sent: true, channelsUsed: ['text'], waMessageIds: ['wamid.T'], recordId: '1' };
  },
}));

vi.mock('../src/services/notifications/whatsappNotifierService', () => ({
  __esModule: true,
  getNotifier: async () => null, saveNotifier: async () => ({}), pingNotifier: async () => ({ ok: true }),
  sendViaNotifier: async () => ({ ok: false }), sendVoiceNoteViaNotifier: async () => ({ ok: false }),
  sendCallNudgeViaNotifier: async () => ({ ok: false }), initiateBusinessCall: async () => ({ ok: false }),
}));

vi.mock('../src/services/whatsapp/whatsappNotifierConfigMirror', () => ({
  __esModule: true,
  mirrorNotifierCredentials: async () => undefined,
  storeMetaWebhookSecret: async () => undefined,
}));

import router from '../src/routes/admin/whatsappNotifierRoutes';

function appAs(user: Partial<{ id: number; clientNumber: string; userType: string; isSuperAdmin: boolean }>) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 2, clientNumber: A, userType: 'AD', isAdmin: true, isSuperAdmin: false, ...user };
    next();
  });
  app.use('/admin', router);
  return app;
}

beforeEach(() => { userQueries = []; dispatched.length = 0; });

const ROUTES = [
  { path: '/admin/whatsapp-notifier/test-brain', body: {} },
  { path: '/admin/nexeo-loop/notify', body: { summary: 's', body: 'b' } },
];

describe('DEF-179 — a valid foreign toUserId can be neither read nor messaged', () => {
  for (const r of ROUTES) {
    it(`${r.path}: tenant-A admin naming tenant-B's user gets 404, no dispatch, no bare-id read`, async () => {
      const res = await request(appAs({})).post(r.path).send({ ...r.body, toUserId: 9 });
      expect(res.status).toBe(404);
      expect(dispatched.length, 'nothing is messaged').toBe(0);
      expect(userQueries.length).toBeGreaterThan(0);
      for (const where of userQueries) {
        expect(where.clientNumber, `user query must be tenant-constrained, got WHERE ${JSON.stringify(where)}`)
          .toBeDefined();
      }
    });

    it(`${r.path}: a plain admin cannot widen authority by declaring a tenant in the body`, async () => {
      const res = await request(appAs({}))
        .post(r.path).send({ ...r.body, toUserId: 9, clientNumber: B });
      expect(res.status, 'the body declaration is ignored for non-SuperAdmin').toBe(404);
      expect(dispatched.length).toBe(0);
    });
  }

  it('own-tenant target still works — the constraint is not breakage', async () => {
    const res = await request(appAs({}))
      .post('/admin/nexeo-loop/notify').send({ toUserId: 2, summary: 's', body: 'b' });
    expect(res.status).toBe(200);
    expect(dispatched).toEqual([{ userId: 2, clientNumber: A, kind: 'nexeo_loop_report' }]);
  });

  it('a SuperAdmin may declare a tenant explicitly, and the target is queried UNDER it', async () => {
    const res = await request(appAs({ userType: 'SA', isSuperAdmin: true }))
      .post('/admin/nexeo-loop/notify').send({ toUserId: 9, clientNumber: B, summary: 's', body: 'b' });
    expect(res.status).toBe(200);
    expect(dispatched).toEqual([{ userId: 9, clientNumber: B, kind: 'nexeo_loop_report' }]);
    for (const where of userQueries) {
      expect(where.clientNumber).toBeDefined();
    }
  });

  it('a SuperAdmin who declares nothing stays inside their own tenant', async () => {
    const res = await request(appAs({ userType: 'SA', isSuperAdmin: true }))
      .post('/admin/nexeo-loop/notify').send({ toUserId: 9, summary: 's', body: 'b' });
    expect(res.status, 'no explicit declaration → own tenant → foreign id unreachable').toBe(404);
    expect(dispatched.length).toBe(0);
  });
});
