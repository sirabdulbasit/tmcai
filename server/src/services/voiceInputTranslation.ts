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
  // Resolution order (2026-07-13 — so new clients don't need per-user
  // SQL): an EXPLICIT per-user setting always wins (true → translate,
  // false → don't, even if the deployment default says otherwise).
  // When the user hasn't set it at all, fall back to the deployment
  // default env BRAIN_INPUT_TRANSLATE_DEFAULT ('english' to translate).
  // A configured default is not a hardcoded assumption — the operator
  // sets it per box; any user can still opt out explicitly.
  const explicit = prefs?.brain_channel?.translateVoiceInput;
  if (explicit === true) return 'english';
  if (explicit === false) return null;
  return process.env.BRAIN_INPUT_TRANSLATE_DEFAULT === 'english' ? 'english' : null;
}
