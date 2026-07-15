import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { errorHandler } from '../errorHandler';

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}
const mockReq = () => ({ path: '/x' } as Request);

describe('errorHandler (M8)', () => {
  const origNodeEnv = process.env.NODE_ENV;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    process.env.NODE_ENV = origNodeEnv;
  });

  it('in production: masks raw message on a generic Error', () => {
    process.env.NODE_ENV = 'production';
    const res = mockRes();
    const err = new Error('SELECT * FROM users WHERE password_hash = ...');
    (err as any).status = 500;
    errorHandler(err, mockReq(), res, () => {});
    expect(res.status).toHaveBeenCalledWith(500);
    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.error).not.toContain('SELECT');
    expect(payload.error).toMatch(/unexpected error/i);
  });

  it('in production: passes through messages for safe error names', () => {
    process.env.NODE_ENV = 'production';
    const res = mockRes();
    const err: any = new Error('Name is required');
    err.name = 'ValidationError';
    err.status = 400;
    errorHandler(err, mockReq(), res, () => {});
    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.error).toBe('Name is required');
  });

  it('in production: returns generic bucket for 404 / 403 / 401', () => {
    process.env.NODE_ENV = 'production';
    for (const [status, expected] of [[404, /not found/i], [403, /forbidden/i], [401, /auth/i]] as const) {
      const res = mockRes();
      errorHandler({ status, message: 'weird-internal-detail' }, mockReq(), res, () => {});
      const payload = (res.json as any).mock.calls[0][0];
      expect(payload.error).toMatch(expected);
    }
  });

  it('in development: passes through err.message raw', () => {
    process.env.NODE_ENV = 'development';
    const res = mockRes();
    const err = new Error('internal detail');
    (err as any).status = 500;
    errorHandler(err, mockReq(), res, () => {});
    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.error).toBe('internal detail');
  });
});
