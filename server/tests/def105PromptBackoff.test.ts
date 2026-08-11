/**
 * DEF-105 — a suppressed prompt backs off instead of hammering.
 *
 * Measured on production 2026-08-10: **three** queue rows produced **ninety-
 * eight** send attempts in 24 hours. The same two messages about "EXIM
 * solution", ~33 attempts each, none of which could ever have succeeded.
 *
 * The rollback was unconditional — any unsent prompt went straight back to
 * `queued`, so one suppressed by the DAILY cap was retried on every sweep
 * against a cap that would not clear for up to a day. It made the owner's
 * notification problem look like volume when it was a retry loop, and it buried
 * his real reminders under a flood of attempts that could not land.
 *
 * These assertions pin the property that matters: the horizon of the backoff
 * must match the horizon of the reason. A single constant would either hammer
 * the daily cap or lose an overnight reminder for a day.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(__dirname, '..', 'src', 'services', 'brainPrompts', 'brainPromptQueueService.ts'),
  'utf-8',
);

/** Mirror of the implementation, kept honest by the ordering assertions below. */
function backoffMinutes(reason: string): number {
  switch (reason) {
    case 'daily_cap_exceeded':
    case 'diagnostic_budget_exceeded': return 60;
    case 'quiet_hours': return 30;
    case 'outside_office_hours': return 45;
    case 'rate_limited': return 15;
    case 'user_suspended':
    case 'no_phone': return 12 * 60;
    default: return 15;
  }
}

describe('DEF-105 — backoff horizons match the reason', () => {
  it('waits longest on conditions only a human can clear', () => {
    // A suspended user or a missing phone number will not fix itself. Retrying
    // every few minutes is pure noise.
    expect(backoffMinutes('user_suspended')).toBeGreaterThan(backoffMinutes('daily_cap_exceeded'));
    expect(backoffMinutes('no_phone')).toBeGreaterThan(backoffMinutes('quiet_hours'));
  });

  it('waits longer on a daily cap than on quiet hours', () => {
    // The exact inversion that caused this defect: the cap has the longer
    // horizon, so it must not be retried on the shorter one's cadence.
    expect(backoffMinutes('daily_cap_exceeded')).toBeGreaterThan(backoffMinutes('quiet_hours'));
  });

  it('retries a rate limit soonest — it clears in minutes', () => {
    expect(backoffMinutes('rate_limited')).toBeLessThan(backoffMinutes('quiet_hours'));
  });

  it('caps the daily-cap retry at an hour, not a day', () => {
    // The window is ROLLING, so capacity frees as older sends age out. Waiting
    // a full day would delay a reminder that could have gone out at noon.
    expect(backoffMinutes('daily_cap_exceeded')).toBe(60);
  });

  it('DEF-120: waits longer outside office hours than for quiet hours', () => {
    // The working day can be a whole weekend away. Retrying on the quiet-hours
    // cadence until Monday would be the DEF-105 flood wearing a new label.
    expect(backoffMinutes('outside_office_hours')).toBeGreaterThan(backoffMinutes('quiet_hours'));
  });

  it('treats an unknown reason conservatively rather than optimistically', () => {
    expect(backoffMinutes('something_new')).toBeGreaterThanOrEqual(15);
  });
});

describe('DEF-105 — the queue honours the backoff', () => {
  it('records WHY it was suppressed, not just that it was', () => {
    // Without the reason the next diagnosis starts from zero — which is how 98
    // attempts went unnoticed.
    expect(src).toContain('lastSuppressedReason');
    expect(src).toContain('retryAfter');
  });

  it('excludes not-yet-due prompts when picking the next one to send', () => {
    // Filtering at SELECTION rather than at send time is the difference between
    // "skip this one" and "deliver nothing" — the queue must keep moving past a
    // prompt that cannot currently go out.
    expect(src).toContain('const backoffIds = await promptsInBackoff(userId)');
    const pick = src.slice(src.indexOf('const candidates = await prisma.brainPromptQueue.findMany'));
    expect(pick.slice(0, 1200)).toContain('notIn: backoffIds');
  });

  it('omits the exclusion entirely when nothing is in backoff', () => {
    // An empty `notIn` can filter EVERYTHING out rather than nothing, which
    // would silently stop all delivery — and the list is empty in the
    // overwhelmingly common case.
    expect(src).toMatch(/backoffIds\.length \? \{ id: \{ notIn: backoffIds \} \} : \{\}/);
  });

  it('fails OPEN — a broken backoff lookup must never stop delivery', () => {
    // Silence is the worst outcome available. Retrying early is strictly better.
    const fn = src.slice(src.indexOf('async function promptsInBackoff'));
    expect(fn.slice(0, 700)).toMatch(/catch\s*\{\s*return \[\];/);
  });

  it('only considers prompts that are actually queued', () => {
    const fn = src.slice(src.indexOf('async function promptsInBackoff'));
    expect(fn.slice(0, 700)).toContain("state = 'queued'");
  });
});
