/**
 * DEF-353 — the pinned WhatsApp Web build expired on 2026-09-17 with nobody
 * told; every QR pairing after that was refused before Chrome started and the
 * owner discovered it by failing to re-pair (CL-059, 2026-10-26).
 *
 * The watch turns the expiry into a tenant-scoped health finding, graded by how
 * close the deadline is, and resolves it once the pin is rotated. Falsifier: a
 * pin within 14 days of expiry with no open finding.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  tenants: [{ client_number: 'TMC-0001' }] as Array<{ client_number: string }>,
  queries: [] as string[],
  findings: [] as any[],
  resolved: [] as any[],
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/db/prisma', () => {
  const p: any = {
    $queryRawUnsafe: async (sql: string) => { state.queries.push(sql); return state.tenants; },
  };
  return { __esModule: true, default: p, prisma: p };
});
vi.mock('../src/services/selfheal/healthFindingService', () => ({
  recordFinding: async (input: any) => { state.findings.push(input); return 'finding-id'; },
  resolveOpenFindings: async (input: any) => { state.resolved.push(input); return 1; },
}));

import { runWebjsPinExpiryWatch, WEBJS_PIN_EXPIRY_KIND } from '../src/services/selfheal/webjsPinExpiryReporter';

const DEFAULT_ENV = {} as NodeJS.ProcessEnv;
const expiredEnv = {
  WHATSAPP_WEBJS_WEB_VERSION: '2.3000.1043346688-alpha',
  WHATSAPP_WEBJS_WEB_CACHE_URL: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/d71af1f1094ace8354e0a0f0f5e9c32b67988f96/html/2.3000.1043346688-alpha.html',
  WHATSAPP_WEBJS_WEB_CACHE_SHA256: '80a55358cdd081b3e58eb4bf62434b9f8bd9802f569e10c53e48823cd8528fcf',
  WHATSAPP_WEBJS_WEB_CACHE_EXPIRES_AT: '2026-09-17T07:27:10.198Z',
} as NodeJS.ProcessEnv;

beforeEach(() => {
  state.tenants = [{ client_number: 'TMC-0001' }];
  state.queries.length = 0;
  state.findings.length = 0;
  state.resolved.length = 0;
});

describe('DEF-353 WhatsApp Web pin expiry watch', () => {
  it('the incident: an expired pin opens a CRITICAL finding for the WhatsApp tenant', async () => {
    const r = await runWebjsPinExpiryWatch({ env: expiredEnv, now: new Date('2026-10-26T04:25:43Z') });
    expect(r).toMatchObject({ state: 'expired', tenants: 1, recorded: 1, resolved: 0 });
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]).toMatchObject({
      clientNumber: 'TMC-0001',
      kind: WEBJS_PIN_EXPIRY_KIND,
      severity: 'critical',
      subjectId: 'webjs_version_pin',
    });
    expect(state.findings[0].summary).toMatch(/expired.*QR pairing is refused/);
  });

  it('announces BEFORE the deadline: warn at ≤14 days (digest), error at ≤3 days (immediate)', async () => {
    await runWebjsPinExpiryWatch({ env: DEFAULT_ENV, now: new Date('2026-12-13T00:00:00Z') });
    await runWebjsPinExpiryWatch({ env: DEFAULT_ENV, now: new Date('2026-12-24T00:00:00Z') });
    expect(state.findings.map((f) => f.severity)).toEqual(['warn', 'error']);
    expect(state.findings[0].summary).toMatch(/13 day\(s\) left/);
  });

  it('a healthy pin opens nothing and resolves any open finding (rotation closes the alarm)', async () => {
    const r = await runWebjsPinExpiryWatch({ env: DEFAULT_ENV, now: new Date('2026-10-26T05:00:00Z') });
    expect(r).toMatchObject({ state: 'ok', recorded: 0, resolved: 1 });
    expect(state.findings).toHaveLength(0);
    expect(state.resolved[0]).toMatchObject({
      clientNumber: 'TMC-0001', kind: WEBJS_PIN_EXPIRY_KIND, subjectId: 'webjs_version_pin',
    });
  });

  it('a half-configured env rotation is reported, never swallowed', async () => {
    const r = await runWebjsPinExpiryWatch({
      env: { WHATSAPP_WEBJS_WEB_VERSION: '2.3000.1-alpha' } as NodeJS.ProcessEnv,
      now: new Date('2026-10-26T05:00:00Z'),
    });
    expect(r.state).toBe('invalid');
    expect(state.findings[0]).toMatchObject({ severity: 'critical' });
    expect(state.findings[0].summary).toMatch(/invalid.*cannot start/);
  });

  it('is tenant-scoped: only active tenants with a WhatsApp config are touched', async () => {
    state.tenants = [{ client_number: 'TMC-0001' }, { client_number: 'TMC-0002' }];
    await runWebjsPinExpiryWatch({ env: expiredEnv, now: new Date('2026-10-26T04:25:43Z') });
    expect(state.findings.map((f) => f.clientNumber)).toEqual(['TMC-0001', 'TMC-0002']);
    expect(state.queries[0]).toMatch(/FROM whatsapp_config[\s\S]*JOIN tenants[\s\S]*is_active = true/);
  });
});
