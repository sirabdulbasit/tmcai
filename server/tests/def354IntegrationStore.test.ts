/**
 * DEF-354 — Integrations store. Pins three rules (spec §2.6, §2.7, §3):
 *
 *  1. Closed PUT whitelist — vm §9 "permissions are never accepted from the
 *     client": status, approval, activation, timestamps, the fingerprint and
 *     createdBy are REJECTED with a 400, never silently applied or ignored; and
 *     editing the sheet link clears the connection test.
 *  2. The wizard stage counts approvals on the version that would run only (the
 *     approved one, else the latest) — approvals on an older version say nothing
 *     about what the next run writes (vm P:313, derived not stored).
 *  3. Tenant scoping on every query — each Prisma `where` (and each `create`)
 *     the store and mappingStore issue carries the caller's clientNumber.
 *
 * Falsifiers: a PUT {status:'ACTIVE'} that changes the row; a stage of
 * "Mapping approved" when only a superseded version has approvals; any query
 * without clientNumber.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makeFakeDb } from './def354IntegrationFakeDb';

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/db/prisma', () => {
  const p = new Proxy({}, { get: (_t, k) => h.db.prisma[k] });
  return { __esModule: true, default: p, prisma: p };
});
vi.mock('../src/services/userTimezoneService', () => ({
  isValidTimezone: (tz: unknown) => {
    if (typeof tz !== 'string' || !tz) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
  },
  resolveUserTimezone: async () => 'Asia/Karachi',
}));
vi.mock('../src/services/integrations/engine/planner', () => ({
  nextScheduledRun: () => new Date('2026-11-01T21:00:00Z'),
  isDue: () => null,
}));

import {
  createIntegration, deleteIntegration, deriveWizardStage, getIntegration, listIntegrations,
  recordConnectionTest, updateIntegration, validateIntegrationInput, connectionFingerprint,
} from '../src/services/integrations/store/integrationStore';
import {
  approveSuggestions, createKpiDefinition, listKpiDefinitions, listSuggestions, pause, rejectSuggestions,
} from '../src/services/integrations/store/mappingStore';
import { IntegrationInputError } from '../src/services/integrations/types';

const CN = 'TMC-0001';
const LINK = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0';
const OTHER_LINK = 'https://docs.google.com/spreadsheets/d/1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210/edit#gid=5';

beforeEach(() => { h.db = makeFakeDb(); });

describe('DEF-354 store — closed PUT whitelist (vm §9)', () => {
  const forbidden = [
    'status', 'approvedVersionId', 'activatedAt', 'connectionTestedAt', 'connectionFingerprint',
    'createdBy', 'clientNumber', 'sheetId', 'gid', 'lastSlotAt', 'nextRunAt', 'id',
  ];
  for (const key of forbidden) {
    it(`rejects "${key}" with a 400 naming the field`, () => {
      try {
        validateIntegrationInput({ name: 'x', [key]: 'ACTIVE' });
        throw new Error('accepted');
      } catch (e) {
        expect(e).toBeInstanceOf(IntegrationInputError);
        expect((e as IntegrationInputError).field).toBe(key);
      }
    });
  }

  it('a PUT carrying status:ACTIVE changes nothing on the row', async () => {
    const dto = await createIntegration(CN, { name: 'Sales', link: LINK }, 7);
    const writesBefore = h.db.calls.filter((c: any) => c.op === 'updateMany').length;
    await expect(updateIntegration(CN, dto.id, { name: 'Sales 2', status: 'ACTIVE' } as any))
      .rejects.toBeInstanceOf(IntegrationInputError);
    expect(h.db.calls.filter((c: any) => c.op === 'updateMany').length).toBe(writesBefore);
    expect(h.db.tables.integrationSync[0]).toMatchObject({ name: 'Sales', status: 'DRAFT', activatedAt: null });
  });

  it('create forces DRAFT and takes the creator\'s zone', async () => {
    const dto = await createIntegration(CN, { name: 'Sales', link: LINK }, 7);
    expect(dto.status).toBe('DRAFT');
    expect(dto.timezone).toBe('Asia/Karachi');
    expect(dto.sourceConfig).toMatchObject({ gid: '0' });
  });

  it('editing the sheet link clears connection_tested_at and the fingerprint', async () => {
    const dto = await createIntegration(CN, { name: 'Sales', link: LINK }, 7);
    const tested = await recordConnectionTest(CN, dto.id, { ok: true, rows: 3, columns: ['a'], sampleRow: null });
    expect(tested.connectionOk).toBe(true);
    expect(h.db.tables.integrationSync[0].connectionFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const edited = await updateIntegration(CN, dto.id, { link: OTHER_LINK });
    expect(edited.connectionOk).toBe(false);
    expect(h.db.tables.integrationSync[0]).toMatchObject({ connectionTestedAt: null, connectionFingerprint: null });
  });

  it('a renamed integration keeps its connection test (name is not the route)', async () => {
    const dto = await createIntegration(CN, { name: 'Sales', link: LINK }, 7);
    await recordConnectionTest(CN, dto.id, { ok: true, rows: 3, columns: ['a'], sampleRow: null });
    const edited = await updateIntegration(CN, dto.id, { name: 'Sales (monthly)' });
    expect(edited.connectionOk).toBe(true);
  });

  it('the fingerprint is the route only: tab label and link text do not change it', () => {
    const a = connectionFingerprint('gsheet', { sheetId: 's', gid: '0', link: 'x', tabLabel: 'A' });
    const b = connectionFingerprint('gsheet', { sheetId: 's', gid: '0', link: 'y' });
    const c = connectionFingerprint('gsheet', { sheetId: 's', gid: '1', link: 'x' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('DEF-354 store — wizard stage counts the running version only', () => {
  async function seed() {
    const dto = await createIntegration(CN, { name: 'Sales', link: LINK }, 7);
    await recordConnectionTest(CN, dto.id, { ok: true, rows: 3, columns: ['a'], sampleRow: null });
    const v1 = h.db.insert('integrationMappingVersion', { clientNumber: CN, integrationId: dto.id, version: 1, status: 'SUPERSEDED' });
    const v2 = h.db.insert('integrationMappingVersion', { clientNumber: CN, integrationId: dto.id, version: 2, status: 'DRAFT' });
    return { dto, v1, v2 };
  }

  it('approvals on an older version do not make the latest look approved', async () => {
    const { dto, v1, v2 } = await seed();
    h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: dto.id, mappingVersionId: v1.id, sourceField: 'Revenue', targetKey: 'kpi:revenue', status: 'APPROVED' });
    h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: dto.id, mappingVersionId: v2.id, sourceField: 'Revenue', targetKey: 'kpi:revenue', status: 'PENDING' });
    const got = await getIntegration(CN, dto.id);
    expect(got!.stage).toMatchObject({ step: 3, label: 'Review the mapping' });
  });

  it('an approval on the latest version moves the stage to step 4', async () => {
    const { dto, v2 } = await seed();
    h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: dto.id, mappingVersionId: v2.id, sourceField: 'Revenue', targetKey: 'kpi:revenue', status: 'APPROVED' });
    const got = await getIntegration(CN, dto.id);
    expect(got!.stage.step).toBe(4);
  });

  it('a dry run of an older version does not count as "tested"', async () => {
    const { dto, v1, v2 } = await seed();
    const row = h.db.tables.integrationSync[0];
    h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: dto.id, mappingVersionId: v2.id, sourceField: 'Revenue', targetKey: 'kpi:revenue', status: 'APPROVED' });
    h.db.insert('integrationRun', { clientNumber: CN, integrationId: dto.id, mappingVersionId: v1.id, dryRun: true, status: 'SUCCESS', connectionFingerprint: row.connectionFingerprint });
    expect((await getIntegration(CN, dto.id))!.stage.step).toBe(4);
    h.db.insert('integrationRun', { clientNumber: CN, integrationId: dto.id, mappingVersionId: v2.id, dryRun: true, status: 'SUCCESS', connectionFingerprint: row.connectionFingerprint });
    expect((await getIntegration(CN, dto.id))!.stage).toMatchObject({ step: 5, label: 'Tested — not turned on' });
  });

  it('deriveWizardStage: status wins over every fact', () => {
    const facts = { hasSource: true, connectionTested: true, hasMapping: true, hasApproval: true, hasSuccessfulDryRun: true };
    expect(deriveWizardStage({ status: 'ACTIVE', ...facts })).toMatchObject({ step: 5, done: true });
    expect(deriveWizardStage({ status: 'PAUSED', ...facts })).toMatchObject({ label: 'Paused' });
    expect(deriveWizardStage({ status: 'DRAFT', hasSource: false, connectionTested: false, hasMapping: false, hasApproval: false, hasSuccessfulDryRun: false }).step).toBe(1);
  });

  it('editing the schedule of an ACTIVE integration owes no slot that already passed (review fix)', async () => {
    const real = await vi.importActual<typeof import('../src/services/integrations/engine/planner')>('../src/services/integrations/engine/planner');
    const dto = await createIntegration(CN, { name: 'Daily', link: LINK, frequency: 'daily', runTime: '23:00', timezone: 'Asia/Karachi' } as any, 7);
    const row = h.db.tables.integrationSync.find((r: any) => r.id === dto.id);
    const yesterday23 = new Date(Date.now() - 86_400_000);
    Object.assign(row, { status: 'ACTIVE', activatedAt: new Date(Date.now() - 30 * 86_400_000), approvedVersionId: 'v1', lastSlotAt: yesterday23 });

    const before = Date.now();
    // Every run time of the day: whichever has already passed today must not become due.
    await updateIntegration(CN, dto.id, { runTime: '00:00' });
    expect(row.lastSlotAt.getTime()).toBeGreaterThanOrEqual(before);
    const due = real.isDue({ frequency: 'daily', runTime: '00:00', dayOfWeek: null, dayOfMonth: null }, new Date(Date.now() + 60_000), row.lastSlotAt, row.activatedAt, 'Asia/Karachi');
    expect(due).toBeNull();
  });

  it('client pins (review fixes): stale tests do not pass, run notes are shown, step 3 without a mapping opens Connect', () => {
    const dir = path.join(__dirname, '../../client/src/pages/admin/integrations');
    const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
    // StepTestTurnOn: only a test started after the version's last decision counts (mappingStore.activate rule).
    expect(read('StepTestTurnOn.jsx')).toMatch(/Date\.parse\(r\.startedAt\) >= lastDecided/);
    // RunHistory lists anomalies; a 0-write run with notes is not a quiet "No changes".
    expect(read('RunHistory.jsx')).toMatch(/r\.anomalies\.map/);
    expect(read('integrationUi.jsx')).toContain('No changes — see notes');
    // StepConnect / list: hasMapping is not inferred from step >= 3.
    expect(read('StepConnect.jsx')).toContain('stageHasMapping(integ?.stage)');
    expect(read('StepConnect.jsx')).not.toMatch(/stage\?\.step \?\? 1\) >= 3/);
    expect(read('IntegrationsTab.jsx')).toContain('openStepFor(integ.stage)');
  });

  it('deriveWizardStage: step 3 WITHOUT a mapping keeps the exact label the client keys on (integrationUi STAGE_NEEDS_MAPPING)', () => {
    const none = { hasSource: true, connectionTested: true, hasMapping: false, hasApproval: false, hasSuccessfulDryRun: false };
    expect(deriveWizardStage({ status: 'DRAFT', ...none })).toEqual({ step: 3, label: 'Connected — needs a mapping', done: false });
    expect(deriveWizardStage({ status: 'DRAFT', ...none, hasMapping: true }).label).not.toBe('Connected — needs a mapping');
    const ui = fs.readFileSync(path.join(__dirname, '../../client/src/pages/admin/integrations/integrationUi.jsx'), 'utf8');
    expect(ui).toContain("export const STAGE_NEEDS_MAPPING = 'Connected — needs a mapping';");
  });
});

describe('DEF-354 store — tenant scoping on every where', () => {
  it('every query the store and mappingStore issue names the tenant', async () => {
    // A same-id row in another tenant must stay invisible throughout.
    const dto = await createIntegration(CN, { name: 'Sales', link: LINK }, 7);
    const v = h.db.insert('integrationMappingVersion', { clientNumber: CN, integrationId: dto.id, version: 1, status: 'DRAFT' });
    const s = h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: dto.id, mappingVersionId: v.id, sourceField: 'Revenue', targetKey: 'kpi:new:revenue', newKpi: { kpiKey: 'revenue', label: 'Revenue' }, status: 'PENDING' });
    h.db.insert('integrationSuggestion', { clientNumber: CN, integrationId: dto.id, mappingVersionId: v.id, sourceField: 'Cost', targetKey: 'kpi:cost', status: 'PENDING' });

    await listIntegrations(CN);
    await getIntegration(CN, dto.id);
    await updateIntegration(CN, dto.id, { name: 'Sales 2', link: OTHER_LINK });
    await recordConnectionTest(CN, dto.id, { ok: true, rows: 1, columns: ['a'], sampleRow: null });
    await listSuggestions(CN, dto.id);
    await createKpiDefinition(CN, { kpiKey: 'cost', label: 'Cost' }, 7);
    await listKpiDefinitions(CN);
    await approveSuggestions(CN, dto.id, v.id, [s.id], 7);
    await rejectSuggestions(CN, dto.id, v.id, 'all', 7);
    await expect(pause(CN, dto.id)).rejects.toBeInstanceOf(IntegrationInputError);
    await deleteIntegration(CN, dto.id);

    expect(h.db.calls.length).toBeGreaterThan(20);
    for (const c of h.db.calls) {
      if (c.op === 'create') expect(c.args.data.clientNumber, `${c.model}.create`).toBe(CN);
      else if (c.op === 'createMany') for (const d of c.args.data) expect(d.clientNumber, `${c.model}.createMany`).toBe(CN);
      else expect(c.args?.where?.clientNumber, `${c.model}.${c.op} ${JSON.stringify(c.args?.where)}`).toBe(CN);
    }
  });

  it('another tenant cannot read, edit or delete the row', async () => {
    const dto = await createIntegration(CN, { name: 'Sales', link: LINK }, 7);
    expect(await getIntegration('TMC-0002', dto.id)).toBeNull();
    expect(await listIntegrations('TMC-0002')).toEqual([]);
    await expect(updateIntegration('TMC-0002', dto.id, { name: 'x' })).rejects.toThrow(/not found/);
    await expect(deleteIntegration('TMC-0002', dto.id)).rejects.toThrow(/not found/);
    expect(h.db.tables.integrationSync).toHaveLength(1);
  });
});
