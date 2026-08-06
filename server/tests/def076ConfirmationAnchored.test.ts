/**
 * DEF-076 — Brain asked permission for a routine ask, on a false premise.
 *
 * 2026-08-06 10:14. "ask Hamna about status of ShireMe Portal Testing" — a
 * named person, a named item, nothing unusual. It previewed, and the log gave
 * the reason:
 *
 *   why: 'The last contact date with Hamna is in the future (2026). Is this correct?'
 *
 * It was 2026-08-06. Her last contact was yesterday.
 *
 * The gate itself behaved correctly: it spotted something that looked wrong and
 * asked. The FACT was wrong. `assessConfirmationNeed` handed the model contact
 * dates with no current date, so it fell back on its own sense of what year it
 * is and manufactured a contradiction.
 *
 * Same family as DEF-026 — "Morning, Sir" at 1 PM, where the prompt carried the
 * date but no clock. A model with no anchor uses its prior, and its prior is
 * whenever it was trained.
 *
 * Owner, twice: unnecessary confirmation is the thing he most dislikes here.
 * So the default is now explicitly to ACT, and a confirmation must be able to
 * finish the sentence "here is what he does not already know: ___".
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'confirmationPolicyService.ts'), 'utf8');

describe("DEF-076 — the model is told what day it is", () => {
  it('facts carry today', () => {
    expect(SRC).toMatch(/today: new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  });

  it('and the prompt forbids inferring the year', () => {
    expect(SRC).toMatch(/TODAY'S DATE IS GIVEN TO YOU in facts\.today/);
    expect(SRC).toMatch(/Never call a date "in the future" from your own/);
  });

  it('the real failure is recorded so the rule is not tidied away', () => {
    expect(SRC).toMatch(/2026-08-06 that produced a confirmation/);
  });
});

describe('DEF-076 — the default is to act', () => {
  it('says so in the prompt, not just by implication', () => {
    expect(SRC).toMatch(/THE DEFAULT IS TO ACT/);
  });

  it('requires a confirmation to carry information the owner lacks', () => {
    expect(SRC).toMatch(/here is what he does not already know/);
  });

  it('still fails closed on low confidence — a wrong send costs more', () => {
    // The bias toward acting must not become "never ask". An unresolved
    // recipient, an unreadable request, or a failed assessment still asks.
    expect(SRC).toMatch(/confidence < 0\.6.*ASK|if \(confidence < 0\.6\) return ASK/s);
    expect(SRC).toMatch(/defaulting to ask/);
    expect(SRC).toMatch(/recipientResolves === false.*ASK/s);
  });
});
