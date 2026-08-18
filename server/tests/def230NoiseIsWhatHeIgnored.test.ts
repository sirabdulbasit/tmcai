/**
 * DEF-230 — the first production read refuted the selection rule.
 *
 * C-3 increment 1's Done-when is *"the real count for the CL-033 unknown-number
 * burst is quoted back to the owner from production data"*. On 2026-08-18 that
 * read finally ran (`nexeoInboundNoiseReport.ts`, 200h window, TMC-0001/user 2),
 * and the data said the opposite of the campaign's premise:
 *
 *     +239487846228094 — 14 delivered, 14 answered (0% unanswered)
 *     item:cmsernsi…   — 17 delivered via 4 producers
 *                        (preactive_due_nudge 7×, action_lifecycle_governor 5×,
 *                         action_lifecycle_reply 4×, delegation_capture 1×),
 *                        10 answered
 *     BURSTS=0
 *
 * **The unknown number is not the noise — he answered every one of its
 * messages.** The noise is one open item pushed seventeen times by four
 * subsystems that do not know about each other.
 *
 * DEF-217's `worstOffender` ranked by `reached` and preferred `unattributed`
 * outright, so on this exact data its FIRST-EVER message to the owner would have
 * complained about the one thread he handled completely, and said nothing about
 * the 17-push item. Verified before the fix: the old rule returns
 * `+239487846228094, reached 14, acted 14`.
 *
 * Three rule changes, each pinned below:
 *   1. rank and floor on `reached - acted`, not `reached`;
 *   2. no category preference — subjects and unattributed compete on one number;
 *   3. the producer count travels to the notice, because "four uncoordinated
 *      nudgers" is the finding and `SubjectGroup.producers` existed precisely so
 *      that would be *"a fact the data states rather than arithmetic in a build
 *      entry"* — and the old selection threw it away (DEF-219's shape: the
 *      information existed and nothing read it).
 */

import { describe, it, expect } from 'vitest';

import { worstOffender } from '../src/jobs/inboundNoiseReportJob';
import { renderInboundNoiseNotice } from '../src/services/notifications/proactiveMessageText';
import { curatedMarkerMeaning } from '../src/services/knowledge/answerSanitizer';
import { stripMarkerEnvelope } from '../src/services/knowledge/systemMarker';

const meaningOf = (m: string) => curatedMarkerMeaning(stripMarkerEnvelope(m));

/** The 2026-08-18 production read, as the ledger grouped it. */
const PRODUCTION = {
  windowHours: 200,
  unattributed: [
    { senderKey: '+239487846228094', reached: 14, acted: 14 },
    { senderKey: 'system:delegation_capture', reached: 2, acted: 0 },
  ],
  subjects: [
    { subjectKey: 'item:cmsernsi1000orto96r3kcmsk', reached: 17, acted: 10, producers: [1, 2, 3, 4] },
    { subjectKey: 'item:cmsernb0o000mrto983hvi22t', reached: 12, acted: 5, producers: [1, 2, 3] },
  ],
};

describe('DEF-230 — on the real production data', () => {
  it('THE REFUTATION: the fully-answered number is never the report', () => {
    const w = worstOffender(PRODUCTION, 5)!;
    expect(w.sender).not.toBe('+239487846228094');
  });

  it('the 17-push four-producer item is what he is told about', () => {
    expect(worstOffender(PRODUCTION, 5)).toEqual({
      sender: 'item:cmsernsi1000orto96r3kcmsk',
      reached: 17,
      acted: 10,
      windowHours: 200,
      unattributed: false,
      producers: 4,
    });
  });

  it('a fully-answered sender is silence even when NOTHING else qualifies', () => {
    // The old rule's worst case in isolation: only the answered thread exists.
    // Reporting it would make the noise report itself the noise.
    expect(worstOffender({
      windowHours: 200,
      unattributed: [{ senderKey: '+239487846228094', reached: 14, acted: 14 }],
      subjects: [],
    }, 5)).toBeNull();
  });
});

