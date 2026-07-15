import { describe, it, expect } from 'vitest';
import { registerAllHandlers, resetAllHandlers } from '../src/services/actions/handlers/index';
import { listAll } from '../src/services/actions/handlerRegistry';
import { ActionHandler } from '../src/services/actions/handlerBase';

// B2 — handlerBase.confirm() used to default to `return true`, so a handler
// with no real read-back was treated as confirmed. Every registered handler
// must now implement its OWN confirm() (the base class no longer provides
// one). A missing confirmation must never read as success.

describe('B2 — confirm() invariant', () => {
  it('every registered handler implements its own confirm()', () => {
    // Fix 6 (2026-07-09): use resetAllHandlers (the "true reset")
    // instead of raw handlerRegistry.reset — the latter clears the
    // Map but not registerAllHandlers's module-level once-guard,
    // which would leave the registry empty after re-registering.
    resetAllHandlers();
    registerAllHandlers();
    const handlers = listAll();
    expect(handlers.length).toBeGreaterThan(20);
    const missing = handlers
      .filter((h) => {
        // walk the prototype chain up to (but not including) ActionHandler
        let proto = Object.getPrototypeOf(h);
        while (proto && proto.constructor !== ActionHandler) {
          if (Object.getOwnPropertyNames(proto).includes('confirm')) return false;
          proto = Object.getPrototypeOf(proto);
        }
        return true; // reached base without finding an own confirm
      })
      .map((h) => h.metadata().name);
    expect(missing).toEqual([]);
  });

  it('the base class provides no confirm() default', () => {
    expect(Object.getOwnPropertyNames(ActionHandler.prototype)).not.toContain('confirm');
  });
});
