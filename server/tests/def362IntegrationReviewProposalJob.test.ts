/**
 * DEF-362 — found while running the review fixes' type check: "Suggest the
 * mapping" could never start for an API integration.
 *
 * startProposalJob gates on isConnectionOk, and an api row's fingerprint is
 * api_config + secret_set_at. The job loaded only the Stage 1 columns
 * (sourceConfig), so for an api row the fingerprint was always null and the
 * proposal was refused as "Test the connection first" after a passing test.
 * The fake findFirst here honours `select` like Prisma does, so the test fails
 * when the columns are not selected.
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
vi.mock('../src/services/behaviorConfig', () => ({ getBehaviorValue: async () => 60_000 }));
vi.mock('../src/services/userTimezoneService', () => ({ isValidTimezone: () => true, resolveUserTimezone: async () => 'Asia/Karachi' }));
vi.mock('../src/services/integrations/mapping/aiProposer', () => ({ runProposal: () => new Promise(() => {}) }));

import { startProposalJob, __resetProposalJobs } from '../src/services/integrations/mapping/proposalJobs';
import { apiConnectionFingerprint } from '../src/services/integrations/store/integrationStore';
import { readApiConfig } from '../src/services/integrations/sources/apiReader';

const CN = 'TMC-0001';

beforeEach(() => {
  h.db = makeFakeDb();
  __resetProposalJobs?.();
  const real = h.db.prisma.integrationSync.findFirst;
  h.db.prisma.integrationSync.findFirst = async (args: any) => {
    const row = await real(args);
    if (!row || !args?.select) return row;
    return Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]]));
  };
});

describe('DEF-362 — proposing a mapping for an API integration', () => {
  it('starts once the current API connection passed its test', async () => {
    const cfg = readApiConfig({ baseUrl: 'https://api.acme.test/v1', path: '/customers', recordsPath: 'data', authScheme: 'BEARER' })!;
    const secretSetAt = new Date('2026-10-20T00:00:00Z');
    const row = h.db.insert('integrationSync', {
      clientNumber: CN, name: 'Customers', sourceKind: 'api', createdBy: 7, sourceConfig: {},
      apiConfig: cfg, secretSetAt, connectionTestedAt: new Date(), connectionFingerprint: apiConnectionFingerprint(cfg, secretSetAt),
    });
    const { jobId } = await startProposalJob(CN, row.id, { actorId: 7 });
    expect(typeof jobId).toBe('string');
  });

  it('is still refused when the API connection was not tested', async () => {
    const cfg = readApiConfig({ baseUrl: 'https://api.acme.test/v1', path: '/customers', recordsPath: 'data' })!;
    const row = h.db.insert('integrationSync', {
      clientNumber: CN, name: 'Customers', sourceKind: 'api', createdBy: 7, sourceConfig: {}, apiConfig: cfg,
      connectionTestedAt: null, connectionFingerprint: null,
    });
    await expect(startProposalJob(CN, row.id, { actorId: 7 })).rejects.toMatchObject({ field: 'connection' });
  });
});
