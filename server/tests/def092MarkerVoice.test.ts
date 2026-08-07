/**
 * DEF-092 — Brain's system replies stop being robotic.
 *
 * Owner, 2026-08-07: *"i don't want robotic answers if i talk to brain neither
 * anyone else talk to brain"*, objective *"smart thinking of brain like living
 * assistant"*.
 *
 * The failure being fixed: 102 bracketed markers exist; 25 mapped to FIXED
 * English sentences and 77 were stripped to nothing. So Brain recited one of two
 * dozen canned lines or went silent. The silence is the worse half — the user
 * watches their request vanish and concludes Brain is broken.
 *
 * These assertions pin the two properties that must survive any future edit:
 * a marker never reaches a human as raw brackets, and it never becomes silence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const callLLM = vi.hoisted(() => vi.fn());
vi.mock('../src/services/llmRouter', () => ({ callLLM }));

import { renderMarkerInBrainVoice } from '../src/services/knowledge/markerVoice';
import {
  sanitizeAnswerInBrainVoice,
  sanitizeAnswerForUser,
  curatedMarkerMeaning,
  isWholeMarker,
} from '../src/services/knowledge/answerSanitizer';

beforeEach(() => callLLM.mockReset());
afterEach(() => vi.clearAllMocks());

describe('DEF-092 marker voice — a marker is spoken, never printed', () => {
  it('renders a whole-answer marker through the LLM instead of a canned sentence', async () => {
    callLLM.mockResolvedValue({ text: "Got it, noted that down.", provider: 'gemini' });
    const out = await sanitizeAnswerInBrainVoice('[noted]', { clientNumber: 'TMC-0001', userId: 2 });
    expect(out).toBe('Got it, noted that down.');
    expect(callLLM).toHaveBeenCalledTimes(1);
  });

  it('hands the CURATED meaning to the renderer, not the raw marker, when one exists', async () => {
    // The 25 curated replacements were reworded against real transcripts to
    // avoid implying a dispatch that never happened. That precision must
    // survive: the LLM rephrases the vetted fact rather than re-deriving it
    // from a terse marker.
    callLLM.mockResolvedValue({ text: 'anything', provider: 'gemini' });
    await sanitizeAnswerInBrainVoice('[no action dispatched — retry]', {});
    const userMessage = callLLM.mock.calls[0][1] as string;
    expect(userMessage).toContain("nothing was executed on my end");
    expect(userMessage).not.toContain('[no action dispatched');
  });

  it('carries tenant and user scoping into the LLM call', async () => {
    // Owner instruction 2026-08-07: keep things with tenant and user isolation.
    callLLM.mockResolvedValue({ text: 'ok', provider: 'gemini' });
    await renderMarkerInBrainVoice('[cancelled]', { clientNumber: 'TMC-0002', userId: 7 });
    expect(callLLM.mock.calls[0][2]).toMatchObject({ clientNumber: 'TMC-0002', userId: 7 });
  });

  it('NEVER returns silence when the LLM fails — the 77-stripped-markers bug', async () => {
    callLLM.mockImplementationOnce(() => Promise.reject(new Error('provider down')));
    const out = await renderMarkerInBrainVoice('[delegate failed: no email on file]');
    expect(out.trim()).not.toBe('');
    // The fact survives the failure — the fallback restates the marker's own
    // words rather than inventing a reason or going quiet.
    expect(out.toLowerCase()).toContain('delegate failed');
    expect(out.toLowerCase()).toContain('no email on file');
    expect(out.startsWith('[')).toBe(false); // never raw brackets
  });

  it('NEVER returns raw brackets when the model echoes the marker back', async () => {
    // A model that returns the marker verbatim has not done the job; treating
    // that as success would put square brackets on the owner's phone.
    callLLM.mockResolvedValue({ text: '[cancelled]', provider: 'gemini' });
    const out = await renderMarkerInBrainVoice('[cancelled]');
    expect(out.startsWith('[')).toBe(false);
  });

  it('falls back to the synchronous sanitizer rather than throwing', async () => {
    callLLM.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const out = await sanitizeAnswerInBrainVoice('[cancelled]', {});
    expect(out.trim()).not.toBe('');
    expect(out).not.toMatch(/^\[/);
  });

  it('leaves ordinary prose completely untouched and makes no LLM call', async () => {
    // Only whole-answer markers are spoken. Rewriting a real reply that merely
    // contains brackets would risk the fabrication this codebase keeps fighting.
    const prose = 'Hamna replied that round 1 testing is done.';
    expect(await sanitizeAnswerInBrainVoice(prose, {})).toBe(prose);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('identifies whole markers but not prose that merely contains brackets', () => {
    expect(isWholeMarker('[noted]')).toBe(true);
    expect(isWholeMarker('  [due date set: Friday]  ')).toBe(true);
    expect(isWholeMarker('I noted it [see item 3]')).toBe(false);
    expect(isWholeMarker('')).toBe(false);
  });

  it('DEF-102: the whole-answer marker that leaked to the owner is now spoken', async () => {
    // 2026-08-08 02:43, verbatim from his phone. D-14 rendered markers at four
    // call sites and missed the main answer path, so this one shipped raw.
    // Rendering now lives in sendReply, the single chokepoint every reply
    // passes through.
    callLLM.mockResolvedValue({
      text: "I couldn't find that item to update — the reference I had is out of date.",
      provider: 'gemini',
    });
    const leaked = '[update_open_item: id not found — reference may be stale, retry by title]';
    const out = await sanitizeAnswerInBrainVoice(leaked, { clientNumber: 'TMC-0001', userId: 2 });
    expect(out.startsWith('[')).toBe(false);
    expect(out).not.toContain('update_open_item');
    expect(out).not.toContain('retry by title');
  });

  it('DEF-102: an UNCURATED marker is still spoken, never passed through raw', async () => {
    // The sync sanitizer maps 25 markers and strips a narrow embedded set; this
    // one matched neither, which is exactly why it shipped verbatim. The voice
    // renderer must not depend on anyone having curated it first.
    callLLM.mockResolvedValue({ text: 'I could not find that one.', provider: 'gemini' });
    const out = await sanitizeAnswerInBrainVoice('[some_action: a marker nobody curated]', {});
    expect(out.startsWith('[')).toBe(false);
    expect(callLLM).toHaveBeenCalled();
  });

  it('keeps the synchronous sanitizer working for non-conversational surfaces', () => {
    // It is the fallback path, so a regression here silently degrades every
    // failure case above.
    expect(sanitizeAnswerForUser('[cancelled]')).toBe('OK, cancelled.');
    expect(curatedMarkerMeaning('[cancelled]')).toBe('OK, cancelled.');
    expect(curatedMarkerMeaning('[some unmapped marker]')).toBeNull();
  });
});
