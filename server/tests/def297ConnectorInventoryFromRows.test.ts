/**
 * DEF-297 — deck tag: `Asked what connectors Brain has and got an incomplete
 * list that leaves out the channels actively delivering his data (Google Chat
 * is its most-processed channel yet was omitted)`.
 *
 * Owner, 08:36: *"Can u list down connectors u have"* → *"I can connect to
 * your Gmail, Google Calendar, and WhatsApp."* The model did not invent that
 * list — it summarised the only connector-shaped facts in its context: the
 * action truth-table names connectors only where an action needs one, and
 * `getLiveCapabilities` fetches EVERY user connector then discards the
 * non-action slugs. The read-side sources (gchat, gtasks, gdrive) were
 * invisible, so the connector question collapsed to the action set.
 *
 * The fix is this module's own standing rule (DEF-130/DEF-243): derive the
 * claim from rows. `connectorInventorySection` renders whatever
 * `user_connectors` holds — no slug list in code decides what "should" exist —
 * and both render paths (normal AND conservative) carry it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  connectors: [] as any[],
  connectorsThrow: false,
  notifierActive: false,
  registryThrows: false,
}));

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0, groupBy: async () => [],
  };
  const p: any = new Proxy(
    {
      userConnector: {
        findMany: async ({ where }: any) => {
          if (state.connectorsThrow) throw new Error('db down');
          // Tenant + user scope enforced by the mock, every test.
          expect(where.clientNumber).toBe('TMC-0001');
          expect(where.userId).toBe(2);
          return state.connectors;
        },
      },
      tenantWhatsappNotifier: {
        findUnique: async () => (state.notifierActive ? { isActive: true } : null),
      },
      feedEvent: { groupBy: async () => [] },
    },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/knowledge/actionRegistryService', () => ({
  __esModule: true,
  listActiveActions: async () => {
    if (state.registryThrows) throw new Error('registry down');
    return [];
  },
}));

import {
  connectorInventorySection,
  renderCapabilityBlockLive,
} from '../src/services/knowledge/brainCapabilityLive';

const row = (slug: string, name: string, status = 'connected') => ({
  status, connectorType: { slug, name },
});

beforeEach(() => {
  state.connectors = [];
  state.connectorsThrow = false;
  state.notifierActive = false;
  state.registryThrows = false;
});

describe('DEF-297 — the inventory is the rows, read-side sources included', () => {
  it('THE 08:36 SHAPE: google_chat and google_tasks appear beside the action connectors', async () => {
    state.connectors = [
      row('gmail', 'Gmail'), row('google_calendar', 'Google Calendar'),
      row('google_chat', 'Google Chat'), row('google_tasks', 'Google Tasks'),
      row('google_drive', 'Google Drive'),
    ];
    state.notifierActive = true;
    const out = await connectorInventorySection('TMC-0001', 2);
    // Mutation: filtering to action slugs (the pre-fix behaviour) dies on the
    // next three lines — these are exactly what the 08:36 answer omitted.
    expect(out).toContain('Google Chat (google_chat): connected');
    expect(out).toContain('Google Tasks (google_tasks): connected');
    expect(out).toContain('Google Drive (google_drive): connected');
    expect(out).toContain('Gmail (gmail): connected');
    expect(out).toContain('Tenant WhatsApp number');
  });

  it('an unhealthy connector is STATED with its status, never hidden', async () => {
    state.connectors = [row('gmail', 'Gmail', 'error')];
    const out = await connectorInventorySection('TMC-0001', 2);
    expect(out).toContain('NOT healthy (status: error)');
  });

  it('licenses the answer from THIS list and splits reading from acting', async () => {
    state.connectors = [row('google_chat', 'Google Chat')];
    const out = await connectorInventorySection('TMC-0001', 2);
    expect(out).toMatch(/answer from THIS list and nothing else/);
    expect(out).toMatch(/Reading and\s*acting are different sets/);
    expect(out).toMatch(/A\s*source not in this list is not connected: say so, never guess/);
  });

  it('no rows → the honest empty statement, never a recited list', async () => {
    const out = await connectorInventorySection('TMC-0001', 2);
    expect(out).toContain('no connector rows exist');
    expect(out).toMatch(/never recite a connector list from memory/);
  });

  it('a FAILED read is fail-closed — unreadable is not license (the DEF-243 rule)', async () => {
    state.connectorsThrow = true;
    const out = await connectorInventorySection('TMC-0001', 2);
    expect(out).toContain('unreadable right now');
    expect(out).toMatch(/Do not enumerate your connectors from memory/);
  });
});

describe('DEF-297 — both render paths carry the inventory', () => {
  it('the CONSERVATIVE block (registry down) still carries the inventory', async () => {
    // The conservative path renders precisely when discovery failed — when
    // reciting a connector list from memory would be most tempting.
    state.registryThrows = true;
    state.connectors = [row('google_chat', 'Google Chat')];
    const out = await renderCapabilityBlockLive('TMC-0001', 2);
    expect(out).toContain('Google Chat (google_chat): connected');
  });

  it('the empty-registry path carries it too', async () => {
    state.connectors = [row('google_tasks', 'Google Tasks')];
    const out = await renderCapabilityBlockLive('TMC-0001', 2);
    expect(out).toContain('Google Tasks (google_tasks): connected');
  });
});
