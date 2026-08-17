/**
 * DEF-207 — the SYSTEM bucket had a writer and no reader.
 *
 * DEF-085 gave Brain rung 1 of the Self-Healing ladder: a repeating raw-query
 * failure becomes a health finding without a human asking. Codex's iteration-2
 * review named what that stopped short of: *"tenant-less raw-query findings
 * remain operationally orphaned under GLOBAL and null user … it prevents the
 * claimed detection from feeding the next decision/notification path."*
 *
 * The evidence was arithmetic rather than arguable. `runFindingNotifyPass`
 * enumerates `prisma.tenant` rows; `GLOBAL` is not a tenant row; `openFindings`
 * and `unnotifiedFindings` both REQUIRE a clientNumber. A background timer has
 * no tenant context, so its failures were filed where nothing ever looked.
 *
 * These assertions pin the three properties that make the difference between a
 * bucket that is consumed and one that merely exists:
 *
 *   1. The writer and the reader agree on the scope — by CONSTANT, not by two
 *      copies of the same magic string. That is how the bucket got orphaned.
 *   2. A tenant read never silently includes system rows. Separate reader on
 *      purpose: one tenant's health page must not show another's infrastructure.
 *   3. The pass READS the bucket even when there are no tenants and no digest
 *      due — a quiet box is exactly when an unread bucket stays unread — and it
 *      notifies NOBODY, because there is no owner for a system fault and
 *      inventing one is the fabricated attribution the reporter refuses to make.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const tenantFindMany = vi.hoisted(() => vi.fn());
const userFindMany = vi.hoisted(() => vi.fn());
const findingFindMany = vi.hoisted(() => vi.fn());
const brainContactsUser = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('../src/services/notifications/brainOutboundService', () => ({ brainContactsUser }));
vi.mock('../src/utils/logger', () => ({
  default: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../src/db/prisma', () => ({
  default: {
    tenant: { findMany: tenantFindMany },
    user: { findMany: userFindMany },
    brainHealthFinding: { findMany: findingFindMany, updateMany: vi.fn() },
  },
}));

import { runFindingNotifyPass } from '../src/services/selfheal/findingNotifier';
import {
  SYSTEM_SCOPE,
  systemFindings,
  openFindings,
} from '../src/services/selfheal/healthFindingService';

const finding = (over: Record<string, unknown> = {}) => ({
  id: 1,
  clientNumber: SYSTEM_SCOPE,
  kind: 'raw_query_failed',
  severity: 'error',
  status: 'open',
  occurrences: 3,
  lastSeenAt: new Date('2026-08-17T09:00:00Z'),
  ...over,
});

beforeEach(() => {
  tenantFindMany.mockReset();
  userFindMany.mockReset();
  findingFindMany.mockReset();
  brainContactsUser.mockReset();
  warn.mockReset();
  tenantFindMany.mockResolvedValue([]);
  userFindMany.mockResolvedValue([]);
  findingFindMany.mockResolvedValue([]);
});

describe('DEF-207 — writer and reader agree on ONE scope', () => {
  it('exports the scope as a constant rather than leaving it a magic string', () => {
    expect(SYSTEM_SCOPE).toBe('GLOBAL');
  });

  it('the writer imports that constant instead of re-typing the literal', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/services/selfheal/rawQueryFindingReporter.ts'),
      'utf8',
    );
    // Comments are stripped first: a guard must read code, not prose about it
    // (DEF-195). A doc comment mentioning 'GLOBAL' must not satisfy this.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toMatch(/import\s*\{[^}]*SYSTEM_SCOPE[^}]*\}\s*from\s*'\.\/healthFindingService'/);
    expect(code).toMatch(/clientNumber:\s*scope\?\.clientNumber\s*\?\?\s*SYSTEM_SCOPE/);
    expect(code).not.toMatch(/clientNumber:[^\n]*'GLOBAL'/);
  });

  it('reads the system bucket by that constant, open rows only', async () => {
    findingFindMany.mockResolvedValue([finding()]);
    await systemFindings(50);
    const where = findingFindMany.mock.calls[0][0].where;
    expect(where.clientNumber).toBe(SYSTEM_SCOPE);
    expect(where.status).toBe('open');
  });

  it('honours the limit it is given — an unbounded read of a flooding bucket is its own outage', async () => {
    await systemFindings(7);
    expect(findingFindMany.mock.calls[0][0].take).toBe(7);
  });
});

describe('DEF-207 — a tenant read never silently includes system rows', () => {
  it('scopes openFindings to the tenant, not to the tenant OR the system bucket', async () => {
    await openFindings('92300', 10);
    const where = findingFindMany.mock.calls[0][0].where;
    expect(where.clientNumber).toBe('92300');
    // The whole point of a separate reader: no OR, no IN, no array.
    expect(JSON.stringify(where)).not.toContain(SYSTEM_SCOPE);
  });
});

describe('DEF-207 — the pass consumes the bucket', () => {
  it('reads system findings even with zero tenants and no digest due', async () => {
    tenantFindMany.mockResolvedValue([]);
    findingFindMany.mockResolvedValue([finding(), finding({ id: 2, occurrences: 1 })]);

    // hour 99 can never equal the computed PKT hour, so no digest path runs.
    const r = await runFindingNotifyPass(99);

    expect(r.systemOpen).toBe(2);
    expect(findingFindMany).toHaveBeenCalled();
    expect(findingFindMany.mock.calls.some((c) => c[0]?.where?.clientNumber === SYSTEM_SCOPE)).toBe(true);
  });

  it('notifies NOBODY about a system fault — there is no owner to attribute it to', async () => {
    findingFindMany.mockResolvedValue([finding()]);
    await runFindingNotifyPass(99);
    expect(brainContactsUser).not.toHaveBeenCalled();
  });

  it('reports it on the operator surface instead, with occurrences summed per kind', async () => {
    findingFindMany.mockResolvedValue([
      finding({ id: 1, kind: 'raw_query_failed', occurrences: 3 }),
      finding({ id: 2, kind: 'raw_query_failed', occurrences: 4 }),
      finding({ id: 3, kind: 'job_stalled', occurrences: 2 }),
    ]);

    await runFindingNotifyPass(99);

    const call = warn.mock.calls.find((c) => /SYSTEM-scope/.test(String(c[0])));
    expect(call).toBeTruthy();
    expect(call![1].open).toBe(3);
    const kinds = call![1].kinds as Array<{ kind: string; occurrences: number }>;
    // Summed, not counted: three rows, two kinds, 3+4 occurrences on the first.
    expect(kinds.find((k) => k.kind === 'raw_query_failed')!.occurrences).toBe(7);
    expect(kinds.find((k) => k.kind === 'job_stalled')!.occurrences).toBe(2);
  });

  it('stays silent when the bucket is empty — an all-clear every hour is noise, not a heartbeat', async () => {
    findingFindMany.mockResolvedValue([]);
    const r = await runFindingNotifyPass(99);
    expect(r.systemOpen).toBe(0);
    expect(warn.mock.calls.filter((c) => /SYSTEM-scope/.test(String(c[0])))).toHaveLength(0);
  });

  it('a failing system read does NOT break the pass it monitors', async () => {
    findingFindMany.mockRejectedValue(new Error('relation does not exist'));
    const r = await runFindingNotifyPass(99);
    expect(r.systemOpen).toBe(0);
    expect(warn.mock.calls.some((c) => /system-scope finding read failed/.test(String(c[0])))).toBe(true);
  });
});

describe('DEF-207 — the count reaches an operator, not just the return value', () => {
  it('server.ts logs systemOpen and puts it IN the condition', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const line = code.split('\n').find((l) => l.includes('[findingNotify]'));
    expect(line).toBeTruthy();
    expect(line).toContain('systemOpen=');
    // Gated behind alerts/digests it would be invisible on a quiet box — which
    // is precisely the unread bucket again, one layer up.
    const guard = code.split('\n').find((l) => /if \(r\.alerts \|\| r\.digests/.test(l));
    expect(guard).toContain('r.systemOpen');
  });
});
