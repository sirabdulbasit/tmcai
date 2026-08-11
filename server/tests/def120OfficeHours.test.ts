/**
 * DEF-120 — Brain speaks during working hours, in the user's own region.
 *
 * Owner, 2026-08-11: *"brain should send message only in office hour as per
 * region"*. That morning he received:
 *
 *   06:11  Intervention needed on "Vision Metric Integration"…
 *   08:16  Intervention needed on "Vision Metric's service sales package video"…
 *
 * Both were legal. Quiet hours ended at 06:00, so 06:11 passed every check the
 * system had. It was still wrong: "not asleep" is not "at work", and an
 * assistant that opens with a blocker before the working day begins is one you
 * learn to mute.
 *
 * These assertions pin the three properties that make the difference between a
 * working-hours rule and a second quiet-hours rule.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(__dirname, '..', 'src', 'services', 'notifications', 'brainOutboundService.ts'),
  'utf-8',
);
const queue = readFileSync(
  join(__dirname, '..', 'src', 'services', 'brainPrompts', 'brainPromptQueueService.ts'),
  'utf-8',
);

/** Mirror of the implementation's window test, held honest by the assertions below. */
function outside(hour: number, dayIndex: number, startH = 9, endH = 18, mask = 62): boolean {
  if (!((mask >> dayIndex) & 1)) return true;
  return hour < startH || hour >= endH;
}

describe('DEF-120 — the working-hours window', () => {
  it('would have blocked the 06:11 message that started this', () => {
    // Tuesday 06:11. The exact send the owner objected to.
    expect(outside(6, 2)).toBe(true);
  });

  it('would have blocked the 08:16 message too', () => {
    expect(outside(8, 2)).toBe(true);
  });

  it('allows the working day', () => {
    expect(outside(9, 2)).toBe(false);   // opens at 09:00
    expect(outside(13, 2)).toBe(false);
    expect(outside(17, 2)).toBe(false);  // last hour
  });

  it('closes at the end hour rather than after it', () => {
    // 18 means the last send is 17:59 — an "end hour" that still sends AT that
    // hour is an hour longer than anyone means by it.
    expect(outside(18, 2)).toBe(true);
  });

  it('holds the whole weekend by default', () => {
    expect(outside(11, 0)).toBe(true);   // Sunday
    expect(outside(11, 6)).toBe(true);   // Saturday
    expect(outside(11, 1)).toBe(false);  // Monday
  });

  it('lets a tenant that works Saturday say so', () => {
    // 62 is Mon-Fri; 126 adds Saturday. Region and working week are config, not
    // an assumption baked into the code.
    expect(outside(11, 6, 9, 18, 126)).toBe(false);
  });
});

describe('DEF-120 — how it behaves inside the send path', () => {
  it('is checked in the USER timezone, not the server clock', () => {
    // A server in UTC must not decide a Karachi user's working day.
    const fn = src.slice(src.indexOf('async function isOutsideOfficeHours'));
    expect(fn.slice(0, 1800)).toContain('resolveUserTimezone');
    expect(fn.slice(0, 1800)).toContain('timeZone: tz');
  });

  it('reads hour and weekday from ONE formatter call', () => {
    // Two calls could straddle midnight and judge the hour on one day and the
    // weekday on another — a rare bug that would be miserable to find.
    const fn = src.slice(src.indexOf('async function isOutsideOfficeHours'));
    expect(fn.slice(0, 1800)).toContain('formatToParts');
  });

  it('exempts emergencies', () => {
    // A channel that waits until Monday is not an emergency channel.
    // bypassQuiet is already true for urgency=emergency.
    expect(src).toMatch(/if \(!bypassQuiet && await isOutsideOfficeHours\(/);
  });

  it('fails OPEN — a broken clock must not silence Brain', () => {
    // A message an hour early is a smaller failure than one that never arrives.
    const fn = src.slice(src.indexOf('async function isOutsideOfficeHours'));
    expect(fn.slice(0, 2200)).toMatch(/catch\s*\{[\s\S]{0,400}return false;/);
  });

  it('records WHY it was held, distinctly from quiet hours', () => {
    // Same summary for two different causes would make the next diagnosis
    // start from zero.
    expect(src).toContain("'outside_office_hours'");
    expect(src).toContain("'quiet_hours'");
  });

  it('backs off longer than quiet hours, so it cannot become the DEF-105 flood', () => {
    // The working day may be a weekend away. Retrying on the quiet-hours
    // cadence until Monday is the same flood with a new label.
    expect(queue).toContain("case 'outside_office_hours':");
    const idx = queue.indexOf("case 'outside_office_hours':");
    expect(queue.slice(idx, idx + 200)).toContain('45 * MIN');
  });
});
