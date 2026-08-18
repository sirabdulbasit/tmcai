/**
 * DEF-214 — `time-of-day-drift`: a local clock wearing a UTC label.
 *
 * Five occurrences in chart §3 (DEF-026 ×4, DEF-148, both OPEN), and Codex's
 * analysis records it as *"Not diagnosed from code this turn."* It is
 * diagnosable, and the arithmetic in the owner's own report is the proof:
 *
 *     Brain: "My current time is 12:07 PM in your timezone (Asia/Karachi)."
 *     Owner: "Are u traveling back to time?"          (local was 17:07)
 *
 * **12:07 and 17:07 differ by exactly five hours — Asia/Karachi's offset from
 * UTC.** He was handed a UTC clock wearing a PKT label.
 *
 * Two defects, in two prompt builders:
 *
 *   1. `Today is ${todayDate} (UTC)` — but `getUserLocalDate` has returned the
 *      user's LOCAL date since Sprint 4A. The value was right and the label was
 *      a lie, so the anchor the model reasons from was declared to be in a zone
 *      it was not in. A model told "this is UTC" converts it when asked the
 *      time.
 *   2. No HOUR was supplied at all, so "what time is it" could only be answered
 *      by inventing one — and then labelling it with his timezone, which is
 *      `fabricated-status` wearing a clock face.
 *
 * The same wrong line existed in BOTH the main prompt and the `decideAction`
 * prompt: `protection-with-two-implementations` on the date label itself.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  formatLocalTime,
  ownerClockFor,
  renderOwnerClockLine,
  formatLocalDate,
  getTimezoneOffset,
} from '../src/services/userTimezoneService';

/** The exact instant from the owner's report: 17:07 in Karachi. */
const THE_INSTANT = new Date('2026-05-20T12:07:00Z');

const code = (rel: string) => {
  const raw = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  // Comments stripped: a guard must read code, not prose about it (DEF-195).
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
};

describe('DEF-214 — the owner\'s clock, resolved rather than inferred', () => {
  it('THE REPORTED INSTANT: 12:07 UTC is 17:07 in Karachi, and the difference is the offset', () => {
    expect(formatLocalTime('Asia/Karachi', THE_INSTANT)).toBe('17:07');
    expect(THE_INSTANT.toISOString().slice(11, 16), 'what he was actually shown').toBe('12:07');
    expect(getTimezoneOffset('Asia/Karachi', THE_INSTANT)).toBe('+05:00');
  });

  it('carries all four parts together, because they are one fact', () => {
    const clock = ownerClockFor('Asia/Karachi', THE_INSTANT);
    expect(clock).toEqual({
      timezone: 'Asia/Karachi',
      date: formatLocalDate('Asia/Karachi', THE_INSTANT),
      time: '17:07',
      offset: '+05:00',
    });
  });

  it('is correct in a zone that is not the default, and across the date boundary', () => {
    // 23:30 UTC on the 20th is already the 21st in Karachi — the off-by-one day
    // `getUserLocalDate` was introduced to fix, now checked with the hour too.
    const late = new Date('2026-05-20T23:30:00Z');
    expect(ownerClockFor('Asia/Karachi', late)).toMatchObject({ date: '2026-05-21', time: '04:30' });
    expect(ownerClockFor('America/New_York', THE_INSTANT)).toMatchObject({ time: '08:07', offset: '-04:00' });
    expect(ownerClockFor('UTC', THE_INSTANT)).toMatchObject({ time: '12:07', offset: '+00:00' });
  });

  it('degrades to the UTC hour rather than throwing on a bad zone', () => {
    expect(formatLocalTime('Not/AZone', THE_INSTANT)).toBe('12:07');
  });
});

describe('DEF-214 — the rendered line says what the value actually is', () => {
  const line = () => renderOwnerClockLine(ownerClockFor('Asia/Karachi', THE_INSTANT));

  it('names the hour, the zone and the offset — none of which the old line carried', () => {
    // Pinned to the OPENING sentence, not to "contains 17:07". Mutation caught
    // that: the rule below quotes "12:07 when it was 17:07" as the lesson, so a
    // bare `toContain('17:07')` passed even with the clock removed entirely —
    // the guard was matching its own prose. Same mistake as DEF-213's list.
    expect(line()).toMatch(
      /^Today is 2026-05-20 and the current local time is 17:07 in the user's own timezone, Asia\/Karachi \(UTC\+05:00\)\./);
  });

  it('never labels the anchor as being IN UTC', () => {
    // The whole defect in one assertion: "(UTC)" directly after the date.
    expect(line()).not.toMatch(/Today is \S+ \(UTC\)/);
    expect(line()).toContain("the user's own timezone");
  });

  it('forbids stating a clock it was not given, and naming his zone on an invented hour', () => {
    expect(line()).toContain('NEVER state a clock time that is not given here');
    expect(line()).toContain('never attach his timezone');
    expect(line(), 'the lesson is carried with the rule').toContain('12:07 when it was 17:07');
  });

  it('keeps the relative-date anchoring the old line existed for', () => {
    expect(line()).toContain('"today", "tomorrow", "yesterday"');
    expect(line()).toContain('YYYY-MM-DD');
  });
});

describe('DEF-214 — BOTH prompt builders, because both carried the same lie', () => {
  const composer = code('src/services/knowledge/brainComposer.ts');

  it('no builder labels the local date as UTC any more', () => {
    expect(composer).not.toMatch(/Today is \$\{todayDate\} \(UTC\)/);
    expect(composer).not.toMatch(/Today is \$\{opts\.todayDate\} \(UTC\)/);
  });

  it('both use the ONE shared renderer, and both are REACHABLE', () => {
    expect((composer.match(/renderOwnerClockLine\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // Presence is not reachability: mutation showed `${false ? renderOwnerClockLine(...)`
    // keeps the call text and dead-codes it. Each site must be gated on the clock.
    expect(composer).toMatch(/\$\{ownerClock\s*\n?\s*\? renderOwnerClockLine\(ownerClock\)/);
    expect(composer).toMatch(/\$\{opts\.ownerClock\s*\n?\s*\? renderOwnerClockLine\(opts\.ownerClock\)/);
  });

  it('the clock is resolved from the timezone service, and a failure yields null', () => {
    expect(composer).toMatch(/const ownerClock = await getOwnerClock\(userId\)\.catch\(\(\) => null\)/);
  });

  it('an unresolved clock is STATED as unknown — never a silent fallback to a mislabelled date', () => {
    expect(composer).toMatch(/in the user's own local timezone — NOT UTC/);
    // The source wraps this sentence across two concatenated string literals,
    // so the guard tolerates the break rather than pinning one formatting choice.
    expect(composer).toMatch(/could not be[\s\S]{0,40}resolved this turn/);
    // NOT a bare /say so plainly rather/ — that phrase already existed elsewhere
    // in this file (line ~5099, an unrelated block), so the assertion would have
    // passed with the fallback deleted. Mutation caught it.
    expect(composer).toMatch(/if he asks the time, say so plainly/);
  });

  it('both call sites pass it down', () => {
    expect((composer.match(/^\s*ownerClock,$/gm) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
