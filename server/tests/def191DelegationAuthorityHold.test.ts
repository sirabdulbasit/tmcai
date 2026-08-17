/**
 * DEF-191 / DEF-192 — the delegation follow-up job cannot act, or speak in the
 * owner's name, outside the tenant it is working for.
 *
 * DEF-191 (Codex iteration-4 claim 3): this job MUTATES and SENDS in the
 * owner's name, so its settings read carries explicit authority — a
 * (tenant, user) pair with NO user row behind it HOLDS the item rather than
 * chasing under fabricated default preferences.
 *
 * DEF-192 (Codex iteration-4 carried CRITICAL, live at `e356d42`): the tenant
 * is now the ENTRY POINT. `runDelegationFollowUp` reads only the tenant
 * REGISTRY and delegates to `runDelegationFollowUpForTenant(clientNumber)`,
 * which carries that tenant into every query — the item scan, the owner
 * identity that becomes the From-name of an outbound email, and every
 * mutation (scoped `updateMany`, affected-row count checked).
 *
 * The prisma mock honours every stated filter against an in-memory table, so
 * dropping `clientNumber` from any query or write turns these tests red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    items: [] as any[],
    tenants: [] as string[],
    /** Users the registry/identity lookup can see, by (tenant, id). */
    users: [] as Array<{ id: number; clientNumber: string; name: string; email: string }>,
    /** updateMany targeting one of these ids reports zero rows changed. */
    vanishIds: new Set<string>(),
  };

  function matches(row: any, where: any): boolean {
    if (!where) return true;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.clientNumber !== undefined && row.clientNumber !== where.clientNumber) return false;
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.type !== undefined && row.type !== where.type) return false;
    if (where.delegateeEmail?.not === null && row.delegateeEmail == null) return false;
    return true;
  }

  const itemFindMany = vi.fn(async (args: any) => {
    let rows = state.items.filter((i) => matches(i, args?.where));
    if (args?.orderBy?.updatedAt === 'asc') {
      rows = [...rows].sort((x, y) => +new Date(x.updatedAt) - +new Date(y.updatedAt));
    }
    if (args?.take) rows = rows.slice(0, args.take);
    return rows.map((r) => ({ ...r }));
  });

  const itemUpdateMany = vi.fn(async (args: any) => {
    const targets = state.items
      .filter((i) => matches(i, args?.where))
      .filter((i) => !state.vanishIds.has(i.id));
    for (const t of targets) Object.assign(t, args.data);
    return { count: targets.length };
  });

  const userFindMany = vi.fn(async (args: any) => {
    // The tenant registry read: distinct clientNumber over active users.
    let tenants = [...state.tenants];
    if (args?.orderBy?.clientNumber === 'asc') tenants.sort();
    return tenants.map((clientNumber) => ({ clientNumber }));
  });

  const userFindFirst = vi.fn(async (args: any) => {
    const u = state.users.find(
      (x) => x.id === args?.where?.id && x.clientNumber === args?.where?.clientNumber,
    );
    return u ? { name: u.name, email: u.email } : null;
  });

  return {
    state,
    itemFindMany,
    itemUpdateMany,
    userFindMany,
    userFindFirst,
    agentActionCreate: vi.fn(),
    resolveOpenItemsSettings: vi.fn(),
    decideChaseVerdict: vi.fn(),
    composeChaseEmail: vi.fn(),
    sendUserEmail: vi.fn(),
  };
});

vi.mock('../src/db/prisma', () => ({
  default: {
    openItem: { findMany: mocks.itemFindMany, updateMany: mocks.itemUpdateMany },
    user: { findMany: mocks.userFindMany, findFirst: mocks.userFindFirst },
    agentAction: { create: mocks.agentActionCreate },
  },
}));

vi.mock('../src/services/openItems/openItemsSettings', () => ({
  resolveOpenItemsSettings: mocks.resolveOpenItemsSettings,
}));

// `getUserNameAndEmail` is the REAL implementation (it is the thing under test
// for DEF-192's identity boundary); only its Prisma is substituted, above.
vi.mock('../src/services/delegation/smartChaseService', async () => {
  const real = await vi.importActual<any>('../src/services/delegation/smartChaseService');
  return {
    getUserNameAndEmail: real.getUserNameAndEmail,
    decideChaseVerdict: mocks.decideChaseVerdict,
    composeChaseEmail: mocks.composeChaseEmail,
  };
});

vi.mock('../src/services/gmailService', () => ({
  sendUserEmail: mocks.sendUserEmail,
}));

vi.mock('../src/utils/logger', () => ({
  default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  runDelegationFollowUp,
  runDelegationFollowUpForTenant,
} from '../src/jobs/delegationFollowUpJob';

function delegatedItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del-1',
    title: 'ShireMe portal testing',
    description: 'Portal application testing',
    status: 'DELEGATED',
    type: 'delegation',
    priority: 'medium',
    dueDate: null,
    delegateeEmail: 'hamna@example.com',
    delegateeName: 'Hamna',
    notes: [],
    metadata: { followUp: { count: 0, maxFollowUps: 3 } },
    createdAt: new Date(Date.now() - 7 * 86_400_000),
    updatedAt: new Date(Date.now() - 7 * 86_400_000),
    userId: 7,
    clientNumber: 'tenant-1',
    ...overrides,
  };
}

