/**
 * DEF-326 — the liveness probe never attempts revoke-for-everyone.
 *
 * The owner re-paired a new number on 2026-09-04 at 12:43:11 and WhatsApp logged the session
 * out at 12:48:12 — five minutes. The OLD number had run this same code for 1h45m and stopped
 * only because he reset it, so the variable that changed was the number's age, not the
 * software. WhatsApp never says why it ends a session.
 *
 * But the probe is the one input we control, and it fires within milliseconds of `ready`: a
 * self-message followed immediately by `delete(true)` — revoke for everyone — on an account
 * with no history. `webjsLiveness.ts` had already argued the case against it in its own
 * comments: "in the account's OWN chat there is no one else to revoke for, and the goal here is
 * only to remove it from the owner's view — which is exactly `delete(false)`, delete-for-me."
 * It was tried first anyway.
 *
 * This test pins the removal so it cannot drift back the next time someone tunes the cleanup.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Comments stripped (BLD-009): this fix's comments necessarily quote `delete(true)` and
// `[true, false]`, so an assertion could pass on a comment while the code was gone.
const src = readFileSync(join(__dirname, '..', 'src', 'services', 'whatsapp', 'webjsLiveness.ts'), 'utf-8')
  .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

describe('DEF-326 — a fresh pairing is not greeted by a revoke-for-everyone', () => {
  it('never iterates the revoke-for-everyone strategy', () => {
    // Mutation: restore `[true, false]` and this dies.
    expect(src).not.toContain('[true, false]');
    expect(src).toContain('for (const everyone of [false])');
  });

  it('still deletes the probe marker — the cleanup is kept, only the revoke is dropped', () => {
    // Removing cleanup altogether would leave a marker in his self-chat on every reconnect,
    // which is a different defect. The delete call itself must survive.
    expect(src).toContain('await target.delete(everyone)');
  });

  it('has NO revoke-for-everyone anywhere in the file — both delete paths', () => {
    // THE ASSERTION THIS TEST SHOULD HAVE OPENED WITH. The first version pinned only the echo
    // loop, and a SECOND `delete(true)` sat four lines below it on the send-promise path,
    // untouched. It survived my change and was caught only because DEF-276's suite exercises
    // both paths. `protection-with-two-implementations` again — a guard fixed in one of its two
    // copies is not fixed — so the assertion is now over the whole file, not one call site.
    expect(src).not.toMatch(/\.delete\(\s*true\s*\)/);
    // And every delete that remains is delete-for-me.
    const deletes = src.match(/\.delete\([^)]*\)/g) ?? [];
    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes) expect(d).not.toContain('true');
  });

  it('passes a literal false, never a computed flag that could become true', () => {
    const loop = /for \(const everyone of \[([^\]]*)\]\)/.exec(src);
    expect(loop).not.toBeNull();
    expect(loop![1].trim()).toBe('false');
  });
});
