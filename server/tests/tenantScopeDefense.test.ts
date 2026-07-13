import { describe, it, expect, vi, beforeEach } from 'vitest';

// E3/E5 — tenant-isolation defense in depth for the four models that had
// NO tenant column at all: action_definitions, domain_knowledge,
// personal_documents, personal_chunks. Personal data was only user-scoped
// (userId), and action/domain rows were fully global — so a single wrong
// join or a leaked userId could cross tenants with nothing to stop it.
//
// The contract under test:
//   * Readers gain an OPTIONAL clientNumber and apply an OR filter —
//     `(clientNumber IS NULL OR clientNumber = :cn)` — because NULL means
//     "system/global row" (seeded actions, seeded domain knowledge) and
//     must remain visible to every tenant. Pre-backfill stragglers also
//     stay reachable this way instead of silently vanishing.
//   * Passing NO clientNumber keeps the old behavior exactly (callers
//     that predate E3/E5 must not break).
//   * Writers persist clientNumber so new rows are born tenant-tagged.

const actionFindFirst = vi.fn(async (): Promise<any> => null);
const actionFindMany = vi.fn(async (): Promise<any[]> => []);
const actionUpsert = vi.fn(async (a: any): Promise<any> => ({
  id: 'ad_1', type: a?.create?.type ?? 'x', displayName: 'X', description: 'd',
  schema: {}, handlerModule: 'm', handlerFunction: 'f', previewTemplate: null,
  requiresCapability: null, isHumanFacing: false, isActive: true,
  scope: 'system', source: 'seeded', approvedAt: null,
  clientNumber: a?.create?.clientNumber ?? null, updatedAt: new Date(),
}));
const queryRawUnsafe = vi.fn(async (): Promise<any[]> => []);

vi.mock('../src/db/prisma', () => ({
  default: {
    actionDefinition: {
      findFirst: (...a: any[]) => actionFindFirst(...(a as [])),
      findMany: (...a: any[]) => actionFindMany(...(a as [])),
      upsert: (...a: any[]) => actionUpsert(a[0]),
    },
    $queryRawUnsafe: (...a: any[]) => queryRawUnsafe(...(a as [])),
  },
}));
// personalDriveService pulls in googleapis + OAuth plumbing we don't need
// for a pure SQL-shape test — stub the heavy edges.
vi.mock('googleapis', () => ({ google: { drive: vi.fn() } }));
vi.mock('../src/services/integrationService', () => ({
  getAuthenticatedClient: vi.fn(async () => ({ client: null, error: 'stub' })),
}));
vi.mock('../src/pipeline/embedder', () => ({
  embedText: vi.fn(async () => [0.1, 0.2]),
  embedBatch: vi.fn(async () => [[0.1, 0.2]]),
}));
vi.mock('../src/services/featureFlagService', () => ({
  isFeatureEnabled: vi.fn(async () => true),
}));

import {
  getActionDefinition, listActiveActions, registerAction,
} from '../src/services/knowledge/actionRegistryService';
import { searchPersonalChunks } from '../src/services/personalDriveService';
import { searchDomainKnowledge } from '../src/services/domainKnowledgeService';

// The exact OR shape readers must emit: NULL rows (system/global +
// pre-backfill stragglers) pass through, other tenants' rows do not.
const orFilter = { OR: [{ clientNumber: null }, { clientNumber: 'tmc' }] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('E3/E5 — actionRegistryService is tenant-aware', () => {
  it('getActionDefinition with clientNumber applies the NULL-or-tenant OR filter', async () => {
    await getActionDefinition('send_email', 'tmc');
    expect(actionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ type: 'send_email', isActive: true, ...orFilter }),
    }));
  });

  it('getActionDefinition without clientNumber keeps the legacy unfiltered where', async () => {
    await getActionDefinition('send_email');
    const where = actionFindFirst.mock.calls[0][0 as never]!['where'];
    expect(where.OR).toBeUndefined();
    expect(where.clientNumber).toBeUndefined();
  });

  it('listActiveActions with clientNumber applies the NULL-or-tenant OR filter', async () => {
    await listActiveActions(undefined, 'tmc');
    expect(actionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ isActive: true, ...orFilter }),
    }));
  });

  it('listActiveActions keeps scope filtering alongside the tenant filter', async () => {
    await listActiveActions('system', 'tmc');
    expect(actionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ isActive: true, scope: 'system', ...orFilter }),
    }));
  });

  it('listActiveActions without clientNumber keeps the legacy unfiltered where', async () => {
    await listActiveActions();
    const where = actionFindMany.mock.calls[0][0 as never]!['where'];
    expect(where.OR).toBeUndefined();
  });

  it('registerAction persists clientNumber on both create and update arms', async () => {
    await registerAction({
      type: 'send_email', displayName: 'Send email', description: 'd',
      schema: { type: 'object' }, handlerModule: 'm', handlerFunction: 'f',
      clientNumber: 'tmc',
    });
    const args = actionUpsert.mock.calls[0][0];
    expect(args.create.clientNumber).toBe('tmc');
    expect(args.update.clientNumber).toBe('tmc');
  });

  it('registerAction defaults clientNumber to null (system/global action)', async () => {
    await registerAction({
      type: 'send_email', displayName: 'Send email', description: 'd',
      schema: { type: 'object' }, handlerModule: 'm', handlerFunction: 'f',
    });
    const args = actionUpsert.mock.calls[0][0];
    expect(args.create.clientNumber).toBeNull();
  });
});

describe('E3/E5 — searchPersonalChunks is tenant-aware', () => {
  it('with clientNumber the SQL filters on pc.client_number (NULL rows allowed)', async () => {
    await searchPersonalChunks(7, [0.1, 0.2], 3, 'tmc');
    const [sql, ...params] = queryRawUnsafe.mock.calls[0] as unknown as [string, ...any[]];
    expect(sql).toContain('pc.client_number = $2 OR pc.client_number IS NULL');
    expect(params).toEqual([7, 'tmc']);
  });

  it('without clientNumber the legacy user-only SQL is unchanged', async () => {
    await searchPersonalChunks(7, [0.1, 0.2], 3);
    const [sql, ...params] = queryRawUnsafe.mock.calls[0] as unknown as [string, ...any[]];
    expect(sql).not.toContain('client_number');
    expect(params).toEqual([7]);
  });
});

describe('E3/E5 — searchDomainKnowledge is tenant-aware', () => {
  it('with clientNumber the SQL filters on client_number (NULL = global knowledge allowed)', async () => {
    await searchDomainKnowledge('fbr tax filing', { clientNumber: 'tmc' });
    const [sql, ...params] = queryRawUnsafe.mock.calls[0] as unknown as [string, ...any[]];
    expect(sql).toContain('(client_number IS NULL OR client_number = $');
    expect(params).toContain('tmc');
  });

  it('without clientNumber the legacy unfiltered SQL is unchanged', async () => {
    await searchDomainKnowledge('fbr tax filing', {});
    const [sql] = queryRawUnsafe.mock.calls[0] as unknown as [string];
    expect(sql).not.toContain('client_number');
  });
});
