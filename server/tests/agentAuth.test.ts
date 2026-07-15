import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// E1 — agent auth previously trusted the client-supplied X-Tenant-Id header:
// any holder of the single PLATFORM_API_TOKEN could operate as ANY tenant's
// SA. Tokens are now provisioned per tenant in agent_api_tokens (sha256
// hash); the middleware verifies the token↔tenant binding and returns 403
// on mismatch — no scope entered, no fall-through.

const findFirstToken = vi.fn();
const updateManyToken = vi.fn(async () => ({ count: 1 }));
const findFirstUser = vi.fn(async () => ({ id: 7 }));
const runInTenantScope = vi.fn(async (_ctx: any, cb: any) => cb());

vi.mock('../src/db/prisma', () => ({
  default: {
    agentApiToken: { findFirst: (...a: any[]) => findFirstToken(...a), updateMany: (...a: any[]) => updateManyToken(...a) },
    user: { findFirst: (...a: any[]) => findFirstUser(...a) },
  },
}));
vi.mock('../src/db/tenantContext', () => ({ runInTenantScope: (...a: any[]) => runInTenantScope(...a) }));

import { agentAuthMiddleware } from '../src/middleware/agentAuthMiddleware';

const RAW = 'tok_' + 'a'.repeat(44);
const HASH = crypto.createHash('sha256').update(RAW, 'utf8').digest('hex');

function mkReq(headers: Record<string, string>) {
  const req: any = { headers, path: '/agent/thing' };
  const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn();
  return { req, res, next };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agentAuthMiddleware (tenant-bound tokens)', () => {
  it('accepts a token bound to the requested tenant and enters its scope', async () => {
    findFirstToken.mockResolvedValueOnce({ id: 't1', clientNumber: 'tmc', isActive: true });
    const { req, res, next } = mkReq({ authorization: `Bearer ${RAW}`, 'x-tenant-id': 'tmc', 'x-agent-id': 'adk-1' });
    await agentAuthMiddleware(req, res, next);
    expect(findFirstToken).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tokenHash: HASH, clientNumber: 'tmc', isActive: true }),
    }));
    expect(req.user).toMatchObject({ clientNumber: 'tmc', isAgent: true, userType: 'SA' });
    expect(runInTenantScope).toHaveBeenCalledWith(expect.objectContaining({ clientNumber: 'tmc' }), expect.any(Function));
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a valid token used with a tenant it is NOT bound to — 403, no scope', async () => {
    findFirstToken
      .mockResolvedValueOnce(null) // not bound to requested tenant
      .mockResolvedValueOnce({ id: 't1', clientNumber: 'tmc', isActive: true }); // but token is known
    const { req, res, next } = mkReq({ authorization: `Bearer ${RAW}`, 'x-tenant-id': 'other-tenant' });
    await agentAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(runInTenantScope).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('rejects a known token with no X-Tenant-Id header — 403', async () => {
    findFirstToken.mockResolvedValueOnce({ id: 't1', clientNumber: 'tmc', isActive: true });
    const { req, res, next } = mkReq({ authorization: `Bearer ${RAW}` });
    await agentAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('falls through for an unknown bearer (other auth may claim it)', async () => {
    findFirstToken.mockResolvedValue(null);
    const { req, res, next } = mkReq({ authorization: 'Bearer some-other-jwt', 'x-tenant-id': 'tmc' });
    await agentAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('falls through when no Authorization header is present', async () => {
    const { req, res, next } = mkReq({ 'x-tenant-id': 'tmc' });
    await agentAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(findFirstToken).not.toHaveBeenCalled();
  });

  it('no longer grants access via the legacy PLATFORM_API_TOKEN env var', async () => {
    process.env.PLATFORM_API_TOKEN = RAW; // legacy config still present
    findFirstToken.mockResolvedValue(null); // but token not provisioned in DB
    const { req, res, next } = mkReq({ authorization: `Bearer ${RAW}`, 'x-tenant-id': 'tmc' });
    await agentAuthMiddleware(req, res, next);
    expect(req.user).toBeUndefined();
    expect(runInTenantScope).not.toHaveBeenCalled();
    delete process.env.PLATFORM_API_TOKEN;
  });
});
