/**
 * DEF-333 — B04-outstanding-question-ignored, the composer half.
 *
 * The single most recurrent shape in the archive (`pending-prompt-eats-command`,
 * §3 count 4; DEF-093 verbatim): Brain asks "what priority and deadline should
 * I put on X?", the owner replies "Priority high.", and the reply becomes a NEW
 * item titled "Priority high" instead of being consumed as the answer. The
 * benchmark's top fixQueue item (B04, C6=75) is exactly this, deferred across
 * six reviews.
 *
 * The fix is a CORE conversational rule — always-on, every surface, every
 * intent — because the binding is a judgement and judgements are the model's
 * (owner ruling 2026-08-19): code adds no detector, no sentence list, no
 * enumeration; the rule tells the model that its own unanswered question binds
 * the user's reply, and the model decides whether a given message answers it.
 *
 * Pinned on the source (the def222 pattern — `assembleSystemPrompt` is
 * private, and what matters is WHERE the rule lives):
 *  - the rule exists, inside CORE_CONVERSATIONAL_RULES (not an intent block),
 *    so a small-talk or read turn gets it too;
 *  - it commands answer-first reading, settled-value carry, and chase of the
 *    still-missing slots;
 *  - it forbids minting the answer into a new item (the DEF-093 failure).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const raw = fs.readFileSync(
  path.join(__dirname, '../src/services/knowledge/brainComposer.ts'),
  'utf8',
);

const coreStart = raw.indexOf('const CORE_CONVERSATIONAL_RULES = `');
const coreEnd = raw.indexOf('`;', coreStart);
const core = raw.slice(coreStart, coreEnd);

describe('DEF-333 — the binding rule ships on every turn', () => {
  it('lives inside CORE_CONVERSATIONAL_RULES, not an intent-specific block', () => {
    expect(coreStart).toBeGreaterThan(-1);
    expect(core).toContain('Your own unanswered question binds their reply');
  });

  it('commands answer-first reading and carrying the settled values', () => {
    expect(core).toContain('read it FIRST as that answer');
    expect(core).toContain('carry the settled values');
    expect(core).toContain('ask only for what is still missing');
  });

  it('forbids minting the answer into a new item — the DEF-093 failure, named generically', () => {
    expect(core).toContain('Never convert such an answer into a new standalone item or command');
    expect(core).toContain('is an answer, not a task title');
  });

  it('adds no detector: the rule carries no regex, no kind list, no enumerated trigger sentences', () => {
    const rule = core.slice(core.indexOf('1a.'), core.indexOf('2. **Commit'));
    expect(rule.length).toBeGreaterThan(100);
    // The examples are VALUES the user might say, offered as illustration to
    // the model — not code-side triggers. Nothing in the rule is executable.
    expect(rule).not.toMatch(/new RegExp|\.test\(|startsWith|includes\(/);
  });
});
