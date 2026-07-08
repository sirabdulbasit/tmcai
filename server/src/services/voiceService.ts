// ═════════════════════════════════════════════════════════════════════════════
// voiceService.ts — Speech-to-Text and Text-to-Speech for WhatsApp voice notes
//
// Inbound: Voice note → Google Speech-to-Text → text (for processing)
// Outbound: Text response → Google Text-to-Speech → voice note (OGG/Opus)
//
// Supports: Urdu, English, mixed (auto-detect)
// ═════════════════════════════════════════════════════════════════════════════

import createLogger from '../utils/logger';

const log = createLogger('voice');

// ─── Speech-to-Text: transcribe voice note to text ────────────────────────────

export async function transcribeVoiceNote(
  audioBuffer: Buffer,
  mimeType?: string,
  opts?: { translateTo?: 'english' | null },
): Promise<{
  text: string;
  language: string;
  confidence: number;
}> {
  // Try Gemini first (always available, supports Urdu + English + mixed).
  // Pass the actual upload mime through — browser MediaRecorder usually
  // sends webm/opus, not ogg/opus, and Gemini rejects mime mismatches.
  // translateTo='english': Gemini transcribes AND translates in one call.
  // Per Basit preference 2026-07-08: "always transcribe voice note into
  // english" — even when the speaker uses Urdu, downstream Brain
  // reasoning + logs stay in English.
  try {
    const geminiResult = await transcribeWithGemini(audioBuffer, mimeType, opts?.translateTo === 'english');
    if (geminiResult.text) return geminiResult;
  } catch (e: any) {
    log.error('Gemini transcription failed, trying Google Speech', { error: e.message });
  }

  // Fallback to Google Cloud Speech-to-Text
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return { text: '', language: 'unknown', confidence: 0 };
  }

  try {
    const speech = await import('@google-cloud/speech');
    const client = new speech.SpeechClient();

    const audio = { content: audioBuffer.toString('base64') };

    // Auto-detect language: try Urdu first, fallback to English, or use multi-language
    const config = {
      encoding: 'OGG_OPUS' as any,
      sampleRateHertz: 16000,
      languageCode: 'ur-PK',               // Primary: Urdu
      alternativeLanguageCodes: ['en-US', 'en-PK', 'hi-IN'], // Fallback: English, Hindi
      enableAutomaticPunctuation: true,
      model: 'default',
    };

    const [response] = await client.recognize({ audio, config });
    const results = response.results || [];

    if (results.length === 0) {
      log.info('No speech detected in voice note');
      return { text: '', language: 'unknown', confidence: 0 };
    }

    const best = results[0]?.alternatives?.[0];
    const text = best?.transcript || '';
    const confidence = best?.confidence || 0;
    const detectedLang = results[0]?.languageCode || 'ur-PK';

    log.info('Voice transcribed', { textLen: text.length, language: detectedLang, confidence });
    return { text, language: detectedLang, confidence };
  } catch (error: any) {
    log.error('Google Speech transcription also failed', { error: error.message });
    return { text: '', language: 'unknown', confidence: 0 };
  }
}

// ─── Fallback: Gemini audio transcription ─────────────────────────────────────

// Map a browser-supplied mimetype to one Gemini's audio input accepts.
// MediaRecorder on Chrome emits "audio/webm;codecs=opus" by default; on
// Safari it's "audio/mp4". We strip codec params and whitelist a known
// set \u2014 anything else falls back to ogg/opus.
function geminiAudioMime(input?: string): string {
  const base = (input ?? '').split(';')[0]!.trim().toLowerCase();
  switch (base) {
    case 'audio/webm':
    case 'audio/ogg':
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/mpeg':
    case 'audio/mp3':
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/aac':
    case 'audio/flac':
      return base === 'audio/x-wav' ? 'audio/wav' : base === 'audio/m4a' ? 'audio/mp4' : base;
    default:
      return 'audio/ogg';
  }
}

// Boilerplate Gemini emits when there's no clear speech. Treat these as
// empty so the caller routes the user to "speak louder" rather than
// passing a meaningless string into the instruction extractor.
const SILENCE_BOILERPLATE = [
  'i cannot', "i can't",
  'cannot hear', "can't hear",
  'no audio', 'no speech', 'no discernible',
  'inaudible', 'unintelligible', 'silence',
  'audio is empty', 'audio is silent',
  'unable to transcribe', "couldn't transcribe",
];

function looksLikeSilence(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return true;
  if (t.length < 2) return true;
  // Pure punctuation or bracketed placeholder \u2192 silence
  if (/^[\[\(].*[\]\)]$/.test(t)) return true;
  if (/^[\s.,!?\-\u2014]+$/.test(t)) return true;
  return SILENCE_BOILERPLATE.some((needle) => t.includes(needle));
}

