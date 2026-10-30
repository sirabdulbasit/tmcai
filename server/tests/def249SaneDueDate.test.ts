/**
 * DEF-249 — a deadline the model invented must not outrank the guard.
 *
 * 2026-08-27, 10:23 PKT. The owner wrote:
 *
 *     "please note that we have got extension of Imperialsoft credits up to 28th October"
 *
 * and Brain answered `[new deadline recorded: 2024-10-28]` — the year 2024, two years in the
 * past. Verified in production: `Decide on Imperialsoft services termination date` carries
 * `due_date = 2024-10-28`, permanently overdue, and a second item
 * (`Escalate GCP Credit Extension…`) carries 2024-08-28. He never said a year.
 *
 * The guard already existed. DEF-017 added `withinSaneDueWindow` after production wrote
 * `2024-03-29`, and put it inside `parseDuePhrase`. But `actionLifecycleService` asks a MODEL for
 * the deadline and took its answer on `Number.isFinite` alone, using `parseDuePhrase` only when
 * the model failed — so the guard lived in the fallback branch and was skipped every time the
 * model succeeded. A guard on one producer is not a guard on the value.
 *
 * The same utterance produced 2026-10-28 through the other path in the same turn, which is how a
 * single message left two items with two different years.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { saneDueDate } from '../src/services/brainPrompts/promptReplyHandler';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

const daysFromNow = (n: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
};

describe('DEF-249 — the sanity window applies to the value, not to one parser', () => {
  it('refuses the exact date production wrote', () => {
    expect(saneDueDate(new Date('2024-10-28'))).toBeNull();
  });

  it('refuses DEF-017 original, so the old defect stays closed', () => {
    expect(saneDueDate(new Date('2024-03-29'))).toBeNull();
  });

  it('accepts the date he actually meant — a real future date inside the window', () => {
    // "28th October", said on 2026-08-27 — two months ahead. The original pin
    // hardcoded 2026-10-28 and went red the day the calendar passed it (caught
    // 2026-10-30, failing on every branch): a sanity WINDOW is relative to
    // now, so its acceptance pin must be too. Same two-months-ahead shape.
    const meant = daysFromNow(62);
    const d = saneDueDate(meant);
    expect(d).not.toBeNull();
    expect(d?.toISOString().slice(0, 10)).toBe(meant.toISOString().slice(0, 10));
  });

  it('accepts today and tomorrow — a same-day deadline is ordinary', () => {
    expect(saneDueDate(daysFromNow(0))).not.toBeNull();
    expect(saneDueDate(daysFromNow(1))).not.toBeNull();
  });

  it('refuses a date beyond five years — the other end of the window', () => {
    expect(saneDueDate(daysFromNow(5 * 365 + 30))).toBeNull();
  });

  it('returns null for absent or unparseable input rather than throwing', () => {
    expect(saneDueDate(null)).toBeNull();
    expect(saneDueDate(undefined)).toBeNull();
    expect(saneDueDate(new Date('not a date'))).toBeNull();
  });

  it('null is the point: it routes the caller into "ask him", never into a silent write', () => {
    // The value of refusing is only realised because every caller treats null as
    // "unparseable — ask the user". Asserting the contract, not the mechanism.
    expect(saneDueDate(new Date('2024-10-28'))).toBeNull();
    expect(saneDueDate(new Date('2019-01-01'))).toBeNull();
  });

  // ── the assertions that actually pin the FIX ──────────────────────────────────────────
  //
  // Everything above passes with the defect fully restored. Found by mutation: putting the
  // production line back — `parsed.newDeadline ? new Date(...) : null` — leaves all seven green,
  // because they exercise the helper and never the call site. A test that proves a guard exists
  // while the guard goes unused is worse than no test: it reports the defect as closed.
  //
  // Source assertions are the idiom this repo already uses for exactly this (def223ReasoningPathRule).
  it('actionLifecycleService PASSES the model date through the window', () => {
    const src = read('services/openItems/actionLifecycleService.ts');
    expect(src).toMatch(/saneDueDate\(\s*parsed\.newDeadline/);
    expect(src).not.toMatch(/const parsedDeadline = parsed\.newDeadline \? new Date/);
  });

  it('instructionDispatcher guards itemDueDate the same way', () => {
    const src = read('services/instructions/instructionDispatcher.ts');
    expect(src).toMatch(/saneDueDate\(new Date\(ix\.params\.itemDueDate\)\)/);
    expect(src).not.toMatch(/if \(!Number\.isNaN\(parsed\.getTime\(\)\)\) dueDate = parsed;/);
  });
});
