/**
 * DEF-354 — turn-on and field-wise approval. Pins spec §2.5 and the vm §9 rules
 * "test before turn-on, bound to version + connection fingerprint", "enabling
 * never triggers a run", "one field, one owner", plus the vm defect "activated_at
 * re-stamped on every save":
 *
 *  - no SUCCESS dry run of the version ⇒ refused, nothing changed;
 *  - the sheet changed after the test ⇒ refused (the dry run read another sheet);
 *  - a dry run that predates the last approval ⇒ refused;
 *  - turning on creates 0 runs and never touches the run engine;
 *  - a second activate keeps activated_at; a resume from PAUSED re-stamps it;
 *  - a KPI owned by another integration is refused, NAMING that integration;
 *  - approving `kpi:new:<key>` creates the definition owned by this integration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { makeFakeDb } from './def354IntegrationFakeDb';

const h = vi.hoisted(() => ({ db: null as any, startRun: vi.fn(), runIntegration: vi.fn() }));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/db/prisma', () => {
  const p = new Proxy({}, { get: (_t, k) => h.db.prisma[k] });
  return { __esModule: true, default: p, prisma: p };
});
vi.mock('../src/services/userTimezoneService', () => ({
  isValidTimezone: (tz: unknown) => typeof tz === 'string' && tz.length > 0 && tz !== 'Nowhere/Nope',
  resolveUserTimezone: async () => 'Asia/Karachi',
}));
vi.mock('../src/services/integrations/engine/planner', () => ({
  nextScheduledRun: () => new Date('2026-11-02T21:00:00Z'),
  isDue: () => null,
}));
// If activate ever reached the engine, these spies would see it.
vi.mock('../src/services/integrations/engine/runJobs', () => ({ startRun: h.startRun }));
vi.mock('../src/services/integrations/engine/runEngine', () => ({ runIntegration: h.runIntegration }));

import { createIntegration, recordConnectionTest, updateIntegration } from '../src/services/integrations/store/integrationStore';
import { activate, approveSuggestions, pause } from '../src/services/integrations/store/mappingStore';
import { ActivationRefusedError } from '../src/services/integrations/types';

const CN = 'TMC-0001';
const LINK = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0';
const OTHER_LINK = 'https://docs.google.com/spreadsheets/d/1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210/edit#gid=5';

beforeEach(() => {
  h.db = makeFakeDb();
  h.startRun.mockReset();
  h.runIntegration.mockReset();
});

/** A DRAFT integration, connection tested, one version with one approved row. */
async function ready(opts: { dryRun?: boolean } = {}) {
  const dto = await createIntegration(CN, { name: 'Sales', link: LINK, frequency: 'daily', runTime: '06:00' }, 7);
  await recordConnectionTest(CN, dto.id, { ok: true, rows: 5, columns: ['Month', 'Revenue'], sampleRow: null });
  const v = h.db.insert('integrationMappingVersion', { clientNumber: CN, integrationId: dto.id, version: 1, status: 'DRAFT' });
  h.db.insert('kpiDefinition', { clientNumber: CN, kpiKey: 'revenue', label: 'Revenue', sourceIntegrationId: dto.id });
  h.db.insert('integrationSuggestion', {
    clientNumber: CN, integrationId: dto.id, mappingVersionId: v.id, sourceField: 'Revenue', targetKey: 'kpi:revenue',
    status: 'APPROVED', decidedBy: 7, decidedAt: new Date(Date.now() - 60_000),
  });
  const fp = h.db.tables.integrationSync[0].connectionFingerprint;
  if (opts.dryRun !== false) {
    h.db.insert('integrationRun', {
      clientNumber: CN, integrationId: dto.id, mappingVersionId: v.id, dryRun: true, status: 'SUCCESS', connectionFingerprint: fp,
    });
  }
  return { id: dto.id as string, versionId: v.id as string, fp };
}

function refusal(p: Promise<unknown>): Promise<string[]> {
  return p.then(() => { throw new Error('activated'); }, (e) => {
    expect(e).toBeInstanceOf(ActivationRefusedError);
    return (e as ActivationRefusedError).reasons;
  });
}

