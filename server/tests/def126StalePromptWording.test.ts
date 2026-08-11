/**
 * DEF-126 — a queued question must be spoken in today's words.
 *
 * Owner, 2026-08-11, on receiving *"A reply arrived from a contact with more
 * than one open delegation. Please tell me which item it belongs to."* for the
 * second time: *"this is again meaningless for me"*, and then the harder one:
 * *"everytime you just give me the reason but nothing found progressive in
 * brain"*.
 *
 * That second complaint is the important one, and it was accurate. The sentence
 * he received no longer exists in this codebase — DEF-122 and DEF-123 deleted it
 * hours before it arrived:
 *
 *   prompt 324   queued 07:02   sent 11:28
 *   DEF-122b deployed 07:29 · DEF-123 deployed 08:35
 *
 * The question was composed at enqueue and delivered four and a half hours
 * later, having missed two fixes that were already live. Every wording fix
 * shipped so far sat on this hole: improvements applied to new questions while
 * the backlog kept delivering the old ones. A fix could be genuinely deployed
 * and the owner would still see no change — which is exactly what "nothing
 * progressive" describes.
 *
 * So the queue now stores the FACTS and builds the sentence at send time.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rerenderOwnerQuestion } from '../src/services/delegation/delegationCaptureService';

const read = (...p: string[]) => readFileSync(join(__dirname, '..', 'src', ...p), 'utf-8');
const queueSrc = read('services', 'brainPrompts', 'brainPromptQueueService.ts');

const ambiguous = {
  source: 'delegation_capture',
  kind: 'delegation_reply_ambiguous',
  question_ctx: { who: 'Hamna Latif Bhutta', item: 'service sales package video', said: 'Sure, sending today' },
};

describe('DEF-126 — the sentence is built when it is sent', () => {
  it('rebuilds the notice that made the owner say "meaningless"', () => {
    const text = rerenderOwnerQuestion(ambiguous)!;
    expect(text).toBeTruthy();

    // What was missing from the message he received: who, and what she said.
    expect(text).toContain('Hamna Latif Bhutta');
    expect(text).toContain('Sure, sending today');

    // And the exact sentence he received twice must be gone.
    expect(text).not.toContain('A reply arrived from a contact');
    expect(text).not.toContain('Please tell me which item it belongs to');
  });

  it('a row queued before the fix keeps its stored text rather than losing its facts', () => {
    // Pre-DEF-126 rows carry no context. Rebuilding from nothing would strip the
    // name and the quote back out — worse than the stale sentence.
    expect(rerenderOwnerQuestion({ source: 'delegation_capture', kind: 'delegation_reply_ambiguous' })).toBeNull();
  });

  it('never touches prompts that are not delegation notices', () => {
    expect(rerenderOwnerQuestion({ source: 'star_cadence', kind: 'nudge' })).toBeNull();
    expect(rerenderOwnerQuestion({})).toBeNull();
    expect(rerenderOwnerQuestion(null)).toBeNull();
    expect(rerenderOwnerQuestion('nonsense')).toBeNull();
  });

  it('an unknown kind still yields a sentence naming the person', () => {
    // Forward compatibility: a kind added later must not produce a blank body.
    const text = rerenderOwnerQuestion({ ...ambiguous, kind: 'delegation_something_new' });
    expect(text).toContain('Hamna Latif Bhutta');
  });

  it('the send path uses the rebuilt text for BOTH the body and the summary', () => {
    // The summary is what shows in the notification preview. Rebuilding one and
    // not the other would leave the old wording on the part he reads first.
    expect(queueSrc).toMatch(/summary:\s*clip\(questionText,/);
    expect(queueSrc).toMatch(/body:\s*questionText,/);
  });

  it('a failed rebuild sends the stored question instead of nothing', () => {
    // A badly worded notice is a complaint. A notice that never arrives is a
    // missed delegation — strictly the worse failure.
    const block = queueSrc.slice(queueSrc.indexOf('let questionText = next.question'));
    expect(block.slice(0, 700)).toMatch(/catch\s*\{[^}]*\}/);
    expect(block.slice(0, 700)).toContain('let questionText = next.question');
  });

  it('the notice stores its context so it can be rebuilt at all', () => {
    expect(read('services', 'delegation', 'delegationCaptureService.ts')).toContain('question_ctx: context');
  });
});