/** DEF-192 query-shape sweep: no openItem read or write lacks its tenant. */
function assertEveryItemQueryTenantScoped() {
  expect(mocks.itemFindMany.mock.calls.length).toBeGreaterThan(0);
  for (const [args] of mocks.itemFindMany.mock.calls) {
    expect(args.where?.clientNumber, `unscoped item read: ${JSON.stringify(args.where)}`).toBeDefined();
  }
  for (const [args] of mocks.itemUpdateMany.mock.calls) {
    expect(args.where?.clientNumber, `unscoped item write: ${JSON.stringify(args.where)}`).toBeDefined();
    expect(args.where?.userId, `write without user scope: ${JSON.stringify(args.where)}`).toBeDefined();
    expect(args.where?.id, `write without id: ${JSON.stringify(args.where)}`).toBeDefined();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.items = [];
  mocks.state.tenants = [];
  mocks.state.users = [{ id: 7, clientNumber: 'tenant-1', name: 'Basit', email: 'basit@example.com' }];
  mocks.state.vanishIds.clear();
  mocks.agentActionCreate.mockResolvedValue({});
  mocks.resolveOpenItemsSettings.mockResolvedValue({ authority: 'found', value: { followUpDays: 3 } });
  mocks.decideChaseVerdict.mockResolvedValue({ verdict: 'hold', reason: 'not due (test)' });
  mocks.composeChaseEmail.mockResolvedValue({ subject: 'Re: ShireMe', body: 'body', toneSamplesUsed: 2 });
  mocks.sendUserEmail.mockResolvedValue({ success: true, messageId: 'gmail-1' });
});

describe('DEF-191 — delegation follow-up holds without settings authority', () => {
  it('a no_user pair is HELD: no verdict is even asked for, and nothing is sent', async () => {
    mocks.resolveOpenItemsSettings.mockResolvedValue({ authority: 'no_user', value: null });
    mocks.state.items = [delegatedItem()];

    const summary = await runDelegationFollowUpForTenant('tenant-1');

    expect(summary.held).toBe(1);
    expect(summary.sent).toBe(0);
    expect(summary.errors).toBe(0);
    expect(mocks.decideChaseVerdict, 'no chase decision under fabricated authority').not.toHaveBeenCalled();
    expect(mocks.composeChaseEmail).not.toHaveBeenCalled();
    expect(mocks.sendUserEmail).not.toHaveBeenCalled();
  });

  it('a confirmed pair proceeds with HIS followUpDays, resolved under the item’s tenant', async () => {
    mocks.resolveOpenItemsSettings.mockResolvedValue({ authority: 'found', value: { followUpDays: 5 } });
    mocks.state.items = [delegatedItem()];

    await runDelegationFollowUpForTenant('tenant-1');

    expect(mocks.resolveOpenItemsSettings).toHaveBeenCalledWith(7, 'tenant-1');
    expect(mocks.decideChaseVerdict).toHaveBeenCalledTimes(1);
    expect(mocks.decideChaseVerdict.mock.calls[0][0].followUpDaysBaseline).toBe(5);
    expect(mocks.decideChaseVerdict.mock.calls[0][2], 'the verdict is asked under the item’s tenant')
      .toBe('tenant-1');
  });

  it('a thrown settings read is an error for that item, not a chase', async () => {
    mocks.resolveOpenItemsSettings.mockRejectedValue(new Error('settings db down'));
    mocks.state.items = [delegatedItem()];

    const summary = await runDelegationFollowUpForTenant('tenant-1');

    expect(summary.errors).toBe(1);
    expect(mocks.decideChaseVerdict).not.toHaveBeenCalled();
    expect(mocks.sendUserEmail).not.toHaveBeenCalled();
  });
});

