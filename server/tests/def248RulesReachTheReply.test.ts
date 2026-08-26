/**
 * DEF-248 — the rules the owner sets must reach the reply he reads.
 *
 * Owner, 2026-08-26: "do brain read Rules while communicating?" On the live path it did not.
 *
 * `/brief/rules` accepts a rule, stores it, and displays it ACTIVE. The block was fetched at
 * brainComposer.ts:3195, rendered at :3203 and pushed into the prompt at :1842 — every one of
 * those on the LEGACY assembly path, which runs only when BRAIN_USE_REASONING='never'. It is not
 * set, in .env or in the running process, so reasoning is live and it received
 * `personaForReasoning.systemPreamble` alone. That preamble is built from promptBlocks (8 rows,
 * all seeded, untouched since 2026-05-23) and references getActiveInstructions zero times.
 *
 * So a rule could be written, stored, shown as active — and never read by the thing that answers.
 *
 * IMPORTANT SCOPE, because "Brain ignores my rules" would be wrong: rules DID apply to TRIAGE.
 * autonomousExecutor calls findVetoForEvent and matchInstructionsForEvent, so a rule about what
 * to do with an arriving email worked. What was missing is the CONVERSATION path.
 *
 * These assertions pin the rendering contract the composer now depends on — that a rule survives
 * into text, and that having no rules produces nothing rather than an empty heading that would
 * take up prompt space and read as "the user has set rules: none".
 */
import { describe, it, expect } from 'vitest';
import { renderInstructionsBlock } from '../src/services/knowledge/instructionService';

// The real row shape, read from renderInstructionsBlock rather than guessed: it prints
// `- [kind] **title** — originalText`. My first fixture used `instructionText`, which the
// renderer ignores — it produced the heading and no rules, and the test caught it. Worth keeping
// as a note: a fixture invented from the field name you expect will pass against a renderer that
// silently drops it, and then prove nothing.
const rule = (over: any = {}) => ({
  id: 1,
  kind: 'policy',
  title: 'Evening email hold',
  originalText: 'Never send email after 6pm without asking me first',
  status: 'ACTIVE',
  scope: 'user',
  createdAt: new Date('2026-08-26T09:00:00Z'),
  ...over,
});

describe('DEF-248 — a stored rule survives into the prompt text', () => {
  it('renders the rule text, so the composer can carry it', () => {
    const block = renderInstructionsBlock([rule()] as any);
    expect(block).toContain('Never send email after 6pm without asking me first');
  });

  it('renders NOTHING when there are no rules — an empty heading is worse than silence', () => {
    // A bare "# Standing instructions" with no content spends prompt budget and reads to the
    // model as an assertion that the user has considered rules and set none.
    expect(renderInstructionsBlock([] as any)).toBe('');
  });

  it('carries several rules together, not just the first', () => {
    const block = renderInstructionsBlock([
      rule({ id: 1, title: 'Evening hold', originalText: 'Never send email after 6pm' }),
      rule({ id: 2, title: 'inDrive CC', originalText: 'Always CC Basit on inDrive threads' }),
    ] as any);
    expect(block).toContain('Never send email after 6pm');
    expect(block).toContain('Always CC Basit on inDrive threads');
  });

  it('survives a rule with regex-special characters, which a naive join would mangle', () => {
    const block = renderInstructionsBlock([
      rule({ title: 'Urgency flag', originalText: 'Flag anything matching (urgent|ASAP) $[0-9]+' }),
    ] as any);
    expect(block).toContain('(urgent|ASAP) $[0-9]+');
  });
});
