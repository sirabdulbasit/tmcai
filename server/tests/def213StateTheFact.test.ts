/**
 * DEF-213 — state the fact, not the bookkeeping.
 *
 * `B12-reminder-referent` is the worst pair left in the fix queue, and both
 * halves are one sentence:
 *
 *     "…my own dispatch log doesn't have a record of why that happened."
 *
 *   C4 80  "feels a little too mechanical and like it's explaining its internal
 *           workings rather than just stating a simple 'I don't know why it
 *           happened'."
 *   C1 85  "it implies a dispatch log exists and was checked, which isn't
 *           explicitly confirmed as an actual action."
 *
 * The second one is the serious half: the sentence asserts a lookup the owner
 * cannot verify and Brain may not have performed.
 *
 * And Brain is echoing THIS BLOCK. `pushHistoryBlock` said "your record shows",
 * "this record covers", "say your own record is unavailable" — first-person
 * machine vocabulary, supplied by me, in the one place the model is told how to
 * talk about this subject.
 *
 * That distinction is why this is not another prompt wish. DEF-206's lesson was
 * that ASKING a model to fill a field is not a guarantee — it is behaviour the
 * model must choose to perform. This is the opposite direction: removing the
 * source string the model was copying. The tests below therefore assert the
 * ABSENCE of the vocabulary from every rendered surface, not the presence of an
 * instruction, because absence is the part that cannot be ignored.
 */

import { describe, it, expect } from 'vitest';

import {
  renderPushHistoryBlock,
  renderPushHistoryUnavailable,
} from '../src/services/selfpruning/pushHistoryBlock';

/**
 * The phrases the block ITSELF used to supply — second person, addressed to the
 * model as instructions about "your record". These are what B12 echoed back in
 * the first person, so these are what must be gone.
 *
 * The first-person forms ("my dispatch log") are deliberately NOT in this list:
 * the block never said them, and the new rule has to NAME them in order to
 * forbid them. A guard that cannot tell usage from prohibition would delete the
 * prohibition — which is the mistake this list was written with, and caught by
 * its own first run.
 */
const SUPPLIED_MACHINE_VOICE = [
  /your record shows/i,
  /your own record/i,
  /this record covers/i,
  /in your record/i,
  /say your record for/i,
];

import type { NoiseSummary, SubjectGroup } from '../src/services/selfpruning/inboundNoiseLedger';

function group(over: Partial<SubjectGroup> & { subjectKey: string; reached: number }): SubjectGroup {
  return {
    producers: [{ producer: 'reminder', reached: 2, acted: 0 }],
    acted: 0, ignored: 2, ignoredShare: 1,
    firstAt: new Date('2026-08-17T06:00:00Z'), lastAt: new Date('2026-08-17T06:12:00Z'),
    spanMinutes: 12, burst: false, samples: [],
    ...over,
  } as SubjectGroup;
}

function summary(over: Partial<NoiseSummary> = {}): NoiseSummary {
  return {
    clientNumber: 'TMC-0001', userId: 2, windowHours: 36,
    since: new Date('2026-08-16T00:00:00Z'), until: new Date('2026-08-17T12:00:00Z'),
    totalReached: 2, totalActed: 0, totalIgnored: 2,
    truncated: false, canonicalisationFailed: false, unresolvedSubjects: [],
    burstMaxSpanMinutes: 1440, subjects: [], bursts: [], unattributed: [], floods: [],
    ...over,
  } as NoiseSummary;
}

const SUBJECTS = [group({ subjectKey: 'item:a1', reached: 2 })];
const TITLES = new Map([['item:a1', 'Send the revised Fujairah pricing to Latif']]);

describe('DEF-213 — the block stops supplying machine vocabulary', () => {
  it('the rendered block, with subjects, names no internal record', () => {
    const out = renderPushHistoryBlock(
      summary({ subjects: SUBJECTS }), TITLES,
    );
    for (const re of SUPPLIED_MACHINE_VOICE) expect(out, re.source).not.toMatch(re);
  });

  it('the DEGRADED block names none either — that page is where the old wording lived', () => {
    const out = renderPushHistoryBlock(
      summary({ subjects: SUBJECTS, truncated: true }), TITLES,
    );
    for (const re of SUPPLIED_MACHINE_VOICE) expect(out, re.source).not.toMatch(re);
  });

  it('the UNAVAILABLE block names none either', () => {
    const out = renderPushHistoryUnavailable('query timed out');
    for (const re of SUPPLIED_MACHINE_VOICE) expect(out, re.source).not.toMatch(re);
  });
});

describe('DEF-213 — the general rule, so the next phrase does not creep back', () => {
  const out = () => renderPushHistoryBlock(
    summary({ subjects: SUBJECTS }), TITLES,
  );

  it('tells Brain to give the fact and, absent one, to say it does not know', () => {
    expect(out()).toMatch(/SAY WHAT IS TRUE, NOT HOW YOU KNOW IT/);
    expect(out()).toMatch(/say\s*\n?plainly that you do not know/);
  });

  it('names the two reasons, and the verifiability one explicitly', () => {
    const text = out();
    expect(text).toMatch(/ASSERTS a lookup he cannot verify/);
    expect(text).toMatch(/machine describing its inside/);
  });

  it('NAMES the first-person forms it forbids — a rule that cannot say them is weaker', () => {
    const text = out();
    expect(text).toContain('"my dispatch log"');
    expect(text).toContain('"my records show"');
    expect(text).toContain('"I checked my logs"');
  });

  it('contrasts the honest sentence with the mechanical one, using B12\'s own words', () => {
    const text = out();
    expect(text).toContain("I don't know why it went twice");
    expect(text).toContain('claims a log, claims you read it');
  });
});

describe('DEF-213 — the facts the block exists to carry are unchanged', () => {
  it('still authorises the at-most-once read on a complete page, in fact-shaped words', () => {
    const out = renderPushHistoryBlock(
      summary({ subjects: SUBJECTS }), TITLES,
    );
    expect(out).toMatch(/absent below, it was pushed at most once/);
    expect(out, 'the window bound survives the rewording').toMatch(/covers the last 36h only/);
  });

  it('still refuses it on a degraded page', () => {
    const out = renderPushHistoryBlock(
      summary({ subjects: SUBJECTS, truncated: true }), TITLES,
    );
    expect(out).not.toMatch(/it was pushed at most once/);
    expect(out).toMatch(/THIS LIST IS INCOMPLETE/);
  });

  it('the unavailable block still refuses to deny a push', () => {
    const out = renderPushHistoryUnavailable('query timed out');
    expect(out).toMatch(/NOT the same as "nothing was sent"/);
    expect(out).toMatch(/say you cannot tell for this window/);
  });
});
