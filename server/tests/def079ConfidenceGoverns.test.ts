/**
 * DEF-079 — confirmation is governed by confidence, and the owner sets the bar.
 *
 * "ask status of leave request from Asad" — a named person, a named item — and
 * Brain asked permission. Twice in a day the owner has said unnecessary
 * confirmation is the thing he most dislikes here, and he asked whether
 * something was hardcoded.
 *
 * The judgement was never hardcoded, but the DIRECTION was wrong:
 *
 *     if (confidence < 0.6) return ASK(...)
 *
 * Being UNSURE produced a question. For someone whose complaint is being asked
 * to confirm what he just instructed, that is exactly backwards — uncertainty
 * about whether a check is warranted is not a reason to run the check.
 *
 * His ruling: "agreed if you controlled it through confidence level." So it now
 * asks only when the assessment is CONFIDENT the check carries information he
 * lacks, and the bar is a tenant config he can tune without a deploy — his
 * number, not one I picked.
 *
 * Two cases stay outside confidence entirely: an unresolved recipient and a
 * failed assessment. Those mean we cannot judge at all, which is a different
 * thing from judging "routine".
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'confirmationPolicyService.ts'), 'utf8');
const CFG = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'behaviorConfig.ts'), 'utf8');

describe('DEF-079 — the direction is inverted', () => {
  it('low confidence no longer forces a question', () => {
    expect(SRC, 'unsure must not mean ask').not.toMatch(/confidence < 0\.6.*return ASK/);
  });

  it('it asks only when confident AND the verdict says so', () => {
    expect(SRC).toMatch(/needsConfirmation === true && confidence >= bar/);
  });

  it('the prompt tells the model to answer low rather than default to true', () => {
    expect(SRC).toMatch(/being unsure whether a check is\s*\n?\s*\*?\s*warranted is not a reason to make it/);
  });
});

describe('DEF-079 — the bar belongs to the owner', () => {
  it('is a registered tenant config, not a literal in the code', () => {
    expect(CFG).toMatch(/'confirmation\.min_confidence_pct'/);
    expect(CFG).toMatch(/def: 75, min: 0, max: 100, scope: 'tenant'/);
  });

  it('is registered in BEHAVIOR_SPECS — an unknown key throws (DEF-060 class)', () => {
    // getBehaviorValue throws on an unregistered key. Reading a config that was
    // never declared is the same shape as writing an enum value the CHECK
    // constraint rejects.
    const specBlock = CFG.slice(CFG.indexOf("'confirmation.min_confidence_pct'"));
    expect(specBlock.slice(0, 400)).toMatch(/key: 'confirmation\.min_confidence_pct'/);
  });

  it('falls back to 75 if the lookup fails, and clamps to 0..100', () => {
    expect(SRC).toMatch(/catch\(\(\) => 75\)/);
    expect(SRC).toMatch(/Math\.max\(0, Math\.min\(100, minPct\)\) \/ 100/);
  });

  it('says in the reason when a concern was suppressed by the bar', () => {
    // Silently discarding a flagged concern would be its own defect — the log
    // has to show what it decided not to ask about.
    expect(SRC).toMatch(/below the \$\{Math\.round\(bar \* 100\)\}% bar, acting/);
  });
});

describe('DEF-079 — the hard cases are not governed by confidence', () => {
  it('an unresolved recipient still asks', () => {
    expect(SRC).toMatch(/recipientResolves === false\) return ASK/);
  });

  it('a failed assessment still asks', () => {
    expect(SRC).toMatch(/defaulting to ask/);
  });
});