describe('DEF-354 activation — preconditions (spec §2.5)', () => {
  it('no dry run ⇒ refused, and nothing changed', async () => {
    const { id, versionId } = await ready({ dryRun: false });
    const reasons = await refusal(activate(CN, id, versionId, 7));
    expect(reasons.join(' ')).toMatch(/dry run/);
    expect(h.db.tables.integrationSync[0]).toMatchObject({ status: 'DRAFT', activatedAt: null, approvedVersionId: null });
    expect(h.db.tables.integrationMappingVersion[0].status).toBe('DRAFT');
  });

  it('a failed dry run does not count', async () => {
    const { id, versionId } = await ready({ dryRun: false });
    h.db.insert('integrationRun', {
      clientNumber: CN, integrationId: id, mappingVersionId: versionId, dryRun: true, status: 'FAILED',
      connectionFingerprint: h.db.tables.integrationSync[0].connectionFingerprint,
    });
    await refusal(activate(CN, id, versionId, 7));
  });

  it('sheet changed after the test ⇒ refused', async () => {
    const { id, versionId } = await ready();
    await updateIntegration(CN, id, { link: OTHER_LINK });
    const reasons = await refusal(activate(CN, id, versionId, 7));
    expect(reasons.join(' ')).toMatch(/Test the connection again/);
    expect(h.db.tables.integrationSync[0].status).toBe('DRAFT');
  });

  it('sheet changed and re-tested, but the dry run read the old sheet ⇒ refused', async () => {
    const { id, versionId } = await ready();
    await updateIntegration(CN, id, { link: OTHER_LINK });
    await recordConnectionTest(CN, id, { ok: true, rows: 5, columns: ['Month', 'Revenue'], sampleRow: null });
    const reasons = await refusal(activate(CN, id, versionId, 7));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/current sheet/);
  });

  it('a dry run older than the last approval ⇒ refused', async () => {
    const { id, versionId } = await ready();
    h.db.tables.integrationRun[0].startedAt = new Date(Date.now() - 120_000);
    await refusal(activate(CN, id, versionId, 7));
  });

  it('no approved row ⇒ refused', async () => {
    const { id, versionId } = await ready();
    h.db.tables.integrationSuggestion[0].status = 'PENDING';
    const reasons = await refusal(activate(CN, id, versionId, 7));
    expect(reasons.join(' ')).toMatch(/Approve at least one field/);
  });

  it('weekly without a day ⇒ refused', async () => {
    const { id, versionId } = await ready();
    h.db.tables.integrationSync[0].frequency = 'weekly';
    const reasons = await refusal(activate(CN, id, versionId, 7));
    expect(reasons.join(' ')).toMatch(/day of the week/);
  });
});

describe('DEF-354 activation — what turning on does', () => {
  it('turns on, approves the version, and creates 0 runs', async () => {
    const { id, versionId } = await ready();
    const runsBefore = h.db.tables.integrationRun.length;
    const dto = await activate(CN, id, versionId, 7);
    expect(dto.status).toBe('ACTIVE');
    expect(dto.approvedVersionId).toBe(versionId);
    expect(dto.activatedAt).not.toBeNull();
    expect(dto.nextRunAt).toBe('2026-11-02T21:00:00.000Z');
    expect(h.db.tables.integrationMappingVersion[0]).toMatchObject({ status: 'APPROVED', approvedBy: 7 });
    expect(h.db.tables.integrationRun.length).toBe(runsBefore);
    expect(h.db.calls.filter((c: any) => c.model === 'integrationRun' && /create|update/.test(c.op))).toEqual([]);
    expect(h.startRun).not.toHaveBeenCalled();
    expect(h.runIntegration).not.toHaveBeenCalled();
  });

  it('mappingStore does not import the run engine (enabling never triggers a run)', () => {
    const src = readFileSync(join(__dirname, '../src/services/integrations/store/mappingStore.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*import\b|from\s+['"]/.test(l));
    expect(imports.join('\n')).not.toMatch(/runJobs|runEngine|dispatcher/);
  });

  it('a second activate keeps activated_at', async () => {
    const { id, versionId } = await ready();
    const first = await activate(CN, id, versionId, 7);
    h.db.tables.integrationSync[0].activatedAt = new Date('2026-10-20T00:00:00Z');
    const second = await activate(CN, id, versionId, 7);
    expect(second.activatedAt).toBe('2026-10-20T00:00:00.000Z');
    expect(first.status).toBe('ACTIVE');
  });

  it('pause then resume re-stamps activated_at (slots missed while paused are not owed)', async () => {
    const { id, versionId } = await ready();
    await activate(CN, id, versionId, 7);
    h.db.tables.integrationSync[0].activatedAt = new Date('2026-10-20T00:00:00Z');
    const paused = await pause(CN, id);
    expect(paused).toMatchObject({ status: 'PAUSED', nextRunAt: null, approvedVersionId: versionId });
    const resumed = await activate(CN, id, versionId, 7);
    expect(new Date(resumed.activatedAt!).getTime()).toBeGreaterThan(new Date('2026-10-21').getTime());
  });

  it('activating a new version supersedes the previous one', async () => {
    const { id, versionId, fp } = await ready();
    await activate(CN, id, versionId, 7);
    const v2 = h.db.insert('integrationMappingVersion', { clientNumber: CN, integrationId: id, version: 2, status: 'DRAFT' });
    h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: id, mappingVersionId: v2.id, sourceField: 'Revenue', targetKey: 'kpi:revenue', status: 'APPROVED', decidedAt: new Date(Date.now() - 1000) });
    h.db.insert('integrationRun', { clientNumber: CN, integrationId: id, mappingVersionId: v2.id, dryRun: true, status: 'SUCCESS', connectionFingerprint: fp });
    const dto = await activate(CN, id, v2.id, 7);
    expect(dto.approvedVersionId).toBe(v2.id);
    const statuses = h.db.tables.integrationMappingVersion.map((v: any) => [v.version, v.status]);
    expect(statuses).toEqual([[1, 'SUPERSEDED'], [2, 'APPROVED']]);
  });

  it('another tenant cannot activate the row', async () => {
    const { id, versionId } = await ready();
    await expect(activate('TMC-0002', id, versionId, 7)).rejects.toThrow(/not found/);
    expect(h.db.tables.integrationSync[0].status).toBe('DRAFT');
  });
});

