/**
 * DEF-268 — the prompt promised every timestamp was local, and three blocks handed it UTC.
 *
 * Owner, 2026-09-01 (CL-043), diagnosing it himself: *"the time is also wrong \"12:58PM\" may be
 * because of UTC"*. The relay had gone out at **17:58 PKT**. Same morning, the day brief said
 * *"Your only event is \"Office\" starting at 5:00 AM"* — 05:00 UTC is 10:00 in Asia/Karachi.
 *
 * THE MODEL WAS NOT WRONG. DEF-214's clock line tells it:
 *
 *   "Every date and time above and below is already in that zone: use them as written,
 *    and do NOT convert, shift or re-render an hour."
 *
 * …while `buildRecentEmailsBlock`, `buildRecentWhatsAppBlock` and the calendar formatter each
 * emitted `toISOString()` + ' UTC'. The model obeyed the instruction, did not convert, and
 * reported 12:58. That is `protection-with-two-implementations` in the same file as the claim:
 * a global assertion about all timestamps, enforced by none of the producers.
 *
 * So these tests do NOT check the model's wording. They check that the promise is TRUE — that
 * the hour handed to the model is already in the owner's zone, and that a zone we cannot resolve
 * is LABELLED rather than passed off as local. An unlabelled wrong hour wearing the owner's
 * timezone is the shape that produced "Are u traveling back to time?".
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { formatTimeInZone } from '../src/services/userTimezoneService';

const COMPOSER = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');

describe('DEF-268 — timestamps in the prompt are in the owner\'s zone', () => {
  it('renders 12:58 UTC as 17:58 for Asia/Karachi — the owner\'s actual case', () => {
    const at = new Date('2026-09-01T12:58:43.000Z');
    expect(formatTimeInZone('Asia/Karachi', at)).toBe('17:58');
  });

  it('renders the day-brief case too — 05:00 UTC is 10:00, not 5:00 AM', () => {
    expect(formatTimeInZone('Asia/Karachi', new Date('2026-09-01T05:00:00.000Z'))).toBe('10:00');
  });

  it('LABELS an unresolvable zone instead of passing UTC off as local', () => {
    // The clock line forbids an unlabelled hour. Failing closed means saying "UTC" out loud.
    const out = formatTimeInZone('Not/AZone', new Date('2026-09-01T12:58:00.000Z'));
    expect(out).toContain('UTC');
    expect(out).toContain('12:58');
  });

  it('keeps UTC as a genuine zone rather than a fallback marker', () => {
    // A user really in UTC must get a clean hour, not one decorated with a caveat.
    expect(formatTimeInZone('UTC', new Date('2026-09-01T12:58:00.000Z'))).toBe('12:58');
  });

  it('no prompt block appends a raw UTC label any more', () => {
    // The regression guard: this is the exact expression that broke the promise, three times.
    expect(COMPOSER).not.toContain("+ ' UTC'");
  });

  it('the message and calendar blocks resolve the owner zone before formatting', () => {
    // Resolved ONCE per block. Awaiting inside a synchronous map is what forced the UTC
    // shortcut in the calendar formatter originally.
    const occurrences = COMPOSER.match(/const ownerTz = await resolveUserTimezone\(userId\)/g) ?? [];
    expect(occurrences.length).toBe(3);
    expect(COMPOSER).toContain('formatTimeInZone(ownerTz,');
    expect(COMPOSER).toContain('formatInZone(ownerTz,');
  });

  it('the clock line still makes the promise these tests now keep', () => {
    // If the promise is ever softened, this pairing should be revisited deliberately rather
    // than drifting — the value and the label coming apart is the whole defect.
    const tzsvc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'userTimezoneService.ts'), 'utf8');
    expect(tzsvc).toContain('already in that zone');
    expect(tzsvc).toContain('do NOT convert');
  });
});