describe('DEF-230 — the rule, not just the instance', () => {
  it('ranks by UNANSWERED, with reached only as the tiebreak', () => {
    expect(worstOffender({
      windowHours: 36,
      unattributed: [{ senderKey: 'loud-but-answered', reached: 30, acted: 26 }], // ignored 4
      subjects: [{ subjectKey: 'item:quietly-ignored', reached: 8, acted: 0 }],   // ignored 8
    }, 3)!.sender).toBe('item:quietly-ignored');
  });

  it('equal unanswered → the noisier one wins the tiebreak', () => {
    expect(worstOffender({
      windowHours: 36,
      unattributed: [],
      subjects: [
        { subjectKey: 'item:a', reached: 6, acted: 0 },   // ignored 6
        { subjectKey: 'item:b', reached: 10, acted: 4 },  // ignored 6, noisier
      ],
    }, 3)!.sender).toBe('item:b');
  });

  it('the floor is on unanswered too — 10 delivered / 7 answered is not a report at floor 5', () => {
    expect(worstOffender({
      windowHours: 36,
      unattributed: [{ senderKey: 'x', reached: 10, acted: 7 }],
      subjects: [],
    }, 5)).toBeNull();
  });

  it('an unattributed flood he ignored still wins — the CL-033 shape is kept, on merit', () => {
    // Category preference is gone; a real ten-ignored flood beats a
    // three-ignored subject on the number, not on its bucket.
    expect(worstOffender({
      windowHours: 36,
      unattributed: [{ senderKey: '+92300', reached: 10, acted: 0 }],
      subjects: [{ subjectKey: 'item:a', reached: 5, acted: 2 }],
    }, 5)).toMatchObject({ sender: '+92300', unattributed: true });
  });

  it('a malformed group (acted > reached) is excluded by the floor, never ranked', () => {
    // Written expecting a Math.max(0,…) clamp to be load-bearing; mutation
    // proved it equivalent — the floor filter runs first and floor >= 2, so a
    // negative difference never reaches the sort. The clamp was deleted and
    // THIS is the property that actually protects the behaviour.
    expect(worstOffender({
      windowHours: 36,
      unattributed: [{ senderKey: 'broken', reached: 3, acted: 99 }],
      subjects: [{ subjectKey: 'item:a', reached: 9, acted: 2 }],
    }, 3)!.sender).toBe('item:a');
  });
});

describe('DEF-230 — the producer count reaches the owner', () => {
  it('the notice says the pushes came from N different subsystems', () => {
    const fact = meaningOf(renderInboundNoiseNotice(worstOffender(PRODUCTION, 5)!))!;
    expect(fact).toContain('17 messages');
    expect(fact).toContain('from 4 different subsystems');
    expect(fact).toContain('you acted on 10');
  });

  it('producers=1 is every normal push and is NOT stated', () => {
    const m = renderInboundNoiseNotice({
      sender: 'item:a', reached: 6, acted: 0, windowHours: 36, unattributed: false, producers: 1,
    });
    expect(m).not.toContain('"producers"');
    expect(meaningOf(m)!).not.toContain('subsystems');
  });

  it('absent producers renders exactly as before — the DEF-217 sentence is unchanged', () => {
    const fact = meaningOf(renderInboundNoiseNotice({
      sender: '+923001234567', reached: 10, acted: 0, windowHours: 36, unattributed: true,
    }))!;
    expect(fact).toBe(
      'In the last 36h, +923001234567 reached you with 10 messages and you acted on none of them.'
      + ' None of them could be tied to an open item or thread.');
  });

  it('the PARSER rejects a producers value the constructor cannot mint', () => {
    const base = '"sender":"x","reached":5,"acted":0,"windowHours":36,"unattributed":false';
    expect(curatedMarkerMeaning(`[selfpruning_noise: {${base},"producers":1}]`),
      'below the constructor floor of 2').toBeNull();
    expect(curatedMarkerMeaning(`[selfpruning_noise: {${base},"producers":9}]`),
      'more producers than pushes').toBeNull();
    expect(curatedMarkerMeaning(`[selfpruning_noise: {${base},"producers":"4"}]`),
      'non-integer').toBeNull();
    expect(curatedMarkerMeaning(`[selfpruning_noise: {${base},"producers":4}]`),
      'a valid one still parses').toContain('4 different subsystems');
  });
});