describe('DEF-192 — the tenant is the entry point, and identity is proven inside it', () => {
  it('the sweep reads the tenant REGISTRY and works each tenant separately — never one global item scan', async () => {
    mocks.state.tenants = ['tenant-2', 'tenant-1']; // returned unsorted on purpose
    mocks.state.users = [
      { id: 7, clientNumber: 'tenant-1', name: 'Basit', email: 'basit@example.com' },
      { id: 7, clientNumber: 'tenant-2', name: 'Other Owner', email: 'other@example.com' },
    ];
    mocks.state.items = [
      delegatedItem({ id: 'a1', clientNumber: 'tenant-1' }),
      delegatedItem({ id: 'b1', clientNumber: 'tenant-2' }), // same userId 7
    ];

    const summary = await runDelegationFollowUp();

    expect(summary.scanned).toBe(2);
    const scannedTenants = mocks.itemFindMany.mock.calls.map(([a]: any[]) => a.where.clientNumber);
    expect(scannedTenants, 'one scan per tenant, in deterministic order')
      .toEqual(['tenant-1', 'tenant-2']);
    expect(mocks.resolveOpenItemsSettings).toHaveBeenCalledWith(7, 'tenant-1');
    expect(mocks.resolveOpenItemsSettings).toHaveBeenCalledWith(7, 'tenant-2');
    assertEveryItemQueryTenantScoped();
  });

  it('one tenant’s failure does not stop the next tenant', async () => {
    mocks.state.tenants = ['tenant-1', 'tenant-2'];
    mocks.state.users = [
      { id: 7, clientNumber: 'tenant-1', name: 'Basit', email: 'basit@example.com' },
      { id: 7, clientNumber: 'tenant-2', name: 'Other Owner', email: 'other@example.com' },
    ];
    mocks.state.items = [
      delegatedItem({ id: 'a1', clientNumber: 'tenant-1' }),
      delegatedItem({ id: 'b1', clientNumber: 'tenant-2' }),
    ];
    mocks.resolveOpenItemsSettings.mockImplementation(async (_u: number, cn: string) => {
      if (cn === 'tenant-1') throw new Error('tenant-1 settings down');
      return { authority: 'found', value: { followUpDays: 3 } };
    });

    const summary = await runDelegationFollowUp();

    expect(summary.errors).toBe(1);
    expect(mocks.decideChaseVerdict, 'tenant-2 was still processed').toHaveBeenCalledTimes(1);
    expect(mocks.decideChaseVerdict.mock.calls[0][2]).toBe('tenant-2');
  });

  it('an item whose owner does not exist IN THAT TENANT is never chased — identity is not borrowed', async () => {
    // The user row exists, but under tenant-1 only; the item claims tenant-2.
    mocks.state.items = [delegatedItem({ clientNumber: 'tenant-2' })];

    const summary = await runDelegationFollowUpForTenant('tenant-2');

    expect(summary.errors).toBe(1);
    expect(summary.sent).toBe(0);
    expect(mocks.userFindFirst).toHaveBeenCalledWith({
      where: { id: 7, clientNumber: 'tenant-2' },
      select: { name: true, email: true },
    });
    expect(mocks.composeChaseEmail, 'nothing is composed in a name we could not read').not.toHaveBeenCalled();
    expect(mocks.sendUserEmail).not.toHaveBeenCalled();
  });

  it('a chase composes with the identity resolved inside the tenant, and every write is scoped', async () => {
    mocks.decideChaseVerdict.mockResolvedValue({ verdict: 'chase', reason: 'overdue (test)' });
    mocks.state.items = [delegatedItem()];

    const summary = await runDelegationFollowUpForTenant('tenant-1');

    expect(summary.sent).toBe(1);
    expect(summary.errors).toBe(0);
    expect(mocks.composeChaseEmail.mock.calls[0][0].userName).toBe('Basit');
    expect(mocks.composeChaseEmail.mock.calls[0][0].clientNumber).toBe('tenant-1');
    const row = mocks.state.items[0];
    expect(row.metadata.followUp.count, 'bookkeeping landed').toBe(1);
    expect(row.metadata.followUp.lastMessageId).toBe('gmail-1');
    assertEveryItemQueryTenantScoped();
  });

  it('a mark_stale whose scoped write matches nothing is an error, not a recorded outcome', async () => {
    mocks.decideChaseVerdict.mockResolvedValue({ verdict: 'mark_stale', reason: 'dead (test)' });
    mocks.state.items = [delegatedItem()];
    mocks.state.vanishIds.add('del-1'); // the row moved under us

    const summary = await runDelegationFollowUpForTenant('tenant-1');

    expect(summary.marked_stale, 'nothing is claimed that the write did not do').toBe(0);
    expect(summary.errors).toBe(1);
    expect(mocks.agentActionCreate, 'no audit row for an outcome that did not happen').not.toHaveBeenCalled();
    expect(mocks.state.items[0].metadata.stale).toBeUndefined();
  });

  it('an escalation whose scoped write matches nothing is an error, not an escalation', async () => {
    mocks.decideChaseVerdict.mockResolvedValue({ verdict: 'escalate', reason: 'max attempts (test)' });
    mocks.state.items = [delegatedItem()];
    mocks.state.vanishIds.add('del-1');

    const summary = await runDelegationFollowUpForTenant('tenant-1');

    expect(summary.escalated).toBe(0);
    expect(summary.errors).toBe(1);
    expect(mocks.agentActionCreate).not.toHaveBeenCalled();
    expect(mocks.state.items[0].priority).toBe('medium');
  });

  it('a chase whose bookkeeping write fails still counts as SENT — the email left — but is loudly an error too', async () => {
    mocks.decideChaseVerdict.mockResolvedValue({ verdict: 'chase', reason: 'overdue (test)' });
    mocks.state.items = [delegatedItem()];
    mocks.state.vanishIds.add('del-1');

    const summary = await runDelegationFollowUpForTenant('tenant-1');

    expect(mocks.sendUserEmail).toHaveBeenCalledTimes(1);
    expect(summary.sent, 'the send is a fact and is not denied').toBe(1);
    expect(summary.errors, 'the lost bookkeeping is visible').toBe(1);
  });
});