describe('DEF-354 approval — one field, one owner', () => {
  async function twoIntegrations() {
    const a = await createIntegration(CN, { name: 'Finance master sheet', link: LINK }, 7);
    const b = await createIntegration(CN, { name: 'Regional sheet', link: OTHER_LINK }, 7);
    h.db.insert('kpiDefinition', { clientNumber: CN, kpiKey: 'revenue', label: 'Revenue', sourceIntegrationId: a.id });
    const v = h.db.insert('integrationMappingVersion', { clientNumber: CN, integrationId: b.id, version: 1, status: 'DRAFT' });
    return { a, b, v };
  }

  it('a KPI owned by another integration is refused, naming that integration', async () => {
    const { b, v } = await twoIntegrations();
    const s = h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: b.id, mappingVersionId: v.id, sourceField: 'Rev', targetKey: 'kpi:revenue', status: 'PENDING' });
    const r = await approveSuggestions(CN, b.id, v.id, [s.id], 7);
    expect(r.updated).toBe(0);
    expect(r.refused).toEqual([{ id: s.id, reason: expect.stringContaining('"Finance master sheet"') }]);
    expect(h.db.tables.integrationSuggestion[0].status).toBe('PENDING');
  });

  it('a kpi:new row naming an existing owned key is refused the same way', async () => {
    const { b, v } = await twoIntegrations();
    const s = h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: b.id, mappingVersionId: v.id, sourceField: 'Rev', targetKey: 'kpi:new:revenue', newKpi: { kpiKey: 'revenue', label: 'Rev' }, status: 'PENDING' });
    const r = await approveSuggestions(CN, b.id, v.id, 'all', 7);
    expect(r.refused[0]).toMatchObject({ id: s.id, reason: expect.stringContaining('Finance master sheet') });
    expect(h.db.tables.kpiDefinition).toHaveLength(1);
  });

  it('approving kpi:new creates the definition owned by this integration and rewrites the target', async () => {
    const { b, v } = await twoIntegrations();
    const s = h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: b.id, mappingVersionId: v.id, sourceField: 'Leads', targetKey: 'kpi:new:leads', newKpi: { kpiKey: 'leads', label: 'New leads', unit: 'count' }, status: 'PENDING' });
    const r = await approveSuggestions(CN, b.id, v.id, [s.id], 7);
    expect(r).toMatchObject({ updated: 1, createdKpis: ['leads'], refused: [] });
    expect(h.db.tables.kpiDefinition.find((k: any) => k.kpiKey === 'leads')).toMatchObject({ clientNumber: CN, sourceIntegrationId: b.id, label: 'New leads', unit: 'count' });
    expect(h.db.tables.integrationSuggestion[0]).toMatchObject({ status: 'APPROVED', targetKey: 'kpi:leads', decidedBy: 7 });
  });

  it('an unowned catalogue KPI is claimed by the first integration that approves it', async () => {
    const { a, b, v } = await twoIntegrations();
    h.db.insert('kpiDefinition', { clientNumber: CN, kpiKey: 'cost', label: 'Cost', sourceIntegrationId: null });
    const s = h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: b.id, mappingVersionId: v.id, sourceField: 'Cost', targetKey: 'kpi:cost', status: 'PENDING' });
    await approveSuggestions(CN, b.id, v.id, [s.id], 7);
    expect(h.db.tables.kpiDefinition.find((k: any) => k.kpiKey === 'cost').sourceIntegrationId).toBe(b.id);
    expect(a.id).not.toBe(b.id);
  });

  it('two fields of one mapping cannot feed the same KPI', async () => {
    const { b, v } = await twoIntegrations();
    h.db.insert('kpiDefinition', { clientNumber: CN, kpiKey: 'cost', label: 'Cost' });
    h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: b.id, mappingVersionId: v.id, sourceField: 'Cost', targetKey: 'kpi:cost', status: 'PENDING' });
    h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: b.id, mappingVersionId: v.id, sourceField: 'Cost 2', targetKey: 'kpi:cost', status: 'PENDING' });
    const r = await approveSuggestions(CN, b.id, v.id, 'all', 7);
    expect(r.updated).toBe(1);
    expect(r.refused[0].reason).toMatch(/already fed by the field "Cost"/);
  });

  it('the running (APPROVED) version is frozen against new approvals', async () => {
    const { id, versionId } = await ready();
    await activate(CN, id, versionId, 7);
    h.db.insert('kpiDefinition', { clientNumber: CN, kpiKey: 'cost', label: 'Cost' });
    const s = h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: id, mappingVersionId: versionId, sourceField: 'Cost', targetKey: 'kpi:cost', status: 'PENDING' });
    await expect(approveSuggestions(CN, id, versionId, [s.id], 7)).rejects.toThrow(/running/);
    expect(h.db.tables.integrationSuggestion.find((x: any) => x.id === s.id).status).toBe('PENDING');
  });
});
