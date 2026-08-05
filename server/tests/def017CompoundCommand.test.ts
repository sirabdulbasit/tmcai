/**
 * DEF-017 — compound commands partially consumed (3rd recurrence of
 * `pending-prompt-eats-command`, so a STRUCTURAL fix was required).
 *
 * Production: with "what priority for Vision Metric Integration?" awaiting, the
 * owner said "Priority High, due date today and delegate to Hamna Latif". The
 * verdict was binary over the whole message, so all of it was consumed as the
 * answer: the deadline became a fabricated 2024-03-29, a junk task titled
 * "Priority High" appeared, and the delegation vanished.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  parseRelevanceVerdict, mayConsumeAsAnswer, mayConsumePartially,
  RELEVANCE_CONFIDENCE_THRESHOLD,
} from '../src/services/brainPrompts/promptReplyRelevance';
import { parseDuePhrase } from '../src/services/brainPrompts/promptReplyHandler';

const PARTIAL = JSON.stringify({
  relevance: 'partially_answers', confidence: 0.9,
  answerPart: 'High',
  residual: 'Set the due date of Vision Metric Integration to today and delegate it to Hamna Latif',
});

describe('the verdict can now express a SPLIT', () => {
  it('parses a partial verdict with both halves', () => {
    const v = parseRelevanceVerdict(PARTIAL)!;
    expect(v.relevance).toBe('partially_answers');
    expect(v.answerPart).toBe('High');
    expect(v.residual).toContain('delegate it to Hamna Latif');
    expect(mayConsumePartially(v)).toBe(true);
    // A partial is NOT a full answer — the caller must still act on the rest.
    expect(mayConsumeAsAnswer(v)).toBe(false);
  });

  it('an INCOMPLETE split is rejected outright — silently dropping half is the bug', () => {
    for (const bad of [
      { relevance: 'partially_answers', confidence: 0.9, answerPart: 'High' },
      { relevance: 'partially_answers', confidence: 0.9, residual: 'delegate to Hamna' },
      { relevance: 'partially_answers', confidence: 0.9, answerPart: '  ', residual: '  ' },
    ]) {
      expect(parseRelevanceVerdict(JSON.stringify(bad))).toBeNull();
    }
  });

  it('a low-confidence split does not mutate anything', () => {
    const v = parseRelevanceVerdict(JSON.stringify({
      relevance: 'partially_answers', confidence: RELEVANCE_CONFIDENCE_THRESHOLD - 0.01,
      answerPart: 'High', residual: 'delegate to Hamna',
    }));
    expect(mayConsumePartially(v)).toBe(false);
    expect(mayConsumeAsAnswer(v)).toBe(false);
  });

  it('existing verdicts are unchanged (no regression on the DEF-013 gate)', () => {
    const full = parseRelevanceVerdict('{"relevance":"answers_pending_prompt","confidence":0.9}')!;
    expect(mayConsumeAsAnswer(full)).toBe(true);
    expect(mayConsumePartially(full)).toBe(false);
    const greeting = parseRelevanceVerdict('{"relevance":"new_conversation_turn","confidence":0.99}');
    expect(mayConsumeAsAnswer(greeting)).toBe(false);
    expect(mayConsumePartially(greeting)).toBe(false);
    expect(parseRelevanceVerdict('not json')).toBeNull();
  });
});

describe('a fabricated past deadline can no longer be written', () => {
  it('rejects the exact date production wrote (2024-03-29)', () => {
    expect(parseDuePhrase('2024-03-29')).toBeNull();
  });
  it('rejects absurd future dates too', () => {
    expect(parseDuePhrase('2099-01-01')).toBeNull();
  });
  it('still accepts the phrases users actually type', () => {
    expect(parseDuePhrase('today')).toBeInstanceOf(Date);
    expect(parseDuePhrase('tomorrow')).toBeInstanceOf(Date);
    expect(parseDuePhrase('in 3 days')).toBeInstanceOf(Date);
    expect(parseDuePhrase('friday')).toBeInstanceOf(Date);
    const iso = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    expect(parseDuePhrase(iso)).toBeInstanceOf(Date);
  });
});

describe('wiring — the residual reaches the SAME compose path', () => {
  const HANDLER = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'brainPrompts', 'promptReplyHandler.ts'), 'utf8');
  const INBOUND = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'WhatsAppInbound.ts'), 'utf8');
  const CODE = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('only the answering half is recorded and fed to the side effect', () => {
    const c = CODE(HANDLER);
    expect(c).toContain('recordAnswer(awaiting.id, answerText)');
    expect(c).toMatch(/applySideEffect\(\s*awaiting\.sideEffect as any,\s*answerText/);
  });
  it('the handler returns the residual', () => {
    expect(CODE(HANDLER)).toContain('residualText');
  });
  it('the caller routes the residual to chat instead of returning', () => {
    const c = CODE(INBOUND);
    expect(c).toContain('if (r.residualText)');
    expect(c).toContain('queryText = r.residualText');
    // The unconditional early return is gone — that return is what dropped it.
    const idx = c.indexOf('if (r.residualText)');
    expect(c.slice(idx, idx + 400)).toMatch(/else \{\s*return;/);
  });
});
