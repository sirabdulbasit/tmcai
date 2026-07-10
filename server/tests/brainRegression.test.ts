import { describe, it, expect } from 'vitest';
import { BRAIN_SCENARIOS } from './brainScenarios';

// ═══════════════════════════════════════════════════════════════════
// Brain regression harness (2026-07-10) — the permanent anti-whack-a-
// mole net Basit asked for: "fix brain permanently, don't want to
// follow error or each bug."
//
// Every reported chat is a scenario in brainScenarios.ts with an
// executable assert() that exercises the real deterministic code path
// that broke. This file runs them all on every `npx vitest run`, which
// must be green before deploy. A fix can't silently regress; a new bug
// gets added once and never returns.
//
// The meta-tests below ENFORCE the process — you cannot add a scenario
// without a real assertion, cannot duplicate an id, and cannot leave a
// scenario without a linked fix commit. That's what makes it permanent
// rather than aspirational.
// ═══════════════════════════════════════════════════════════════════

describe('brain regression corpus — every reported chat stays fixed', () => {
  it('has scenarios (the corpus is not empty)', () => {
    expect(BRAIN_SCENARIOS.length).toBeGreaterThan(0);
  });

  it.each(BRAIN_SCENARIOS.map((s) => [s.id, s] as const))(
    'scenario %s: the fix still holds',
    async (_id, scenario) => {
      // Runs the scenario's real-code assertion. Regression → red here,
      // in CI, before Basit ever sees it on WhatsApp.
      await scenario.assert();
    },
  );
});

describe('brain regression harness — process enforcement (keeps it permanent)', () => {
  it('every scenario declares an executable assert()', () => {
    const missing = BRAIN_SCENARIOS.filter((s) => typeof s.assert !== 'function').map((s) => s.id);
    expect(missing).toEqual([]);
  });

  it('every scenario links at least one fix commit (traceable to the change)', () => {
    const unlinked = BRAIN_SCENARIOS.filter((s) => !s.fixCommits || s.fixCommits.length === 0).map((s) => s.id);
    expect(unlinked).toEqual([]);
  });

  it('every scenario carries at least one symptom tag', () => {
    const untagged = BRAIN_SCENARIOS.filter((s) => !s.symptomTags || s.symptomTags.length === 0).map((s) => s.id);
    expect(untagged).toEqual([]);
  });

  it('scenario ids are unique (no accidental overwrite)', () => {
    const ids = BRAIN_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every archived chat has a matching scenario (archive and corpus stay in sync)', () => {
    // The prose archive (brain_chat_archive.md) and this executable
    // corpus must not drift. Each "## Chat N" heading in the archive
    // must have a corresponding chatN scenario here — otherwise a
    // reported bug was documented but never locked with a test.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const archive = readFileSync(join(__dirname, '..', 'docs', 'brain_chat_archive.md'), 'utf-8');
    const chatHeadings = [...archive.matchAll(/^##\s+Chat\s+(\d+)/gim)].map((m) => `chat${m[1]}`);
    const scenarioIds = new Set(BRAIN_SCENARIOS.map((s) => s.id));
    const undocumented = chatHeadings.filter((c) => !scenarioIds.has(c));
    expect(undocumented).toEqual([]); // an archived chat with no locking scenario
  });
});
