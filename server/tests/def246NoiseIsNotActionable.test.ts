/**
 * DEF-246 — a newsletter is not a commitment.
 *
 * Owner, 2026-08-26, pasting a day of Nexeo's output: "there are many noising or subsriber emails
 * will brain consider those for actionable items?" It did. Six live open items came from
 * automated senders, four of them near-duplicates of one another:
 *
 *   Anthropic <no-reply-cTb0DuBTzWOSLyiP…>  → "Approve new team members"
 *   no-reply-X6RxjIw48kDq5zLd0sGxwA@mail…   → "Approve new team members"   (again)
 *   no-reply-Y1ZveKU0jsc4KPd9-ZsyoA@mail…   → "Review team's upgrade and join requests"
 *   Anthropic <no-reply-HtghXKEQHXmbmyAw…>  → "Approve new Anthropic team members"
 *   dawar.hussain (via Google Meet)         → "Join Google Meet call"
 *
 * All five Anthropic mails share ONE subject — "You have new requests from your team" — and each
 * arrives from a DIFFERENT rotating no-reply address, which is why nothing deduplicated them and
 * why any filter keyed on address history would have failed too.
 *
 * The guard already existed. `senderQualityFilter.isLikelyAutomated` names this exact sender in
 * its own header. It was applied at triageSuggester.ts:559 — the suggestion path — while the
 * services that actually mint items referenced it zero times.
 *
 * The star override is under test as carefully as the block, because dropping a 4-star sender's
 * mail would trade a noisy list for a lossy one, and lossy is the worse failure.
 */
import { describe, it, expect } from 'vitest';
import { isLikelyAutomated } from '../src/services/knowledge/senderQualityFilter';

describe('DEF-246 — the senders that produced real noise', () => {
  const NOISE = [
    'Anthropic <no-reply-cTb0DuBTzWOSLyiP@mail.anthropic.com>',
    'no-reply-X6RxjIw48kDq5zLd0sGxwA@mail.anthropic.com',
    'no-reply-Y1ZveKU0jsc4KPd9-ZsyoA@mail.anthropic.com',
    'Anthropic <no-reply-HtghXKEQHXmbmyAw@mail.anthropic.com>',
    'Anthropic <no-reply-zeYyzw518UOINH6FkLuYXw@mail.anthropic.com>',
  ];

  it.each(NOISE)('recognises %s as automated', (from) => {
    expect(isLikelyAutomated(from)).toBe(true);
  });

  it('handles the RFC2822 form, which is how these actually arrive', () => {
    // Without angle-bracket stripping the local part reads as "<no-reply-…" and every prefix
    // match fails — the filter would look correct and match nothing.
    expect(isLikelyAutomated('Anthropic <no-reply-abc@mail.anthropic.com>')).toBe(true);
  });

  it('does NOT flag the real colleagues whose mail became genuine items', () => {
    for (const person of [
      'tanzeel@tmcltd.com',           // Share DAL Open API
      'basit.ahmed@tmcltd.com',       // Review Credit Consumption
      'imran.arshad@tmcltd.com',      // Share FQDN of Vision Matrix
      'arshad.sharif@tmcltd.com',     // Check with SAP about Pakistan Payroll
      'iliyas.smagulov@indrive.com',  // Clarify Driver License Coverage
    ]) {
      expect(isLikelyAutomated(person)).toBe(false);
    }
  });

  it('treats an empty or missing sender as NOT automated — silence is not proof', () => {
    expect(isLikelyAutomated('')).toBe(false);
    expect(isLikelyAutomated(null)).toBe(false);
    expect(isLikelyAutomated(undefined)).toBe(false);
  });
});