async function transcribeWithGemini(
  audioBuffer: Buffer,
  mimeType?: string,
  translateToEnglish: boolean = false,
): Promise<{ text: string; language: string; confidence: number }> {
  const { getGenAI } = await import('./genaiClient');
  const ai = getGenAI();

  // English-only path (Basit preference 2026-07-08): skip the Urdu-
  // script gymnastics entirely. One Gemini call, transcribe + translate.
  if (translateToEnglish) {
    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: `Transcribe this audio and output the result in ENGLISH ONLY. If the speaker uses Urdu, Hindi, or any other language, TRANSLATE their words into natural English — preserve meaning, tone, and any numbers/names verbatim. If the speaker mixes English with another language, translate the non-English parts into English while keeping the English parts as-is. Return ONLY the English transcript — no commentary, no source-language original, no brackets, no labels. If the audio has no clear speech, return an empty response.` },
            { inlineData: { mimeType: geminiAudioMime(mimeType), data: audioBuffer.toString('base64') } },
          ],
        },
      ],
      config: { maxOutputTokens: 500 },
    });
    const raw = (result.text ?? '').trim();
    if (looksLikeSilence(raw)) {
      log.info('Gemini English-translate transcript looks like silence; returning empty', { raw: raw.slice(0, 80) });
      return { text: '', language: 'unknown', confidence: 0 };
    }
    return { text: raw, language: 'en-US', confidence: 0.8 };
  }

  // The user (Basit, Pakistan) speaks Urdu, English, or a mix. Gemini's
  // default tends to render Urdu speech in Devanagari (Hindi script,
  // \u0900-\u097F) because Urdu and Hindi sound similar \u2014 the model picks
  // the more-trained script. Explicit prompt now: NEVER Devanagari.
  // Urdu must be in Arabic script (\u0600-\u06FF); English in Latin script;
  // mixed = keep both as-is in their own scripts. If the audio is
  // English-only, return English. The forbidden-Devanagari clause is the
  // single most important rule here \u2014 the user 2026-05-13 flagged a KD
  // Bhatti voice note rendered in Hindi script and called it out.
  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { text: `Transcribe this audio. Return ONLY the spoken words verbatim \u2014 no commentary, no labels, no quotes, no brackets.

SCRIPT RULES (non-negotiable):
- If the speech is Urdu, write it in URDU SCRIPT (Arabic script, e.g. \u0633\u0631 \u0627\u062F\u06BE\u0631 \u0633\u06D2 \u06C1\u0645 \u0627\u067E\u0646\u06CC \u0633\u0627\u0631\u06CC \u0648\u0631\u06A9\u0646\u06AF \u06A9\u0645\u067E\u0644\u06CC\u0679 \u06A9\u0631\u06CC\u06BA \u06AF\u06D2). NEVER Devanagari / Hindi script.
- If the speech is English, write it in English (Latin script).
- If the speech mixes Urdu and English, keep each word in its own script: Urdu words in Arabic script, English words in Latin script. Do not transliterate one into the other.
- Do NOT output Devanagari / Hindi characters (U+0900 to U+097F). This audio is from Pakistan; the language is Urdu, not Hindi, even if some words sound alike.

If the audio has no clear speech, return an empty response.` },
          { inlineData: { mimeType: geminiAudioMime(mimeType), data: audioBuffer.toString('base64') } },
        ],
      },
    ],
    config: { maxOutputTokens: 500 },
  });

  let raw = (result.text ?? '').trim();
  if (looksLikeSilence(raw)) {
    log.info('Gemini transcript looks like silence/boilerplate; returning empty', { raw: raw.slice(0, 80) });
    return { text: '', language: 'unknown', confidence: 0 };
  }
  // Safety net: if Gemini ignored the rule and emitted Devanagari anyway,
  // retry once with a stronger forbid clause. After one retry, if it
  // still emits Hindi script, accept the Latin-script fallback by
  // asking for transliteration explicitly (last resort).
  const hasDevanagari = /[\u0900-\u097F]/.test(raw);
  if (hasDevanagari) {
    log.warn('Gemini emitted Devanagari despite Urdu-only instruction; retrying', { raw: raw.slice(0, 80) });
    try {
      const retry = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { text: `Transcribe this audio. The speaker is from Pakistan and speaks URDU. Output the transcript in URDU SCRIPT (Arabic script, U+0600 to U+06FF) \u2014 for example \u0633\u0631 \u0627\u062F\u06BE\u0631 \u0633\u06D2 \u06C1\u0645. You are FORBIDDEN from using Devanagari / Hindi script (U+0900 to U+097F). If you cannot transcribe in Urdu script, transliterate to Roman Urdu (Latin letters, e.g. "Sir idhar se hum") \u2014 but NEVER Hindi script. Return ONLY the transcript, no commentary.` },
              { inlineData: { mimeType: geminiAudioMime(mimeType), data: audioBuffer.toString('base64') } },
            ],
          },
        ],
        config: { maxOutputTokens: 500 },
      });
      const retryText = (retry.text ?? '').trim();
      if (retryText && !/[\u0900-\u097F]/.test(retryText)) raw = retryText;
    } catch (e: any) {
      log.error('Gemini Devanagari retry failed', { error: e.message });
    }
  }
  // Final defense: if BOTH transcription attempts still emitted
  // Devanagari, drop down to a text-only conversion call. The previous
  // two calls had audio context which may have biased the model toward
  // Hindi; this one is a pure script-conversion task with no audio
  // distraction. Per user 2026-05-14: "we should have only 2 languages
  // right now english and urdu" \u2014 Hindi is not acceptable.
  if (/[\u0900-\u097F]/.test(raw)) {
    log.warn('Both transcription passes returned Devanagari \u2014 running script-conversion fallback');
    try {
      const converted = await transliterateDevanagariToUrdu(raw);
      if (converted && !/[\u0900-\u097F]/.test(converted)) raw = converted;
    } catch (e: any) {
      log.error('Script conversion fallback failed', { error: e.message });
    }
  }
  const isUrdu = /[\u0600-\u06FF]/.test(raw);
  return { text: raw, language: isUrdu ? 'ur-PK' : 'en-US', confidence: 0.8 };
}

