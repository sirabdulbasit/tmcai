/**
 * DEF-161 — the option list must agree with the reading it accompanies.
 *
 * Owner, 2026-08-13: *"why brain is in asking mode, it can perform using its
 * intelligence, if something went wrong i will rectify where it should learn"*.
 *
 * Hamna told Brain "The Vision Metric's service sales package video is not yet
 * completed". Brain read it as in-progress (50% sure) — and then offered, as
 * its FIRST option, "should I mark it done". Taking that option would record
 * as finished the work she had just said was not finished: a false completion
 * written against contrary evidence.
 *
 * Measured baseline (production, 2026-08-15): all three delegation_reply_unclear
 * notices in 30 days that carried a reading (in progress ×2, blocked ×1) offered
 * "mark it done" anyway — and the 08-14 notice called Muhammad Yousaf "her".
 *
 * The fix derives the option set from the classified reading: the completion
 * option appears only when the reading itself is completed, and the counterpart
 * is referred to by the resolved name, never a hardcoded gendered pronoun.
 *
 * These tests exercise the REAL rendering path both ways it runs in production:
 *   - enqueue:  notifyOwner -> buildOwnerQuestion(metadata, context)
 *   - send:     rerenderOwnerQuestion(metadata) -> buildOwnerQuestion(m, question_ctx)
 */

import { describe, it, expect } from 'vitest';
import {
  buildOwnerQuestion,
  rerenderOwnerQuestion,
} from '../src/services/delegation/delegationCaptureService';

type Ctx = { who?: string; item?: string; said?: string; guess?: string; confidence?: number };

/** Render through the send-time rebuild path, exactly as the queue does. */
const renderUnclear = (ctx: Ctx): string => {
  const text = rerenderOwnerQuestion({
    source: 'delegation_capture',
    kind: 'delegation_reply_unclear',
    threadId: 't-def161',
    openItemId: 'oi-def161',
    question_ctx: ctx,
  });
  expect(text, 'unclear notice must render').toBeTruthy();
  return text!;
};

/** The completion option, as the owner would read it. */
const COMPLETION_OPTION = 'mark it done';

// The three real notices from the measured baseline, verbatim (I-2: the
// counterpart's words are reproduced, never paraphrased).
const PRODUCTION_ROWS: Array<{ label: string; ctx: Ctx }> = [
  {
    label: '08-14 09:44 Muhammad Yousaf — read: in progress (50%)',
    ctx: {
      who: 'Muhammad Yousaf',
      item: 'EXIM solution',
      said: 'Working on the EXIM solution.',
      guess: 'in progress',
      confidence: 0.5,
    },
  },
  {
    label: '08-12 07:56 Hamna Latif Bhutta — read: in progress (50%)',
    ctx: {
      who: 'Hamna Latif Bhutta',
      item: 'service sales package video',
      said: "The Vision Metric's service sales package video is not yet completed.",
      guess: 'in progress',
      confidence: 0.5,
    },
  },
  {
    label: '08-11 19:25 Hamna Latif Bhutta — read: blocked (20%)',
    ctx: {
      who: 'Hamna Latif Bhutta',
      item: 'service sales package video',
      said: 'No progress made; user is busy.',
      guess: 'blocked',
      confidence: 0.2,
    },
  },
];

