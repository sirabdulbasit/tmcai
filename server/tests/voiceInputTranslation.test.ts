import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveInputTranslation } from '../src/services/voiceInputTranslation';

// A5 — replyLanguage is an OUTPUT preference. It must never rewrite the
// INPUT: translating a voice-note transcript before the brain sees it
// loses nuance and can invert embedded instructions. Input translation
// happens only on explicit opt-in (translateVoiceInput=true).

const ORIG = process.env.BRAIN_INPUT_TRANSLATE_DEFAULT;
beforeEach(() => { delete process.env.BRAIN_INPUT_TRANSLATE_DEFAULT; }); // isolate from deployment default
afterEach(() => {
  if (ORIG === undefined) delete process.env.BRAIN_INPUT_TRANSLATE_DEFAULT;
  else process.env.BRAIN_INPUT_TRANSLATE_DEFAULT = ORIG;
});

describe('resolveInputTranslation', () => {
  it('does NOT translate input just because replyLanguage=english', () => {
    const prefs = { brain_channel: { replyLanguage: 'english' } };
    expect(resolveInputTranslation(prefs)).toBeNull();
  });

  it('translates input only on explicit opt-in', () => {
    const prefs = { brain_channel: { replyLanguage: 'english', translateVoiceInput: true } };
    expect(resolveInputTranslation(prefs)).toBe('english');
  });

  it('returns null for empty/missing prefs (no deployment default set)', () => {
    expect(resolveInputTranslation(undefined)).toBeNull();
    expect(resolveInputTranslation({})).toBeNull();
    expect(resolveInputTranslation({ brain_channel: {} })).toBeNull();
  });
});

// 2026-07-13 — new clients must not need per-user SQL. A deployment
// default (env) applies when the user hasn't set the pref; an explicit
// per-user setting always wins over the default.
describe('resolveInputTranslation — deployment default (BRAIN_INPUT_TRANSLATE_DEFAULT)', () => {
  it('unset pref + env=english → english (new-client auto-inherit, no SQL)', () => {
    process.env.BRAIN_INPUT_TRANSLATE_DEFAULT = 'english';
    expect(resolveInputTranslation({})).toBe('english');
    expect(resolveInputTranslation({ brain_channel: {} })).toBe('english');
    expect(resolveInputTranslation(null)).toBe('english');
  });

  it('explicit false wins over env=english (per-user opt-out honoured)', () => {
    process.env.BRAIN_INPUT_TRANSLATE_DEFAULT = 'english';
    expect(resolveInputTranslation({ brain_channel: { translateVoiceInput: false } })).toBeNull();
  });

  it('explicit true still english when env unset', () => {
    expect(resolveInputTranslation({ brain_channel: { translateVoiceInput: true } })).toBe('english');
  });

  it('env set to a non-english value does not opt in', () => {
    process.env.BRAIN_INPUT_TRANSLATE_DEFAULT = 'urdu';
    expect(resolveInputTranslation({})).toBeNull();
  });
});
