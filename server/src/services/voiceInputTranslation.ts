// ═════════════════════════════════════════════════════════════════════════════
// voiceInputTranslation — decides whether a voice-note transcript should be
// translated BEFORE it enters the brain pipeline.
//
// A5 (2026-07-08): replyLanguage is an OUTPUT preference — the language pin
// in brainPersonaService already guarantees English replies when it's set.
// Rewriting the INPUT loses nuance and can invert instructions embedded in
// the voice note ("usko English mein mat bhejna" mistranslated flips intent).
// So: transcribe in the spoken language, always — unless the user has
// EXPLICITLY opted in to input translation (brain_channel.translateVoiceInput).
// ═════════════════════════════════════════════════════════════════════════════

export function resolveInputTranslation(prefs: any): 'english' | null {
  return prefs?.brain_channel?.translateVoiceInput === true ? 'english' : null;
}