describe('DEF-161 — option set derived from the classified reading', () => {
  it('AC-1: reading in-progress offers no completion option', () => {
    const text = renderUnclear({ who: 'Hamna Latif Bhutta', item: 'service sales package video', guess: 'in progress', confidence: 0.5 });
    expect(text, 'in-progress reading must not offer marking it done').not.toContain(COMPLETION_OPTION);
    // The remaining options survive — the notice still lets the owner act.
    expect(text, 'chase option names the counterpart').toContain('chase Hamna Latif Bhutta');
    expect(text, 'leave-it option survives').toContain('leave it');
  });

  it('AC-2: reading blocked offers no completion option', () => {
    const text = renderUnclear({ who: 'Hamna Latif Bhutta', guess: 'blocked', confidence: 0.2 });
    expect(text, 'blocked reading must not offer marking it done').not.toContain(COMPLETION_OPTION);
    expect(text, 'chase and leave options survive').toContain('or leave it?');
  });

  it('AC-3: reading not-started offers no completion option', () => {
    // The classifier's rawOutcome is snake_case; ctx.guess arrives with the
    // underscores already replaced ("not started"). Both spellings must be safe.
    for (const guess of ['not started', 'not_started']) {
      const text = renderUnclear({ who: 'Hamna Latif Bhutta', guess, confidence: 0.4 });
      expect(text, `reading "${guess}" must not offer marking it done`).not.toContain(COMPLETION_OPTION);
    }
  });

  it('AC-4: reading completed keeps the completion option (no over-correction)', () => {
    const text = renderUnclear({ who: 'Hamna Latif Bhutta', item: 'service sales package video', guess: 'completed', confidence: 0.6 });
    expect(text, 'a completed reading legitimately offers marking it done').toContain(COMPLETION_OPTION);
    expect(text, 'the other options remain alongside it').toContain('chase Hamna Latif Bhutta');
    expect(text, 'leave-it option remains').toContain('leave it');
  });

  it('AC-5: the three production notices each render without a completion option', () => {
    for (const { label, ctx } of PRODUCTION_ROWS) {
      const text = renderUnclear(ctx);
      expect(text, `${label}: no completion option`).not.toContain(COMPLETION_OPTION);
      // I-2 — the counterpart's words appear verbatim, never paraphrased.
      expect(text, `${label}: verbatim quote preserved`).toContain(ctx.said!);
      // The reading itself is still spoken out loud.
      expect(text, `${label}: the reading is still shown`).toContain(`My read: ${ctx.guess}`);
    }
  });

  it('AC-6: Muhammad Yousaf is never called "her"', () => {
    const text = renderUnclear(PRODUCTION_ROWS[0].ctx);
    expect(text, 'no gendered pronoun for a named counterpart').not.toMatch(/\bher\b/i);
    expect(text, 'the counterpart is chased by name').toContain('chase Muhammad Yousaf');
  });

  it('AC-6b: with no resolved name, the fallback is neutral, never gendered', () => {
    const text = renderUnclear({ guess: 'in progress', confidence: 0.5 });
    expect(text, 'unnamed counterpart gets they/them').not.toMatch(/\bher\b|\bhim\b|\bshe\b|\bhe\b/i);
    expect(text, 'chase option falls back to "them"').toContain('chase them');
  });

  it('no reading at all: the completion option is withheld (I-1 default)', () => {
    // An unclear notice with no classifier reading has no evidence of
    // completion — offering to record one would be the same false-completion
    // hazard this defect is about.
    const text = renderUnclear({ who: 'Hamna Latif Bhutta', said: 'Voice note, could not transcribe.' });
    expect(text, 'absent reading must not offer marking it done').not.toContain(COMPLETION_OPTION);
  });

  it('AC-7: delegation_completion_reported wording is byte-identical to today', () => {
    const text = rerenderOwnerQuestion({
      source: 'delegation_capture',
      kind: 'delegation_completion_reported',
      summary: 'Video exported and shared in the group.',
      question_ctx: { who: 'Hamna Latif Bhutta', item: 'service sales package video' },
    });
    expect(text, 'completion-reported notice renders byte-identically').toBe(
      'Hamna Latif Bhutta says "service sales package video" is done: ' +
      'Video exported and shared in the group. — confirm to close it, or tell me what is still missing.',
    );
  });

  it('AC-8: enqueue path and question_ctx rebuild path produce identical text', () => {
    // Enqueue side (notifyOwner): buildOwnerQuestion(metadata, context), then
    // metadata is stored as { source, ...metadata, question_ctx: context }.
    // Send side: rerenderOwnerQuestion(storedMetadata). Same input, same text.
    const metadata = { kind: 'delegation_reply_unclear', threadId: 't-def161', openItemId: 'oi-def161' };
    const context = PRODUCTION_ROWS[1].ctx;

    const enqueueText = buildOwnerQuestion(metadata, context);
    const rebuiltText = rerenderOwnerQuestion({
      source: 'delegation_capture',
      ...metadata,
      question_ctx: context,
    });

    expect(rebuiltText, 'rebuild path must render').toBeTruthy();
    expect(rebuiltText, 'both paths speak the same sentence').toBe(enqueueText);
    expect(enqueueText, 'and that sentence has no completion option').not.toContain(COMPLETION_OPTION);
  });
});
