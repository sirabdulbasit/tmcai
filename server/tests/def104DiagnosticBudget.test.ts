/**
 * DEF-104 — Brain's self-reporting must never crowd out the user's own messages.
 *
 * Measured on production 2026-08-08: exactly 20 of a 20/day cap sent, and THREE
 * of them were diagnostics I had added the night before — deploy reports and an
 * ask-recovery notice — while 104 of the owner's real overdue-task reminders
 * were suppressed.
 *
 * The machinery built to stop him missing notifications had started causing him
 * to miss notifications. That is the failure this pins shut.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(__dirname, '..', 'src', 'services', 'notifications', 'brainOutboundService.ts'),
  'utf-8',
);

describe('DEF-104 — the diagnostic budget', () => {
  it('classifies every self-reporting kind as diagnostic', () => {
    // A kind missing from this set silently regains the power to displace a
    // reminder, which is exactly how this happened the first time.
    for (const kind of [
      'brain_health_alert', 'brain_daily_digest', 'deploy_report',
      'self_upgrade', 'unnotified_answered_ask', 'connector_stale',
    ]) {
      expect(src).toContain(`'${kind}'`);
    }
  });

  it('checks the diagnostic budget BEFORE the daily cap', () => {
    // Order is the whole mechanism. Checked after the cap, a diagnostic could
    // still consume the last slot of the day.
    expect(src.indexOf('diagnostic_budget_exceeded'))
      .toBeLessThan(src.indexOf('daily_cap_exceeded'));
  });

  it('derives the budget from config, not a literal', () => {
    expect(src).toContain('notify.diagnostic_budget_pct');
  });

  it('counts only diagnostics against the diagnostic budget', () => {
    // Counting all messages would make the reserve pointless: a busy reminder
    // day would lock Brain out of reporting its own health entirely.
    const block = src.slice(src.indexOf('DIAGNOSTIC_KINDS.has(req.kind)'));
    expect(block).toContain('kind: { in: [...DIAGNOSTIC_KINDS] }');
  });

  it('records a suppressed row rather than failing silently', () => {
    // The owner must still be able to ask "what did you decide not to send me?"
    const block = src.slice(src.indexOf('DIAGNOSTIC_KINDS.has(req.kind)'));
    expect(block).toContain("status: 'suppressed'");
  });
});
