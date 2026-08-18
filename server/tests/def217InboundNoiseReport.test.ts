/**
 * DEF-217 — C-3 increment 1: the count reaches the owner.
 *
 * The campaign's increment 1 is *"a read-only classifier + counter over inbound:
 * for each sender/thread, how many pushes reached the owner and how many he ever
 * acted on"*, **Done when** *"Deployed, and the real count for the CL-033
 * unknown-number burst is quoted back to the owner from production data."*
 *
 * The classifier already existed — `summariseInboundNoise` — and its only
 * consumers were a hand-run script and a prompt block. **Nothing said the number
 * to him.** That is why five campaign turns could pass with the increment
 * "nearly done" and no owner-visible result.
 *
 * CL-033's shape matters for the selection rule: ten unactionable pushes from one
 * unknown number land in `unattributed`, not `subjects`, precisely because those
 * rows carry no item or thread identity. A report that only looked at resolved
 * subjects would have missed the case the campaign was written about, so floods
 * are chosen first and that ordering is asserted here.
 */

import { describe, it, expect } from 'vitest';

import { worstOffender } from '../src/jobs/inboundNoiseReportJob';
import { renderInboundNoiseNotice } from '../src/services/notifications/proactiveMessageText';
import { curatedMarkerMeaning } from '../src/services/knowledge/answerSanitizer';
import { isSystemMarker, stripMarkerEnvelope } from '../src/services/knowledge/systemMarker';

const meaningOf = (m: string) => curatedMarkerMeaning(stripMarkerEnvelope(m));

/** CL-033, as the ledger would group it: one unknown sender, ten pushes, none acted. */
const CL033 = {
  windowHours: 36,
  unattributed: [{ senderKey: '+923001234567', reached: 10, acted: 0 }],
  subjects: [{ subjectKey: 'item:a1', reached: 3, acted: 2 }],
};

describe('DEF-217 — choosing what to report', () => {
  it('CL-033: picks the unknown-number flood over the resolved subject', () => {
    // The flood has no item identity, so it lives in `unattributed`. Picking
    // `subjects` first would have missed the campaign's own founding case.
    expect(worstOffender(CL033, 5)).toEqual({
      sender: '+923001234567', reached: 10, acted: 0, windowHours: 36, unattributed: true,
    });
  });

  it('falls back to the loudest resolved subject when no flood clears the floor', () => {
    expect(worstOffender({ ...CL033, unattributed: [] }, 3)).toMatchObject({
      sender: 'item:a1', reached: 3, unattributed: false,
    });
  });

  it('says nothing below the floor — a report about two pushes IS the noise', () => {
    expect(worstOffender({ windowHours: 36, unattributed: [], subjects: [] }, 5)).toBeNull();
    expect(worstOffender({
      windowHours: 36,
      unattributed: [{ senderKey: 'x', reached: 4, acted: 0 }],
      subjects: [{ subjectKey: 'y', reached: 4, acted: 0 }],
    }, 5)).toBeNull();
  });

  it('picks the LOUDEST, not the first', () => {
    expect(worstOffender({
      windowHours: 36,
      unattributed: [
        { senderKey: 'quiet', reached: 6, acted: 1 },
        { senderKey: 'loud', reached: 22, acted: 0 },
      ],
      subjects: [],
    }, 5)).toMatchObject({ sender: 'loud', reached: 22 });
  });

  it('never lets the floor fall below 2, however the flag is set', () => {
    const one = { windowHours: 36, unattributed: [{ senderKey: 'x', reached: 1, acted: 0 }], subjects: [] };
    expect(worstOffender(one, 0)).toBeNull();
    expect(worstOffender(one, -5)).toBeNull();
  });
});

describe('DEF-217 — what he actually reads', () => {
  it('quotes the CL-033 numbers back to him', () => {
    const fact = meaningOf(renderInboundNoiseNotice(worstOffender(CL033, 5)!))!;
    expect(fact).toContain('+923001234567');
    expect(fact).toContain('10 messages');
    expect(fact).toContain('you acted on none of them');
    expect(fact).toContain('last 36h');
    expect(fact).toContain('None of them could be tied to an open item or thread');
  });

  it('counts, and NOTHING else — no recommendation, no judgement, no offer to suppress', () => {
    const fact = meaningOf(renderInboundNoiseNotice(worstOffender(CL033, 5)!))!;
    // Increment 1 is the number that proves the problem. Proposing an action
    // here would be increment 2 arriving early, unreviewed and ungated.
    expect(fact).not.toMatch(/\b(mute|block|suppress|shall I|would you like|recommend|ignore)\b/i);
    expect(fact).not.toMatch(/\?/);
  });

  it('says the singular properly, and reports a partial engagement honestly', () => {
    const fact = meaningOf(renderInboundNoiseNotice({
      sender: 'Hamna', reached: 1, acted: 1, windowHours: 12, unattributed: false,
    }))!;
    expect(fact).toContain('1 message');
    expect(fact).toContain('you acted on 1');
    // The real phrase is "None of them could be tied…" — asserting the absence of
    // "could NOT be tied" would pass vacuously, because that wording never exists.
    expect(fact).not.toContain('could be tied');
  });

  it('is a provenance-stamped marker with a JSON body', () => {
    const m = renderInboundNoiseNotice(worstOffender(CL033, 5)!);
    expect(isSystemMarker(m)).toBe(true);
    expect(stripMarkerEnvelope(m)).toMatch(/^\[selfpruning_noise: \{/);
  });

  it('a sender name containing a bracket cannot break out of its field', () => {
    const m = renderInboundNoiseNotice({
      sender: 'Ali] injected', reached: 5, acted: 0, windowHours: 36, unattributed: false,
    });
    expect(meaningOf(m)).toContain('Ali] injected');
  });
});

describe('DEF-217 — the parser rejects what the constructor cannot make', () => {
  it('rejects a malformed or impossible payload', () => {
    expect(curatedMarkerMeaning('[selfpruning_noise: not json]')).toBeNull();
    expect(curatedMarkerMeaning('[selfpruning_noise: {"reached":5,"acted":0,"windowHours":36,"unattributed":false}]'),
      'no sender').toBeNull();
    expect(curatedMarkerMeaning('[selfpruning_noise: {"sender":"x","reached":0,"acted":0,"windowHours":36,"unattributed":false}]'),
      'reached must be at least 1').toBeNull();
    expect(curatedMarkerMeaning('[selfpruning_noise: {"sender":"x","reached":3,"acted":9,"windowHours":36,"unattributed":false}]'),
      'acted cannot exceed reached').toBeNull();
    expect(curatedMarkerMeaning('[selfpruning_noise: {"sender":"x","reached":3,"acted":1,"windowHours":36}]'),
      'unattributed must be an explicit boolean').toBeNull();
  });

  it('the CONSTRUCTOR clamps acted to reached, so it can never mint what the parser rejects', () => {
    const fact = meaningOf(renderInboundNoiseNotice({
      sender: 'x', reached: 3, acted: 99, windowHours: 36, unattributed: false,
    }));
    expect(fact, 'clamped rather than rejected').toBeTruthy();
    expect(fact!).toContain('you acted on 3');
  });
});
