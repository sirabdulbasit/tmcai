/**
 * DEF-099/100/101 — steps 4 and 5: Brain fixes what it finds, and says so.
 *
 * Owner, 2026-08-07: *"someone acting on it mean brain should heal or upgrade
 * itself too without any my intervention"*, and *"will you inform me? how?"*.
 *
 * Until this, the loop stopped one step short: findings were recorded, scored
 * and visible — then sat in a table until a human opened a session. That is
 * `gapDetectionJob` with better plumbing; it has persisted "gap candidates for
 * admin review" for months and there has never been a reviewer.
 *
 * The assertions here defend the two properties that make the difference
 * between a self-healing system and one that merely claims to be:
 *
 *   1. Nothing is marked "told" or "notified" that was not CONFIRMED sent.
 *      Written is not delivered — the whole DEF-081 class, and it would be
 *      absurd to recreate it inside the mechanism built because of it.
 *   2. A repair that healed nothing must NOT report success. `verify` reads the
 *      exact rows the rule touched, never the rule's own intention.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const brainContactsUser = vi.hoisted(() => vi.fn());
const queryRawUnsafe = vi.hoisted(() => vi.fn());
const executeRawUnsafe = vi.hoisted(() => vi.fn());
const findingFindMany = vi.hoisted(() => vi.fn());
const findingUpdateMany = vi.hoisted(() => vi.fn());

vi.mock('../src/services/notifications/brainOutboundService', () => ({ brainContactsUser }));
vi.mock('../src/db/prisma', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafe,
    $executeRawUnsafe: executeRawUnsafe,
    brainHealthFinding: { findMany: findingFindMany, updateMany: findingUpdateMany },
  },
}));

import { REPAIR_RULES } from '../src/services/selfheal/repairService';
import { notifySevereFindings } from '../src/services/selfheal/findingNotifier';

const rule = (id: string) => {
  const r = REPAIR_RULES.find((x) => x.id === id);
  if (!r) throw new Error(`repair rule ${id} not registered`);
  return r;
};

beforeEach(() => {
  brainContactsUser.mockReset();
  queryRawUnsafe.mockReset();
  executeRawUnsafe.mockReset();
  findingFindMany.mockReset();
  findingUpdateMany.mockReset();
  findingUpdateMany.mockResolvedValue({ count: 1 });
});

describe('DEF-099 — an answered ask the owner was never told about', () => {
  const r = () => rule('unnotified_answered_ask');

  it('is registered as a tenant-scoped rule', () => {
    expect(r().scope).toBe('tenant');
  });

  it('detects nothing when no tenant is in context — never scans across tenants', async () => {
    expect(await r().detect({})).toBeNull();
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('stamps owner_notified_at ONLY after a confirmed send', async () => {
    // The heart of it. Stamping on attempt would mean an ask marked "told"
    // that the owner never saw — DEF-081 recreated inside its own fix.
    brainContactsUser.mockResolvedValue({ sent: true });
    executeRawUnsafe.mockResolvedValue(1);
    const out = await r().apply(
      { clientNumber: 'TMC-0001' },
      { summary: '1', before: { rows: [{ id: 'th_1', owner_user_id: 2, title: 'Portal testing' }] } },
    );
    expect(out.notifiedThreadIds).toEqual(['th_1']);
    expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(String(executeRawUnsafe.mock.calls[0][0])).toContain('owner_notified_at = NOW()');
  });

  it('does NOT stamp when the send failed', async () => {
    brainContactsUser.mockResolvedValue({ sent: false, reason: 'quiet_hours' });
    const out = await r().apply(
      { clientNumber: 'TMC-0001' },
      { summary: '1', before: { rows: [{ id: 'th_1', owner_user_id: 2, title: null }] } },
    );
    expect(out.notifiedThreadIds).toEqual([]);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('stamps only the threads that sent, in a partial batch', async () => {
    brainContactsUser
      .mockResolvedValueOnce({ sent: true })
      .mockResolvedValueOnce({ sent: false });
    executeRawUnsafe.mockResolvedValue(1);
    const out = await r().apply(
      { clientNumber: 'TMC-0001' },
      { summary: '2', before: { rows: [
        { id: 'th_1', owner_user_id: 2, title: 'A' },
        { id: 'th_2', owner_user_id: 2, title: 'B' },
      ] } },
    );
    expect(out.notifiedThreadIds).toEqual(['th_1']);
  });

  it('reports NOT healed when it told nobody', async () => {
    // A rule that notified no one has repaired nothing, whatever the DB says.
    expect(await r().verify({ clientNumber: 'TMC-0001' }, { summary: '', before: {} }, { notifiedThreadIds: [] })).toBe(false);
  });

  it('verifies the EXACT threads it touched, not a general count', async () => {
    queryRawUnsafe.mockResolvedValue([{ n: 0 }]);
    const ok = await r().verify({ clientNumber: 'TMC-0001' }, { summary: '', before: {} }, { notifiedThreadIds: ['th_1'] });
    expect(ok).toBe(true);
    expect(queryRawUnsafe.mock.calls[0][2]).toEqual(['th_1']);
  });

  it('reports NOT healed if a stamped thread is somehow still unnotified', async () => {
    queryRawUnsafe.mockResolvedValue([{ n: 1 }]);
    expect(await r().verify({ clientNumber: 'TMC-0001' }, { summary: '', before: {} }, { notifiedThreadIds: ['th_1'] })).toBe(false);
  });
});

describe('DEF-100 — a question queued and never asked', () => {
  const r = () => rule('stuck_queued_prompt');

  it('is registered and tenant-scoped', () => {
    expect(r().scope).toBe('tenant');
  });

  it('reports NOT healed when nothing was claimed', async () => {
    expect(await r().verify({ clientNumber: 'TMC-0001' }, { summary: '', before: {} }, { promptIds: [] })).toBe(false);
  });

  it('counts it healed only when a prompt actually left the queue', async () => {
    queryRawUnsafe.mockResolvedValue([{ n: 0 }]);   // none still queued
    expect(await r().verify({ clientNumber: 'TMC-0001' }, { summary: '', before: {} }, { promptIds: ['283', '290'] })).toBe(true);
  });

  it('reports NOT healed when every prompt is still stuck', async () => {
    queryRawUnsafe.mockResolvedValue([{ n: 2 }]);   // both still queued
    expect(await r().verify({ clientNumber: 'TMC-0001' }, { summary: '', before: {} }, { promptIds: ['283', '290'] })).toBe(false);
  });
});

describe('DEF-101 — Brain reports what it found, without becoming noise', () => {
  const finding = (id: string, severity: string, userId: number | null = 2) => ({
    id, severity, userId, summary: `problem ${id}`,
  });

  it('sends nothing when there is nothing severe', async () => {
    findingFindMany.mockResolvedValue([finding('f1', 'warn')]);
    const out = await notifySevereFindings('TMC-0001');
    expect(out.sent).toBe(0);
    expect(brainContactsUser).not.toHaveBeenCalled();
  });

  it('batches many findings into ONE message per user', async () => {
    // Three WhatsApps about the same bad ten minutes is how a person learns to
    // ignore the channel entirely.
    findingFindMany.mockResolvedValue([
      finding('f1', 'error'), finding('f2', 'error'), finding('f3', 'critical'),
    ]);
    brainContactsUser.mockResolvedValue({ sent: true });
    const out = await notifySevereFindings('TMC-0001');
    expect(brainContactsUser).toHaveBeenCalledTimes(1);
    expect(out.findings).toBe(3);
  });

  it('marks findings notified ONLY after a confirmed send', async () => {
    findingFindMany.mockResolvedValue([finding('f1', 'error')]);
    brainContactsUser.mockResolvedValue({ sent: false, reason: 'quiet_hours' });
    const out = await notifySevereFindings('TMC-0001');
    expect(out.sent).toBe(0);
    expect(findingUpdateMany).not.toHaveBeenCalled();
  });

  it('skips findings with no owning user rather than guessing one', async () => {
    // No global "the owner" (owner instruction, 2026-08-07). An unattributable
    // finding is not sent to whoever happens to be first.
    findingFindMany.mockResolvedValue([finding('f1', 'error', null)]);
    const out = await notifySevereFindings('TMC-0001');
    expect(brainContactsUser).not.toHaveBeenCalled();
    expect(out.sent).toBe(0);
  });

  it('never throws when the send path is broken', async () => {
    findingFindMany.mockResolvedValue([finding('f1', 'error')]);
    brainContactsUser.mockImplementationOnce(() => Promise.reject(new Error('wa down')));
    await expect(notifySevereFindings('TMC-0001')).resolves.toEqual({ sent: 0, findings: 0 });
  });
});
