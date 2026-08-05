/**
 * DEF-032 / DEF-033 — 2026-08-05 11:53–11:57.
 *
 * The owner dictated a 5-step plan (update + delegate three items) and saw a
 * correct preview. A follow-up question created a NEW pending action, which
 * silently cancelled the plan. His "send" then confirmed the replacement — a
 * CANNED TEST EMAIL — which went to a real colleague under his own name. He
 * spent five more minutes discovering nothing had been delegated.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { displacementNotice } from '../src/services/knowledge/brainComposer';

const SRC = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
const CODE = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('displacement is announced, never silent', () => {
  it('names a multi-step plan by its step count', () => {
    const n = displacementNotice({ actionKind: 'action_plan', stepCount: 5 });
    expect(n).toContain('5-step plan');
    expect(n).toContain("hadn't confirmed");
    // The point: it tells the owner what "send" now means.
    expect(n).toContain('"send" now applies to what\'s below');
  });
  it('names a single displaced action readably', () => {
    expect(displacementNotice({ actionKind: 'send_email', stepCount: 1 })).toContain('pending send email');
  });
  it('says nothing when nothing was displaced', () => {
    expect(displacementNotice(undefined)).toBe('');
  });
  it('startPending reports what it displaced', () => {
    const c = CODE(SRC('services/knowledge/pendingActionService.ts'));
    expect(c).toContain('replaced');
    expect(c).toMatch(/return \{ \.\.\.rowToPending\(row\), replaced \}/);
  });
  it('the plan preview carries the notice', () => {
    const c = CODE(SRC('services/knowledge/brainComposer.ts'));
    expect(c).toContain('displacementNotice((pending as any).replaced)');
    expect(c).toContain('answer: previewWithNotice');
  });
});

describe('the test-email template cannot hijack a real request (DEF-033)', () => {
  const c = SRC('services/knowledge/brainComposer.ts');
  it('requires the user to literally say "test"', () => {
    expect(c).toContain('ONLY when the user literally says "test"');
  });
  it('forbids applying the template to any other request', () => {
    expect(c).toContain('NEVER apply the test-email template to any other request');
    expect(c).toContain('A vague "email them" is never a test email');
  });
  it('tells Brain to ask, or compose from the real subject, when content is unspecified', () => {
    expect(c).toMatch(/you MUST ask what the message should say, or compose it from the ACTUAL subject/);
  });
  it('records the incident so the rule is not "cleaned up" later', () => {
    expect(c).toContain('sent to a real colleague under the user\'s own name');
  });
});
