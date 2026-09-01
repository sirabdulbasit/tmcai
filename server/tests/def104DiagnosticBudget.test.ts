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

  it('checks the tier budgets BEFORE the daily cap', () => {
    // Order is the whole mechanism. Checked after the cap, a diagnostic could
    // still consume the last slot of the day.
    //
    // DEF-271 GENERALISED THIS INTO A TIER LOOP, and that nearly cost this test its meaning:
    // the reason string became `${tier.label}_budget_exceeded`, so the old assertion
    // `indexOf('diagnostic_budget_exceeded') < indexOf('daily_cap_exceeded')` became -1 < N —
    // vacuously TRUE with the mechanism gone. Both anchors are now asserted to EXIST before
    // they are ordered, because an assertion that cannot fail is worse than no assertion.
    const tierLoop = src.indexOf('for (const tier of TIERS)');
    const dailyCap = src.indexOf('daily_cap_exceeded');
    expect(tierLoop).toBeGreaterThan(-1);
    expect(dailyCap).toBeGreaterThan(-1);
    expect(tierLoop).toBeLessThan(dailyCap);
  });

  it('derives every tier budget from config, not a literal', () => {
    expect(src).toContain('notify.diagnostic_budget_pct');
    expect(src).toContain('notify.housekeeping_budget_pct');
  });

  it('counts only the TIER\'s own kinds against that tier\'s budget', () => {
    // Counting all messages would make the reserve pointless: a busy reminder
    // day would lock Brain out of reporting its own health entirely.
    // Scoped by `tier.kinds` now rather than a hard-coded set — one mechanism, two tiers.
    const block = src.slice(src.indexOf('for (const tier of TIERS)'));
    expect(block).toContain('kind: { in: [...tier.kinds] }');
    // And the count must be of SENT messages only; counting suppressed rows would let a
    // suppressed nag consume the budget it was refused from.
    expect(block).toContain("status: { in: ['sent', 'partial'] }");
  });

  it('records a suppressed row rather than failing silently', () => {
    // The owner must still be able to ask "what did you decide not to send me?"
    const block = src.slice(src.indexOf('for (const tier of TIERS)'));
    expect(block).toContain("status: 'suppressed'");
    expect(block).toContain('_budget_exceeded');
  });

  it('DEF-271 — housekeeping is a tier, so a nag cannot displace a person', () => {
    // Owner, 2026-09-01: four people's messages relayed, two suppressed, because 10 of the 20
    // daily sends had gone on `open_item_draft_ask`. The diagnostic tier already stated the
    // principle — "never more useful than the reminder they would displace" — and the nag kinds
    // were simply not in a tier.
    for (const kind of ['open_item_draft_ask', 'brain_prompt']) {
      expect(src).toContain(`'${kind}'`);
    }
    // A relayed human message must NOT be in any tier — it is what the tiers protect.
    //
    // COMMENTS STRIPPED BEFORE MATCHING (BLD-009: four earlier source guards in this codebase
    // passed by matching the prose that described them). The comment above the tiers quotes the
    // breakdown that includes `wa_counterpart_message`, and an unstripped match reads that
    // mention as membership — the guard would fail on the explanation of why it exists.
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    const tierSets = codeOnly.slice(
      codeOnly.indexOf('const DIAGNOSTIC_KINDS'), codeOnly.indexOf('const TIERS'));
    expect(tierSets).toContain('open_item_draft_ask');   // the slice is the right region
    expect(tierSets).not.toContain('wa_counterpart_message');
  });

  it('a kind belongs to at most one tier', () => {
    // Two tiers matching one kind would charge it twice and refuse it at the tighter cap
    // without saying which — the loop breaks on first match to make that impossible.
    const block = src.slice(src.indexOf('for (const tier of TIERS)'));
    expect(block).toContain('break;');
  });
});
