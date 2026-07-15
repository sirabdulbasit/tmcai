import { describe, it, expect } from 'vitest';
import { qualifyAutoOpenItem } from '../qualityGate';

describe('qualifyAutoOpenItem', () => {
  it('accepts when title starts with an action verb', () => {
    const r = qualifyAutoOpenItem({ title: 'Review Q3 budget proposal' });
    expect(r.verdict).toBe('accept');
    expect(r.code).toBe('action_verb');
  });

  it('accepts when title contains a question mark', () => {
    const r = qualifyAutoOpenItem({ title: 'Can we ship by Friday?' });
    expect(r.verdict).toBe('accept');
    expect(r.code).toBe('question');
  });

  it('accepts when an explicit due date is set', () => {
    const r = qualifyAutoOpenItem({
      title: 'Vendor invoice — 7000 USD',
      dueDate: new Date('2026-06-01'),
    });
    expect(r.verdict).toBe('accept');
    expect(r.code).toBe('due_date');
  });

  it('accepts when archetype=reply_needed even without verb', () => {
    const r = qualifyAutoOpenItem({
      title: 'Quarterly numbers attached',
      archetype: 'reply_needed',
    });
    expect(r.verdict).toBe('accept');
    expect(r.code).toBe('archetype_reply_needed');
  });

  it('rejects pure FYI intent', () => {
    const r = qualifyAutoOpenItem({
      title: 'Review Q3 budget proposal',  // would otherwise pass
      intent: 'FYI',
    });
    expect(r.verdict).toBe('reject');
    expect(r.code).toBe('fyi_intent');
  });

  it('rejects when confidence is below the floor', () => {
    const r = qualifyAutoOpenItem({
      title: 'Review the doc',
      confidence: 0.4,
      minConfidence: 0.65,
    });
    expect(r.verdict).toBe('reject');
    expect(r.code).toBe('low_confidence');
  });

  it('rejects newsletter-looking content', () => {
    const r = qualifyAutoOpenItem({
      title: 'Review our weekly digest',
      body: 'View in browser. Click to unsubscribe.',
      senderEmail: 'no-reply@brand.com',
    });
    expect(r.verdict).toBe('reject');
    expect(r.code).toBe('newsletter');
  });

  it('rejects when title has no signal at all', () => {
    const r = qualifyAutoOpenItem({ title: 'meeting notes from yesterday' });
    expect(r.verdict).toBe('reject');
    expect(r.code).toBe('no_signal');
  });

  it('rejects empty / very short titles', () => {
    expect(qualifyAutoOpenItem({ title: '' }).code).toBe('empty_title');
    expect(qualifyAutoOpenItem({ title: 'hi' }).code).toBe('empty_title');
  });
});
