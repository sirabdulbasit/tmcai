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

export async function transcribeVoiceNote(audioBuffer: Buffer, mimeType?: string): Promise<{
  text: string;
  language: string;
  confidence: number;
}> {
  // Try Gemini first (always available, supports Urdu + English + mixed).
  // Pass the actual upload mime through — browser MediaRecorder usually
  // sends webm/opus, not ogg/opus, and Gemini rejects mime mismatches.
  try {
    const geminiResult = await transcribeWithGemini(audioBuffer, mimeType);
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

async function transcribeWithGemini(audioBuffer: Buffer, mimeType?: string): Promise<{ text: string; language: string; confidence: number }> {
  const { getGenAI } = await import('./genaiClient');
  const ai = getGenAI();

  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Transcribe this audio. Return ONLY the spoken words verbatim \u2014 no commentary, no labels, no quotes, no brackets. If Urdu, write in Urdu script. If English, write in English. If mixed, keep both. If the audio has no clear speech, return an empty response.' },
          { inlineData: { mimeType: geminiAudioMime(mimeType), data: audioBuffer.toString('base64') } },
        ],
      },
    ],
    config: { maxOutputTokens: 500 },
  });

  const raw = (result.text ?? '').trim();
  if (looksLikeSilence(raw)) {
    log.info('Gemini transcript looks like silence/boilerplate; returning empty', { raw: raw.slice(0, 80) });
    return { text: '', language: 'unknown', confidence: 0 };
  }
  const isUrdu = /[\u0600-\u06FF]/.test(raw);
  return { text: raw, language: isUrdu ? 'ur-PK' : 'en-US', confidence: 0.8 };
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

      const isUrdu = /[\u0600-\u06FF]/.test(text) || language === 'ur-PK';
      const voiceConfig = isUrdu
        ? { languageCode: 'ur-PK', name: 'ur-PK-Standard-A', ssmlGender: 'FEMALE' as any }
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
