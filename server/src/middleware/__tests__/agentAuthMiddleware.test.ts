import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock prisma before importing the middleware
vi.mock('../../db/prisma', () => ({
  default: {
    user: {
      findFirst: vi.fn(async () => ({ id: 42 })),
    },
  },
}));

// Mock logger to suppress output during tests
vi.mock('../../utils/logger', () => ({
  default: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { agentAuthMiddleware, getExpectedAgentToken } from '../agentAuthMiddleware';

const VALID_TOKEN = 'a'.repeat(64); // 64 chars, well above 32 minimum

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: '/api/v1/test',
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  return {} as Response;
}

describe('agentAuthMiddleware — security', () => {
  const origEnv = process.env.PLATFORM_API_TOKEN;

  beforeEach(() => {
    delete process.env.PLATFORM_API_TOKEN;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.PLATFORM_API_TOKEN;
    else process.env.PLATFORM_API_TOKEN = origEnv;
  });

  // ── Fallback elimination ───────────────────────────────────────

  it('returns null from getExpectedAgentToken when PLATFORM_API_TOKEN is unset', () => {
    expect(getExpectedAgentToken()).toBeNull();
  });

  it('returns null when PLATFORM_API_TOKEN is shorter than 32 chars', () => {
    process.env.PLATFORM_API_TOKEN = 'short';
    expect(getExpectedAgentToken()).toBeNull();
  });

  it('does NOT accept the known dev-fallback string', async () => {
    // This is the string that used to exist in source. It must never grant access.
    const req = mockReq({
      headers: {
        authorization: 'Bearer dev-local-platform-token-change-me',
        'x-tenant-id': 'TMC-0001',
      },
    });
    const next = vi.fn();
    await agentAuthMiddleware(req, mockRes(), next as NextFunction);
    expect((req as any).user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not attach req.user when PLATFORM_API_TOKEN is unset, even with a valid-looking bearer', async () => {
    const req = mockReq({
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        'x-tenant-id': 'TMC-0001',
      },
    });
    const next = vi.fn();
    await agentAuthMiddleware(req, mockRes(), next as NextFunction);
    expect((req as any).user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  // ── Happy path ────────────────────────────────────────────────

  it('attaches synthetic SA user when token matches and tenant header is present', async () => {
    process.env.PLATFORM_API_TOKEN = VALID_TOKEN;
    const req = mockReq({
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        'x-tenant-id': 'TMC-0001',
        'x-agent-id': 'brain-orchestrator',
      },
    });
    const next = vi.fn();
    await agentAuthMiddleware(req, mockRes(), next as NextFunction);
    expect((req as any).user).toMatchObject({
      id: 42,
      clientNumber: 'TMC-0001',
      userType: 'SA',
      isAgent: true,
      agentId: 'brain-orchestrator',
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not attach user when tenant header is missing', async () => {
    process.env.PLATFORM_API_TOKEN = VALID_TOKEN;
    const req = mockReq({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const next = vi.fn();
    await agentAuthMiddleware(req, mockRes(), next as NextFunction);
    expect((req as any).user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  // ── Constant-time comparison ──────────────────────────────────

  it('rejects a token of different length (timing-safe comparison)', async () => {
    process.env.PLATFORM_API_TOKEN = VALID_TOKEN;
    const req = mockReq({
      headers: {
        authorization: `Bearer ${VALID_TOKEN}short`,
        'x-tenant-id': 'TMC-0001',
      },
    });
    const next = vi.fn();
    await agentAuthMiddleware(req, mockRes(), next as NextFunction);
    expect((req as any).user).toBeUndefined();
  });

  it('rejects a token of equal length but different content', async () => {
    process.env.PLATFORM_API_TOKEN = VALID_TOKEN;
    const wrong = 'b'.repeat(64); // same length, different content
    const req = mockReq({
      headers: {
        authorization: `Bearer ${wrong}`,
        'x-tenant-id': 'TMC-0001',
      },
    });
    const next = vi.fn();
    await agentAuthMiddleware(req, mockRes(), next as NextFunction);
    expect((req as any).user).toBeUndefined();
  });

  it('falls through when no Authorization header is present', async () => {
    process.env.PLATFORM_API_TOKEN = VALID_TOKEN;
    const req = mockReq({ headers: {} });
    const next = vi.fn();
    await agentAuthMiddleware(req, mockRes(), next as NextFunction);
    expect((req as any).user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});
