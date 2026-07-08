import { describe, it, expect } from 'vitest';
import { resolveInputTranslation } from '../src/services/voiceInputTranslation';

// A5 — replyLanguage is an OUTPUT preference. It must never rewrite the
// INPUT: translating a voice-note transcript before the brain sees it
// loses nuance and can invert embedded instructions. Input translation
// happens only on explicit opt-in (translateVoiceInput=true).

describe('resolveInputTranslation', () => {
  it('does NOT translate input just because replyLanguage=english', () => {
    const prefs = { brain_channel: { replyLanguage: 'english' } };
    expect(resolveInputTranslation(prefs)).toBeNull();
  });

  it('translates input only on explicit opt-in', () => {
    const prefs = { brain_channel: { replyLanguage: 'english', translateVoiceInput: true } };
    expect(resolveInputTranslation(prefs)).toBe('english');
  });

  it('returns null for empty/missing prefs', () => {
    expect(resolveInputTranslation(undefined)).toBeNull();
    expect(resolveInputTranslation({})).toBeNull();
    expect(resolveInputTranslation({ brain_channel: {} })).toBeNull();
  });
});
