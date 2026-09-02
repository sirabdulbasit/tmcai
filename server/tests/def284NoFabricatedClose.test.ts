/**
 * DEF-284 — the ack reported a close that never happened.
 *
 * 2026-09-02 15:10. He quote-replied *"Extension received, so close it"* and was told
 * **"[completion recorded and item closed]"**. The item is still `NEW`, and
 * `item_status_history` records that exact transition as REJECTED — `approval required, none
 * provided`. Nothing closed.
 *
 * The mechanism is one identifier doing duty for two different questions.
 * `recordActionLifecycleReply` returns `outcome`, which is the interpretation of HIS SENTENCE
 * ('completed' | 'blocked' | 'in_progress'), and `applySideEffect` fell through to
 * `detail: result.outcome`. `composeAck` matches the literal string `'completed'` to
 * *"[completion recorded and item closed]"* — so **his own claim was echoed back to him as an
 * accomplished fact.** 9th `fabricated-status`, and the narrowest: the two facts were never
 * distinguished, so no guard could have caught the difference.
 */
import { describe, it, expect } from 'vitest';

const src = (rel: string) => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  return readFileSync(join(__dirname, '..', 'src', ...rel.split('/')), 'utf-8');
};
const stripComments = (s: string) =>
  s.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');

describe('DEF-284 — a reported completion is not a completed action', () => {
  it('never returns bare "completed" when the item did not close', () => {
    const handler = stripComments(src('services/brainPrompts/promptReplyHandler.ts'));
    const kase = handler.slice(handler.indexOf("case 'action_status_update': {"));
    const body = kase.slice(0, kase.indexOf('\n    }'));
    // the success path still exists and is still gated on the ACTION, not the report
    expect(body).toContain("if (result.closed) return { status: 'applied', detail: 'completed' };");
    // and the fallback no longer lets the REPORT reach that same string
    expect(body).toContain("result.outcome === 'completed'");
    expect(body).toContain('completion_reported_not_closed');
  });

  it('carries the refusal reason, so "which approval?" has an answer', () => {
    // He asked exactly that on 2026-09-02 and got a keyword search against item titles.
    const handler = stripComments(src('services/brainPrompts/promptReplyHandler.ts'));
    expect(handler).toContain('result.closeBlocked');
    const lifecycle = stripComments(src('services/openItems/actionLifecycleService.ts'));
    expect(lifecycle).toContain('closeBlocked');
    expect(lifecycle).toContain('approvalRequired');
  });

  it('the ack says the item is still OPEN, and never says it closed', () => {
    const handler = src('services/brainPrompts/promptReplyHandler.ts');
    const ack = handler.slice(handler.indexOf('function composeAck'));
    const body = ack.slice(0, ack.indexOf('\n}'));
    const at = body.indexOf('completion_reported_not_closed');
    expect(at).toBeGreaterThan(0);
    const line = body.slice(at, body.indexOf('\n', body.indexOf('return', at)));
    expect(line.toLowerCase()).toContain('still open');
    expect(line).not.toContain('item closed');
  });

  it('the two questions are answered by different fields', () => {
    // "what did he say" is `outcome`; "what happened" is `closed`. Conflating them is the whole
    // defect, so the success branch must key on `closed` and never on `outcome`.
    const handler = stripComments(src('services/brainPrompts/promptReplyHandler.ts'));
    const kase = handler.slice(handler.indexOf("case 'action_status_update': {"));
    const body = kase.slice(0, kase.indexOf('\n    }'));
    const successLine = body.split('\n').find((l) => l.includes("detail: 'completed'")) ?? '';
    expect(successLine).toContain('result.closed');
    expect(successLine).not.toContain('result.outcome');
  });
});