/**
 * Convert Devanagari (Hindi script) text to Urdu script (Arabic).
 *
 * This is a pure script-conversion call \u2014 same spoken language, just
 * a different writing system. Used as the third-stage defense after
 * transcription when Gemini refuses to emit Urdu script. Also used by
 * the one-shot backfill script (scripts/backfillDevanagariToUrdu.ts)
 * to repair feed_events already stored with Devanagari text from
 * before the 2026-05-14 voice-script fixes.
 *
 * Exported so callers (ingest, backfill, future render-time defense)
 * can share the same conversion logic.
 *
 * Brain-vs-programmer note (per memory rule): this defensive
 * conversion exists because Gemini 2.5 Flash is unreliable at
 * honoring "use Arabic script not Devanagari" instructions for Urdu
 * speech. The proper fix is to route Urdu voice transcription
 * through a model that handles the language more reliably (or pin
 * a Urdu-optimized multilingual model). Carrying this layer until
 * we benchmark alternatives.
 */
export async function transliterateDevanagariToUrdu(text: string): Promise<string> {
  if (!text || !/[\u0900-\u097F]/.test(text)) return text;
  const { getGenAI } = await import('./genaiClient');
  const ai = getGenAI();
  const r = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { text: `Convert the following text from Devanagari (Hindi script) to Urdu script (Arabic script, U+0600 to U+06FF). The underlying language is the same \u2014 only the writing system changes. Keep any English words in Latin script unchanged. Return ONLY the converted text, no commentary, no preamble, no quotes.

Input:
${text}` },
        ],
      },
    ],
    config: { maxOutputTokens: 1000 },
  });
  return String(r.text ?? '').trim();
}

// ─── Text-to-Speech: convert text to voice note ───────────────────────────────

export async function textToVoiceNote(text: string, language?: string): Promise<Buffer | null> {
  // Skip if text is too short or too long for voice
  if (!text || text.length < 5 || text.length > 3000) return null;

  // Try Google Cloud TTS first (requires GOOGLE_APPLICATION_CREDENTIALS)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const tts = await import('@google-cloud/text-to-speech');
      const client = new tts.TextToSpeechClient();

      // Google Cloud TTS only ships Urdu under the IN locale \u2014
      // 'ur-PK-*' voices do NOT exist in their catalogue and any request
      // for one returns 3 INVALID_ARGUMENT ("Voice ... does not exist.
      // Is it misspelled?") which makes voicenote outbound fall back to
      // text-only without any audio reaching the recipient. Use the
      // IN-locale equivalent; the language model is the same Urdu \u2014
      // the locale tag only affects voice ID lookup, not pronunciation.
      const isUrdu = /[\u0600-\u06FF]/.test(text)
        || language === 'ur-PK' || language === 'ur-IN' || language === 'ur';
      const voiceConfig = isUrdu
        ? { languageCode: 'ur-IN', name: 'ur-IN-Standard-A', ssmlGender: 'FEMALE' as any }
        : { languageCode: 'en-US', name: 'en-US-Neural2-F', ssmlGender: 'FEMALE' as any };

      const [response] = await client.synthesizeSpeech({
        input: { text },
        voice: voiceConfig,
        audioConfig: { audioEncoding: 'OGG_OPUS' as any, speakingRate: 1.0, pitch: 0 },
      });

      if (response.audioContent) {
        const buffer = Buffer.from(response.audioContent as Uint8Array);
        log.info('Voice note generated (Google TTS)', { textLen: text.length, audioLen: buffer.length });
        return buffer;
      }
    } catch (error: any) {
      log.error('Google TTS failed', { error: error.message });
    }
  }

  // No Google Cloud credentials — voice reply not available
  // Return null, caller will send text-only response
  log.info('TTS not available (no GOOGLE_APPLICATION_CREDENTIALS). Sending text only.');
  return null;
}

// ─── Detect language of text ──────────────────────────────────────────────────

export function detectLanguage(text: string): 'urdu' | 'english' | 'mixed' {
  const hasUrdu = /[\u0600-\u06FF]/.test(text);
  const hasEnglish = /[a-zA-Z]{3,}/.test(text);
  if (hasUrdu && hasEnglish) return 'mixed';
  if (hasUrdu) return 'urdu';
  return 'english';
}
