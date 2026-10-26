/**
 * DEF-362 — Integrations Stage 1b, fix from the four-angle review: turn-on and
 * a PARTIAL dry run.
 *
 * A dry run is PARTIAL when the Context page cap (max_context_pages) stopped
 * it, or when the read itself fell short. The first is a limit every live run
 * applies identically, so it must not block turn-on forever (an API with 600
 * records and a per_record row could never be activated). The second is an
 * incomplete read and still does not count — Stage 1's rule — and the refusal
 * now says why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  isValidTimezone: () => true,
  resolveUserTimezone: async () => 'Asia/Karachi',
}));
vi.mock('../src/services/integrations/engine/planner', () => ({
  nextScheduledRun: () => new Date('2026-11-02T21:00:00Z'),
  isDue: () => null,
}));
vi.mock('../src/services/integrations/engine/runJobs', () => ({ startRun: vi.fn() }));
vi.mock('../src/services/integrations/engine/runEngine', () => ({ runIntegration: vi.fn() }));

import { createIntegration, recordConnectionTest } from '../src/services/integrations/store/integrationStore';
import { activate } from '../src/services/integrations/store/mappingStore';
import { ActivationRefusedError } from '../src/services/integrations/types';

const CN = 'TMC-0001';
const LINK = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0';

beforeEach(() => { h.db = makeFakeDb(); });

async function ready(dry: { status: string; result: unknown }) {
  const dto = await createIntegration(CN, { name: 'Customers', link: LINK, frequency: 'daily', runTime: '06:00' }, 7);
  await recordConnectionTest(CN, dto.id, { ok: true, rows: 5, columns: ['id', 'name'], sampleRow: null });
  const v = h.db.insert('integrationMappingVersion', { clientNumber: CN, integrationId: dto.id, version: 1, status: 'DRAFT' });
  h.db.insert('integrationSuggestion', {
    clientNumber: CN, integrationId: dto.id, mappingVersionId: v.id, sourceField: 'name', targetKey: 'context:per_record',
    targetKind: 'context', status: 'APPROVED', decidedBy: 7, decidedAt: new Date(Date.now() - 60_000),
  });
  h.db.insert('integrationRun', {
    clientNumber: CN, integrationId: dto.id, mappingVersionId: v.id, dryRun: true,
    connectionFingerprint: h.db.tables.integrationSync[0].connectionFingerprint, ...dry,
  });
  return { id: dto.id as string, versionId: v.id as string };
}

const CAP_NOTE = 'Only the first 500 knowledge pages were written; 100 more record(s) were not (limit integrations.max_context_pages).';

describe('DEF-362 turn-on — a PARTIAL dry run', () => {
  it('counts when the read was complete and the only shortfall was the Context page cap', async () => {
    const { id, versionId } = await ready({
      status: 'PARTIAL', result: { readComplete: true, context: { truncated: true }, anomalies: [CAP_NOTE] },
    });
    const dto = await activate(CN, id, versionId, 7);
    expect(dto.status).toBe('ACTIVE');
  });

  it('does NOT count when the read itself fell short — and the refusal says why', async () => {
    const { id, versionId } = await ready({
      status: 'PARTIAL', result: { readComplete: false, context: { truncated: false }, anomalies: ['Read 980 of a declared 1000 records.'] },
    });
    const err = await activate(CN, id, versionId, 7).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ActivationRefusedError);
    expect(err.reasons.join(' ')).toMatch(/did not read the whole sheet \(Read 980 of a declared 1000 records\)/);
    expect(h.db.tables.integrationSync[0].status).toBe('DRAFT');
  });

  it('does NOT count when the result carries no readComplete (an older or Stage 1 run)', async () => {
    const { id, versionId } = await ready({ status: 'PARTIAL', result: { context: { truncated: true }, anomalies: [] } });
    await expect(activate(CN, id, versionId, 7)).rejects.toBeInstanceOf(ActivationRefusedError);
  });
});
