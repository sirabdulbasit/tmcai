import { describe, it, expect } from 'vitest';
import { sanitizePayloadInput } from '../src/services/actions/executeViaRegistry';

// Fix 1 (2026-07-09) — cross-tenant seed vector.
//
// The B4 reconciler joins a stuck 'executing' AgentAction row back to
// action_idempotency_log via the row's `input._idempotencyKey`. The
// executor STAMPS that key on the row itself, but the stamping update
// is wrapped in try/catch (non-fatal by design). A caller-supplied
// payload can therefore SEED the field with an attacker-controlled
// value — if the stamping update fails after seed persists, the
// seeded key survives and points the reconciler at another tenant's
// log row (see b4Reconciliation.test.ts's SECURITY block).
//
// The defence is: sanitize the payload BEFORE any DB write. Only the
// executor's own stamping code may ever write _idempotencyKey.
describe('sanitizePayloadInput — seed-vector strip', () => {
  it('removes an incoming _idempotencyKey from the payload', () => {
    const raw = { to: ['x@y.com'], _idempotencyKey: 'evil' };
    const clean = sanitizePayloadInput(raw);
    expect((clean as any)._idempotencyKey).toBeUndefined();
    expect((clean as any).to).toEqual(['x@y.com']);
  });

  it('does not mutate the caller\'s original payload object', () => {
    const raw = { to: ['x@y.com'], _idempotencyKey: 'evil' };
    const clean = sanitizePayloadInput(raw);
    expect((raw as any)._idempotencyKey).toBe('evil');
    expect(clean).not.toBe(raw);
  });

  it('is a no-op when no _idempotencyKey is present', () => {
    const raw = { to: ['x@y.com'], subject: 'hi' };
    const clean = sanitizePayloadInput(raw);
    expect(clean).toEqual(raw);
  });

  it('accepts empty payload safely', () => {
    expect(sanitizePayloadInput({})).toEqual({});
  });

  it('strips even when the key is nested-shape null / numeric (defence-in-depth)', () => {
    // Bag the field regardless of type — an attacker could try
    // { _idempotencyKey: null } to bypass a `!!key` check.
    expect((sanitizePayloadInput({ _idempotencyKey: null } as any) as any)._idempotencyKey).toBeUndefined();
    expect((sanitizePayloadInput({ _idempotencyKey: 0 } as any) as any)._idempotencyKey).toBeUndefined();
    expect((sanitizePayloadInput({ _idempotencyKey: 'evil' } as any) as any)._idempotencyKey).toBeUndefined();
  });
});
