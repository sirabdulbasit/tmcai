/**
 * DEF-064 — the reply was identified, correlated, and then discarded.
 *
 * Production, 2026-08-06 14:00:13, four log lines in the same second:
 *
 *   lid alias hit             → Hamna Latif Bhutta        identity: solved
 *   correlation inferred      → wa:+923134199294          thread: found
 *   inbound consume failed    → reason: illegal_transition
 *   Unregistered number       → triaged, held_pending
 *
 * Her answer — "Numair Mazhar has not sent the APIs yet." — was thrown to
 * stranger-triage after two hard problems had already been solved for it.
 *
 * ACTIVE_THREAD_STATES is much wider than the set that can accept a reply.
 * awaiting_owner, resolved_pending_owner, followup_scheduled and reopened are
 * all "active", and none permits `→ evaluating`. Recency picked one of hers
 * that this morning's reply had already resolved, the transition was rejected,
 * and capture reported no_thread.
 *
 * Two guarantees now:
 *   1. Correlation can only choose a thread that can legally take the reply.
 *   2. If a KNOWN person answers and none of their threads can take it, the
 *      owner is told anyway. The state machine is our bookkeeping; losing her
 *      words over it is not acceptable.
 */
import { describe, it, expect } from 'vitest';
import { renderUnattachedReply } from '../src/services/notifications/proactiveMessageText';
import fs from 'fs';
import path from 'path';
import {
  THREAD_TRANSITIONS, ACTIVE_THREAD_STATES, REPLY_CONSUMABLE_STATES, canConsumeReply,
} from '../src/services/delegation/delegationThreadService';

const CODE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'delegation', 'delegationCaptureService.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('DEF-064 — only a thread that can take a reply is chosen', () => {
  it('the states that bit us are active but NOT consumable', () => {
    for (const st of ['resolved_pending_owner', 'awaiting_owner', 'followup_scheduled', 'reopened']) {
      expect(ACTIVE_THREAD_STATES, `${st} is treated as active`).toContain(st as any);
      expect(canConsumeReply(st), `${st} must not be chosen for a reply`).toBe(false);
    }
  });

  it('the ones that can take a reply do', () => {
    for (const st of ['awaiting_reply', 'dispatch_pending', 'receipt_unknown']) {
      expect(canConsumeReply(st), `${st} should accept a reply`).toBe(true);
    }
  });

  it('the list is DERIVED from the transition table, never hand-written', () => {
    // Hand-listing would go stale the first time someone edits the state
    // machine, and the failure would be silent — a dropped reply.
    const derived = Object.keys(THREAD_TRANSITIONS)
      .filter((from) => THREAD_TRANSITIONS[from]?.includes('evaluating' as any))
      .sort();
    expect([...REPLY_CONSUMABLE_STATES].sort()).toEqual(derived);
  });

  it('correlation filters on it before the recency tie-break', () => {
    expect(CODE).toMatch(/actuallySent\.filter\(\(c: any\) => canConsumeReply\(c\.state\)\)/);
  });
});

describe("DEF-064 — a known person's reply is never discarded", () => {
  it('relays when every thread of theirs has moved past taking replies', () => {
    expect(CODE).toMatch(/knownButClosedToReplies/);
    expect(CODE).toMatch(/notifyOwnerOfUnattachedReply/);
  });

  it('but NOT when we never actually messaged them', () => {
    // An unsent dispatch_pending thread means no outbound reached them, so an
    // inbound is not a reply to us. Kept distinct from "closed to replies".
    expect(CODE).toMatch(/knownButClosedToReplies = eligible\.length === 0 && actuallySent\.length > 0/);
  });

  it('the relay names the person and says plainly it is unattached', () => {
    // Upgraded from a source-text grep to the rendered output (DEF-155).
    //
    // This test used to read `delegationCaptureService.ts` and match the template
    // literally. DEF-155 moved that template into `proactiveMessageText` so the
    // proactive slice could score it, and this assertion failed — correctly: the
    // string was no longer where it looked. Re-pointing the grep would have kept a
    // weaker check; calling the renderer asserts the PROPERTY the test is named
    // for, and would survive the template moving again.
    const relayed = renderUnattachedReply({ who: 'Hamna Latif Bhutta', body: 'ok noted' });
    expect(relayed, 'the person must be named').toMatch(/^Hamna Latif Bhutta replied:/);
    expect(relayed, 'their words must be quoted verbatim').toContain('"ok noted"');
    expect(relayed).toMatch(/Not attached to an open request/);
    // And the relay still goes through the shared path, so the property above is
    // a property of what ships rather than of an unused function. DEF-156 put a
    // decision seam in front of the renderer, so the service now calls that and
    // the seam renders — one implementation, one hop further out.
    expect(CODE).toMatch(/decideUnattachedReply\(/);
    expect(CODE).toMatch(/question: decision\.renderedMessage/);
  });

  it('it is a notice — it must not hold the conversational lock', () => {
    // Was `body.slice(0, 1500)`. DEF-156 added a window lookup ahead of the
    // enqueue and pushed the flag past 1500 characters, so the test failed on
    // its own arbitrary cutoff rather than on the property. Scoped to the
    // function instead of to a byte count — the property is "this function marks
    // it a notice", and that is now what is read.
    const start = CODE.indexOf('async function notifyOwnerOfUnattachedReply');
    const rest = CODE.slice(start);
    const fn = rest.slice(0, rest.indexOf('\nasync function', 10));
    expect(fn).toMatch(/expectsReply: false/);
  });

  it('and it changes no thread state — bookkeeping stays untouched', () => {
    const body = CODE.slice(CODE.indexOf('async function notifyOwnerOfUnattachedReply'));
    const fn = body.slice(0, body.indexOf('\nasync function', 10));
    expect(fn).not.toMatch(/appendEventWithTransition|delegationThread\.update/);
  });
});

describe('DEF-080 — the answer reaches him before any question about it', () => {
  it('a reported completion is a notice, not a question', () => {
    // 2026-08-06: prompt 277 ("that reply matched 3 open threads") reached him
    // because it was marked a notice; 276, the actual answer, sat queued
    // because it was not. He got the footnote and not the content.
    // Slice from the NOTIFY branch, not the outcome-mapping expression above
    // it — an earlier version of this test matched the wrong occurrence.
    const branch = CODE.slice(CODE.indexOf("if (outcome === 'completed')"));
    expect(branch.slice(0, 600)).toMatch(/expectsReply: false/);
  });

  it('so is an unclear reply — he still hears that they answered', () => {
    const branch = CODE.slice(CODE.indexOf("else if (outcome === 'low_confidence')"));
    expect(branch.slice(0, 500)).toMatch(/expectsReply: false/);
  });
});
