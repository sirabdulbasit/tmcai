import { describe, it, expect } from 'vitest';
import { register, reset, has, listAll } from '../src/services/actions/handlerRegistry';
import { registerAllHandlers, resetAllHandlers } from '../src/services/actions/handlers/index';
import { ActionHandler } from '../src/services/actions/handlerBase';

// Fix 6 (2026-07-09) — the registry-reset footgun.
//
// handlerRegistry.reset() clears the Map, but registerAllHandlers()
// has a module-level `registered` flag that survives the clear. In one
// module lifetime the sequence:
//   reset()               // registry empty
//   registerAllHandlers() // no-op because `registered` is still true
// leaves the registry EMPTY. Tests happened to survive only because
// vitest re-imports modules per file (each file gets a fresh
// `registered = false`), and registryCoreVerbs.test.ts carries a
// workaround comment warning "never reset() between cases".
//
// resetAllHandlers() is the true reset: clears the Map AND flips the
// `registered` flag. Production behaviour is unchanged (no runtime
// caller had a reason to reset), and tests that need a clean slate
// now have one correct primitive.

// A tiny fake handler so we can exercise the primitives without
// relying on the real ones (which registerAllHandlers pulls in).
class FakeHandler extends ActionHandler {
  metadata() { return { name: 'x_fake', category: 'brain' as const, description: 'f', version: '0.0' }; }
  schema() { return {}; }
  auditFields() { return []; }
  async validate() { return { valid: true }; }
  async dryRun() { return { wouldSucceed: true }; }
  async execute() { return { ok: true, output: {} }; }
  async confirm() { return true; }
}

describe('registry reset footgun', () => {
  it('resetAllHandlers() lets registerAllHandlers() populate the registry again', () => {
    // Populate once, sanity-check.
    resetAllHandlers();
    registerAllHandlers();
    const first = listAll().length;
    expect(first).toBeGreaterThan(20); // matches confirmInvariant expectation

    // The unsafe pattern (raw reset()) is precisely what this fix
    // rescues. Prove the safe pattern (resetAllHandlers) works.
    resetAllHandlers();
    expect(listAll().length).toBe(0);

    // After resetAllHandlers, registerAllHandlers must repopulate —
    // the module-level once-guard has been flipped, so the registry
    // fills up to the same count as the sanity pass.
    registerAllHandlers();
    expect(listAll().length).toBe(first);
  });

  it('the raw reset() alone is still footgunned — this test PINS why we need resetAllHandlers', () => {
    // Start clean via the safe primitive.
    resetAllHandlers();
    registerAllHandlers();
    const populated = listAll().length;
    expect(populated).toBeGreaterThan(20);

    // Raw reset clears the map...
    reset();
    expect(listAll().length).toBe(0);
    // ...but registerAllHandlers's once-guard fires (registered=true
    // still) → empty registry. If this ever starts passing populated>0
    // it means the once-guard was removed and this fix's justification
    // no longer holds — bring the comment up to date.
    registerAllHandlers();
    expect(listAll().length).toBe(0);

    // Re-arm for later tests via the correct primitive.
    resetAllHandlers();
  });

  it('register throws on duplicate registration — the once-guard is not the only defence', () => {
    // The once-guard was added because production shouldn't re-register.
    // register() itself already throws on collision; resetAllHandlers +
    // registerAllHandlers must return the caller to a state where a
    // FRESH register() call still throws on the second call (i.e. the
    // registry is authoritative on names). Small integration guard so
    // resetAllHandlers doesn't quietly become "clear and permit dupes".
    resetAllHandlers();
    register(new FakeHandler());
    expect(has('x_fake')).toBe(true);
    expect(() => register(new FakeHandler())).toThrow(/already registered/);
    resetAllHandlers(); // clean up
  });
});
