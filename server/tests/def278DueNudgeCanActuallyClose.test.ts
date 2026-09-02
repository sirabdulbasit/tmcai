/**
 * DEF-278 — the due-nudge promised to mark an item done and declared `noop`.
 *
 * CL-046, 2026-09-02. Brain: *"just a reminder that the TMC <> InDrive technical kickoff is due
 * soon. **Let me know if you attended and I can mark it as done.**"* The owner quote-replied
 * *"done"*. Brain: *"Got it."* The item is still `status=NEW`, `updated_at 12:51` — before the
 * exchange.
 *
 * Nothing upstream failed, and that is what makes this the interesting shape. The log:
 * `promptId: "490", relevanceConfidence: 1, answerPreview: "done\n\n[replying to: \"Hi, just a
 * reminder that the TMC <> InD"` — the quoted referent arrived (DEF-267(b), deployed the same
 * day), the right prompt was matched with full confidence, the prompt moved to `answered`. Then
 * `sideEffect: "noop"`, so `applySideEffect` had nothing to do, `composeAck` returned `[noted]`,
 * and the model rendered it as *"Got it."*
 *
 * **8th `fabricated-status`, and the third shape of "a promise with no dispatcher"** after
 * DEF-264 (`"delete all"` un-executable) and DEF-255 (a gate cannot fix an absent capability).
 * The rule those rows keep re-teaching: if the prompt's own words offer an action, the prompt
 * must carry the side effect that performs it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const enqueue = vi.fn();
const findFirst = vi.fn();
const findMany = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    brainPromptQueue: { findFirst: (...a: any[]) => findFirst(...a) },
    openItem: { findMany: (...a: any[]) => findMany(...a) },
  },
}));
vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  enqueueBrainPrompt: (...a: any[]) => enqueue(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
  enqueue.mockResolvedValue({ status: 'enqueued' });
});

describe('DEF-278 — the due-nudge can perform what it offers', () => {
  it('declares the side effect that closes the item, not noop', () => {
    // Asserted on the source: the producer is an internal loop over due items and standing it
    // up would test the mock, not the promise. What matters is one literal in one call.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'brain', 'preactiveEngine.ts'), 'utf-8');
    const at = src.indexOf("source: 'preactive_due_nudge'");
    expect(at).toBeGreaterThan(0);
    // the enqueue call this metadata belongs to
    const call = src.slice(src.lastIndexOf('enqueueBrainPrompt(', at), at);
    const code = call.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).toContain("kind: 'action_status_update'");
    expect(code).not.toContain("kind: 'noop'");
  });

  it('passes the item id ON the side effect, where applySideEffect reads it', () => {
    // `applySideEffect` reads `side.openItemId`. Leaving the id only in metadata — which is
    // where DEF-120 found it — would give `action_status_update` no item and it would return
    // `{ status: 'failed', detail: 'no_open_item' }`: a different silent no-op.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'brain', 'preactiveEngine.ts'), 'utf-8');
    const at = src.indexOf("source: 'preactive_due_nudge'");
    const call = src.slice(src.lastIndexOf('enqueueBrainPrompt(', at), at);
    expect(call).toContain("sideEffect: { kind: 'action_status_update', openItemId: it.id }");
    // and metadata keeps its copy, because promptSubjectItemId reads that one for DEF-115
    expect(src.slice(at, at + 120)).toContain('openItemId: it.id');
  });

  it('the promise and the mechanism stay in the same file, so they cannot drift apart', () => {
    // The defect was a text/behaviour mismatch across two functions. If the wording ever stops
    // offering to act, this assertion should be revisited rather than deleted.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'brain', 'preactiveEngine.ts'), 'utf-8');
    expect(src).toContain('narrateDueNudge');
    expect(src).toContain("kind: 'action_status_update'");
  });
});

/**
 * And the other half — the ack. DEF-279: `noop` produced `[noted]`, which has no subject, so
 * the owner had to ask *"what you got it?"*. `action_status_update` acks with the outcome.
 */
import { looksLikeAnswer } from '../src/services/brainPrompts/promptReplyHandler';

describe('DEF-279 — "done" is recognised as an answer to this kind', () => {
  it('accepts the short completions an owner actually types', () => {
    for (const a of ['done', 'Done', 'attended', 'yes attended', 'completed it']) {
      expect(looksLikeAnswer(a, 'action_status_update'), a).toBe(true);
    }
  });
});
