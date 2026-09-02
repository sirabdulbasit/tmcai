/**
 * DEF-281 — the owner was locked out of closing his own item.
 *
 * CL-047, 2026-09-02 14:58. He quote-replied *"Done"* to a prompt whose own words offered to
 * mark the item done, and got: *"Actually, it looks like that still needs approval before it can
 * be closed."* He asked the obvious question — *"which approval?"* — and Brain word-matched the
 * term against two unrelated items titled "Approve new team members" and asked which one he
 * meant.
 *
 * The mechanism: `{ from: 'NEW', to: 'CLOSED', requiresApproval: true }` exists so an AGENT
 * cannot close an untriaged item unilaterally, and `recordActionLifecycleReply` called
 * `transitionStatus` with `actor: 'agent:action_lifecycle'` and no `approvalId` **for every
 * source**. So `lifecycleService` rejected it with `approval required` — correctly, for an
 * agent — and the refusal reached the owner as a business fact he could act on. He could not:
 * he IS the approving authority, no approver was named, and nothing in the product could grant
 * it.
 *
 * An explicit instruction from the owner now supplies the approval and records who gave it.
 * The test that matters is the last one: a DELEGATEE's completion must still require him.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const transitionStatus = vi.fn();
const findFirst = vi.fn();
const update = vi.fn();

vi.mock('../src/services/itemLifecycle/lifecycleService', () => ({
  transitionStatus: (...a: any[]) => transitionStatus(...a),
}));
vi.mock('../src/db/prisma', () => ({
  default: {
    openItem: { findFirst: (...a: any[]) => findFirst(...a), update: (...a: any[]) => update(...a) },
    feedEvent: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));
vi.mock('../src/services/llmRouter', () => ({ callLLM: vi.fn(async () => ({ text: '' })) }));

import { recordActionLifecycleReply } from '../src/services/openItems/actionLifecycleService';

const ITEM = {
  id: 'item_indrive', clientNumber: 'TMC-0001', userId: 2, ownerId: 2,
  title: 'Attend: TMC <> InDrive technical integration kickoff',
  status: 'NEW', metadata: {}, dueDate: new Date('2026-09-01'),
  delegateeName: null, delegateeEmail: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(ITEM);
  update.mockResolvedValue(ITEM);
  transitionStatus.mockResolvedValue({ ok: true, from: 'NEW', to: 'CLOSED' });
});

const reply = (source: any, body = 'Done') => recordActionLifecycleReply({
  openItemId: ITEM.id, clientNumber: 'TMC-0001', body, source, sourceId: 'prompt:490',
} as any);

describe('DEF-281 — the owner can close his own item by saying so', () => {
  it('supplies the approval when the OWNER reports completion', async () => {
    await reply('user');
    expect(transitionStatus).toHaveBeenCalledTimes(1);
    const ctx = transitionStatus.mock.calls[0][2];
    expect(ctx.approvalId).toBe(2);              // the approving user
    expect(ctx.actor).toBe('user:2');            // not agent:action_lifecycle
  });

  it('records WHO approved and which instruction did it', async () => {
    // `approvalId` is only a presence token — the audit trail has to be in the persisted fields.
    await reply('user');
    const ctx = transitionStatus.mock.calls[0][2];
    expect(String(ctx.reason)).toContain('Owner reported completion');
    expect(String(ctx.reason)).toContain('prompt:490');
    expect(ctx.metadata.approvedBy).toBe('user:2');
  });

  it('treats a reply typed in chat the same as one over WhatsApp to Brain', async () => {
    await reply('chat');
    expect(transitionStatus.mock.calls[0][2].approvalId).toBe(2);
  });

  it('THE SAFETY PROPERTY: a DELEGATEE\'s completion still requires the owner', async () => {
    // This is the case the guard was written for and it must not move. A delegatee saying "done"
    // over WhatsApp cannot close an untriaged item on its own — that would hand anyone who can
    // message Brain the authority to close the owner's work.
    for (const source of ['whatsapp', 'email']) {
      vi.clearAllMocks();
      findFirst.mockResolvedValue(ITEM);
      update.mockResolvedValue(ITEM);
      transitionStatus.mockResolvedValue({ ok: false, approvalRequired: true, from: 'NEW', to: 'CLOSED' });
      await reply(source);
      const ctx = transitionStatus.mock.calls[0][2];
      expect(ctx.approvalId, source).toBeUndefined();
      expect(ctx.actor, source).toBe('agent:action_lifecycle');
      expect(ctx.metadata.approvedBy, source).toBeNull();
    }
  });
});
