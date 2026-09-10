import { describe, it, expect, vi } from 'vitest';
import { requireAdmin } from '../src/middleware/auth';

// AN ERROR THAT NAMES THE WRONG CAUSE IS WORSE THAN A VAGUE ONE.
//
// requireAdmin answered both "not signed in" and "signed in but not admin" with "Admin
// access required". The Build Pulse deck renders that string verbatim, so an expired
// session read on screen as: "Pulse unreadable (Admin access required)". The owner asked
// about his access while his account was SA, active, and entirely fine — the message sent
// him to inspect the thing that was not broken.

const res = () => {
  const r: any = { code: 0, body: null };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
};

describe('requireAdmin — two conditions, two sentences', () => {
  it('says SESSION, not permissions, when there is no user at all', () => {
    const r = res(); const next = vi.fn();
    requireAdmin({} as any, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.body.error).toMatch(/signed in|session/i);
    expect(r.body.error).not.toMatch(/Admin access required/);
  });

  it('still says ADMIN when a real user simply is not one', () => {
    const r = res(); const next = vi.fn();
    requireAdmin({ user: { id: 9, isAdmin: false } } as any, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.body.error).toBe('Admin access required');
  });

  it('lets an admin through untouched', () => {
    const r = res(); const next = vi.fn();
    requireAdmin({ user: { id: 2, isAdmin: true } } as any, r, next);
    expect(next).toHaveBeenCalledOnce();
    expect(r.code).toBe(0);
  });

  it('keeps 403 for both refusals — the status code is deliberately unchanged', () => {
    const a = res(); requireAdmin({} as any, a, vi.fn());
    const b = res(); requireAdmin({ user: { isAdmin: false } } as any, b, vi.fn());
    expect(a.code).toBe(403);
    expect(b.code).toBe(403);
  });
});
