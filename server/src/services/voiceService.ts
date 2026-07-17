// ═════════════════════════════════════════════════════════════════════════════
// voiceService.ts — Speech-to-Text and Text-to-Speech for WhatsApp voice notes
//
// Inbound: Voice note → Gemini / OpenAI / Google Speech fallback chain → text
// Outbound: Text response → Google Text-to-Speech → voice note (OGG/Opus)
//
// Supports: Urdu, English, mixed (auto-detect)
// ═════════════════════════════════════════════════════════════════════════════

import createLogger from '../utils/logger';
import fs from 'fs';

const log = createLogger('voice');
const voiceGeminiModel = () => process.env.VOICE_TRANSCRIPTION_GEMINI_MODEL || 'gemini-2.5-flash';

export type VoiceTranscriptionFailure =
  | 'invalid_media'
  | 'no_speech'
  | 'provider_unavailable'
  | 'provider_failed';

export interface VoiceTranscriptionResult {
  text: string;
  language: string;
  confidence: number;
  provider: 'gemini' | 'openai' | 'groq' | 'google' | 'none';
  failureReason?: VoiceTranscriptionFailure;
}

export interface VoiceProviderAttempt {
  at: string;
  clientNumber?: string;
  provider: VoiceTranscriptionResult['provider'];
  outcome: 'success' | 'no_speech' | 'failed';
  latencyMs: number;
  error?: string;
  mimeType: string;
  bytes: number;
}

const voiceAttemptHistory: VoiceProviderAttempt[] = [];
function recordVoiceAttempt(attempt: VoiceProviderAttempt): void {
  voiceAttemptHistory.push(attempt);
  if (voiceAttemptHistory.length > 100) voiceAttemptHistory.splice(0, voiceAttemptHistory.length - 100);
}
export function getVoiceTranscriptionHealth(clientNumber?: string): VoiceProviderAttempt[] {
  const scoped = clientNumber
    ? voiceAttemptHistory.filter((attempt) => attempt.clientNumber === clientNumber)
    : voiceAttemptHistory;
  return scoped.slice(-20);
}

export function getVoiceProviderConfiguration(): Record<string, { configured: boolean; detail?: string }> {
  const googlePath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
  return {
    gemini: { configured: process.env.USE_VERTEX_AI === 'true' || Boolean(process.env.GEMINI_API_KEY) },
    openai: { configured: Boolean(process.env.OPENAI_API_KEY) },
    groq: { configured: Boolean(process.env.GROQ_API_KEY) },
    google: {
      configured: Boolean(googlePath) && fs.existsSync(googlePath),
      ...(googlePath && !fs.existsSync(googlePath) ? { detail: 'credential file path does not exist' } : {}),
    },
  };
}

async function withVoiceTimeout<T>(provider: string, work: Promise<T>): Promise<T> {
  const timeoutMs = Math.max(5_000, Number(process.env.VOICE_TRANSCRIPTION_TIMEOUT_MS || 30_000));
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${provider} transcription timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const emptyTranscription = (
  failureReason: VoiceTranscriptionFailure,
  provider: VoiceTranscriptionResult['provider'] = 'none',
): VoiceTranscriptionResult => ({ text: '', language: 'unknown', confidence: 0, provider, failureReason });

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[redacted]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, 'AIza[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

/** Honest, actionable WhatsApp marker; never impersonates a Brain answer. */
export function voiceTranscriptionFailureMarker(reason?: VoiceTranscriptionFailure): string {
  if (reason === 'no_speech') {
    return '[I could not hear clear speech — please resend a slightly longer voice note or type the message]';
  }
  if (reason === 'invalid_media') {
    return '[I could not read that voice note — please resend it or type the message]';
  }
  return '[voice transcription is temporarily unavailable — please type the message while it recovers]';
}

// ─── Speech-to-Text: transcribe voice note to text ────────────────────────────

export async function transcribeVoiceNote(
  audioBuffer: Buffer,
  mimeType?: string,
  opts?: { translateTo?: 'english' | null; clientNumber?: string },
): Promise<{
  text: string;
  language: string;
  confidence: number;
  provider: VoiceTranscriptionResult['provider'];
  failureReason?: VoiceTranscriptionFailure;
}> {
  const normalizedMime = detectAudioMime(audioBuffer, mimeType);
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length < 16) {
    log.warn('Voice transcription rejected invalid media', { bytes: audioBuffer?.length ?? 0, mimeType: normalizedMime });
    return emptyTranscription('invalid_media');
  }

  let attempted = 0;
  let failed = 0;
  let returnedNoSpeech = 0;
  const recordAttempt = (attempt: Omit<VoiceProviderAttempt, 'clientNumber'>) => {
    recordVoiceAttempt({ ...attempt, ...(opts?.clientNumber ? { clientNumber: opts.clientNumber } : {}) });
  };

  // Try Gemini first when configured (supports Urdu + English + mixed).
  // Pass the actual upload mime through — browser MediaRecorder usually
  // sends webm/opus, not ogg/opus, and Gemini rejects mime mismatches.
  // translateTo='english': Gemini transcribes AND translates in one call.
  // Per Basit preference 2026-07-08: "always transcribe voice note into
  // english" — even when the speaker uses Urdu, downstream Brain
  // reasoning + logs stay in English.
  const geminiConfigured = process.env.USE_VERTEX_AI === 'true' || Boolean(process.env.GEMINI_API_KEY);
  if (geminiConfigured) {
    attempted += 1;
    const started = Date.now();
    try {
      const geminiResult = await withVoiceTimeout('gemini', transcribeWithGemini(audioBuffer, normalizedMime, opts?.translateTo === 'english'));
      if (geminiResult.text) {
        recordAttempt({ at: new Date().toISOString(), provider: 'gemini', outcome: 'success', latencyMs: Date.now() - started, mimeType: normalizedMime, bytes: audioBuffer.length });
        return { ...geminiResult, provider: 'gemini' };
      }
      returnedNoSpeech += 1;
      recordAttempt({ at: new Date().toISOString(), provider: 'gemini', outcome: 'no_speech', latencyMs: Date.now() - started, mimeType: normalizedMime, bytes: audioBuffer.length });
    } catch (e: unknown) {
      failed += 1;
      recordAttempt({ at: new Date().toISOString(), provider: 'gemini', outcome: 'failed', latencyMs: Date.now() - started, error: boundedError(e), mimeType: normalizedMime, bytes: audioBuffer.length });
      log.error('Voice transcription provider failed', {
        provider: 'gemini', error: boundedError(e), bytes: audioBuffer.length, mimeType: normalizedMime,
      });
    }
  }

  // OpenAI is an independent fallback for production installations that do
  // not carry Google service-account credentials. WhatsApp audio is passed
  // with its real MIME type; no local ffmpeg/Chromium dependency is needed.
  if (process.env.OPENAI_API_KEY) {
    attempted += 1;
    const started = Date.now();
    try {
      const openAIResult = await withVoiceTimeout('openai', transcribeWithOpenAI(audioBuffer, normalizedMime, opts?.translateTo === 'english'));
      if (openAIResult.text) {
        recordAttempt({ at: new Date().toISOString(), provider: 'openai', outcome: 'success', latencyMs: Date.now() - started, mimeType: normalizedMime, bytes: audioBuffer.length });
        return { ...openAIResult, provider: 'openai' };
      }
      returnedNoSpeech += 1;
      recordAttempt({ at: new Date().toISOString(), provider: 'openai', outcome: 'no_speech', latencyMs: Date.now() - started, mimeType: normalizedMime, bytes: audioBuffer.length });
    } catch (e: unknown) {
      failed += 1;
      recordAttempt({ at: new Date().toISOString(), provider: 'openai', outcome: 'failed', latencyMs: Date.now() - started, error: boundedError(e), mimeType: normalizedMime, bytes: audioBuffer.length });
      log.error('Voice transcription provider failed', {
        provider: 'openai', error: boundedError(e), bytes: audioBuffer.length, mimeType: normalizedMime,
      });
    }
  }

  if (process.env.GROQ_API_KEY) {
    attempted += 1;
    const started = Date.now();
    try {
      const groqResult = await withVoiceTimeout('groq', transcribeWithGroq(audioBuffer, normalizedMime, opts?.translateTo === 'english'));
      if (groqResult.text) {
        recordAttempt({ at: new Date().toISOString(), provider: 'groq', outcome: 'success', latencyMs: Date.now() - started, mimeType: normalizedMime, bytes: audioBuffer.length });
        return { ...groqResult, provider: 'groq' };
      }
      returnedNoSpeech += 1;
      recordAttempt({ at: new Date().toISOString(), provider: 'groq', outcome: 'no_speech', latencyMs: Date.now() - started, mimeType: normalizedMime, bytes: audioBuffer.length });
    } catch (e: unknown) {
      failed += 1;
      recordAttempt({ at: new Date().toISOString(), provider: 'groq', outcome: 'failed', latencyMs: Date.now() - started, error: boundedError(e), mimeType: normalizedMime, bytes: audioBuffer.length });
      log.error('Voice transcription provider failed', {
        provider: 'groq', error: boundedError(e), bytes: audioBuffer.length, mimeType: normalizedMime,
      });
    }
  }

  if (getVoiceProviderConfiguration().google.configured) {
    attempted += 1;
    const started = Date.now();
    try {
      const speech = await import('@google-cloud/speech');
      const client = new speech.SpeechClient();

      const audio = { content: audioBuffer.toString('base64') };

    // Auto-detect language: try Urdu first, fallback to English, or use multi-language
      const encoding = googleRecognitionEncoding(normalizedMime);
      const config = {
        ...(encoding ? { encoding: encoding as any } : {}),
        languageCode: 'ur-PK',
        alternativeLanguageCodes: ['en-US', 'en-PK', 'hi-IN'],
        enableAutomaticPunctuation: true,
        model: 'default',
      };

      const [response] = await withVoiceTimeout('google', client.recognize({ audio, config }));
      const results = response.results || [];

      if (results.length === 0) {
        log.info('No speech detected in voice note');
        returnedNoSpeech += 1;
        recordAttempt({ at: new Date().toISOString(), provider: 'google', outcome: 'no_speech', latencyMs: Date.now() - started, mimeType: normalizedMime, bytes: audioBuffer.length });
        return emptyTranscription('no_speech', 'google');
      }

      const best = results[0]?.alternatives?.[0];
      const text = best?.transcript || '';
      const confidence = best?.confidence || 0;
      const detectedLang = results[0]?.languageCode || 'ur-PK';

      log.info('Voice transcribed', { textLen: text.length, language: detectedLang, confidence });
      if (!text.trim()) {
        recordAttempt({ at: new Date().toISOString(), provider: 'google', outcome: 'no_speech', latencyMs: Date.now() - started, mimeType: normalizedMime, bytes: audioBuffer.length });
        return emptyTranscription('no_speech', 'google');
      }
      recordAttempt({ at: new Date().toISOString(), provider: 'google', outcome: 'success', latencyMs: Date.now() - started, mimeType: normalizedMime, bytes: audioBuffer.length });
      return { text, language: detectedLang, confidence, provider: 'google' };
    } catch (error: unknown) {
      failed += 1;
      recordAttempt({ at: new Date().toISOString(), provider: 'google', outcome: 'failed', latencyMs: Date.now() - started, error: boundedError(error), mimeType: normalizedMime, bytes: audioBuffer.length });
      log.error('Voice transcription provider failed', {
        provider: 'google', error: boundedError(error), bytes: audioBuffer.length, mimeType: normalizedMime,
      });
    }
  }

  const failureReason: VoiceTranscriptionFailure = attempted === 0
    ? 'provider_unavailable'
    : failed === attempted
      ? 'provider_failed'
      : returnedNoSpeech > 0
        ? 'no_speech'
        : 'provider_failed';
  log.warn('Voice transcription exhausted providers', {
    attempted, failed, returnedNoSpeech, failureReason, bytes: audioBuffer.length, mimeType: normalizedMime,
  });
  return emptyTranscription(failureReason);
}

/** Prefer the container signature over unreliable browser/WhatsApp labels. */
export function detectAudioMime(audio: Buffer, claimed?: string): string {
  if (audio.length >= 4 && audio.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (audio.length >= 4 && audio[0] === 0x1a && audio[1] === 0x45 && audio[2] === 0xdf && audio[3] === 0xa3) return 'audio/webm';
  if (audio.length >= 4 && audio.subarray(0, 4).toString('ascii') === 'RIFF') return 'audio/wav';
  if (audio.length >= 4 && audio.subarray(0, 4).toString('ascii') === 'fLaC') return 'audio/flac';
  if (audio.length >= 3 && audio.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (audio.length >= 12 && audio.subarray(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4';
  return geminiAudioMime(claimed);
}

export function googleRecognitionEncoding(mimeType?: string): string | undefined {
  const base = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  if (base === 'audio/ogg' || base === 'audio/opus') return 'OGG_OPUS';
  if (base === 'audio/webm') return 'WEBM_OPUS';
  if (base === 'audio/flac') return 'FLAC';
  if (base === 'audio/mpeg' || base === 'audio/mp3') return 'MP3';
  if (base === 'audio/wav' || base === 'audio/x-wav') return 'LINEAR16';
  // MP4/M4A/AAC containers are deliberately left for header auto-detection;
  // labelling them OGG_OPUS causes deterministic INVALID_ARGUMENT failures.
  return undefined;
}

function audioExtension(mimeType?: string): string {
  const base = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  const extensions: Record<string, string> = {
    'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/webm': 'webm',
    'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/aac': 'aac', 'audio/flac': 'flac',
  };
  return extensions[base] ?? 'ogg';
}

async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  mimeType?: string,
  translateToEnglish: boolean = false,
): Promise<{ text: string; language: string; confidence: number }> {
  const { default: OpenAI, toFile } = await import('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const normalizedMime = geminiAudioMime(mimeType);
  const file = await toFile(audioBuffer, `voice.${audioExtension(mimeType)}`, { type: normalizedMime });
  const model = process.env.VOICE_TRANSCRIPTION_OPENAI_MODEL || 'whisper-1';
  const response: any = translateToEnglish
    ? await client.audio.translations.create({ file, model, response_format: 'json' })
    : await client.audio.transcriptions.create({ file, model, response_format: 'verbose_json' });
  const text = String(response?.text ?? '').trim();
  if (looksLikeSilence(text)) return { text: '', language: 'unknown', confidence: 0 };
  return {
    text,
    language: translateToEnglish ? 'en-US' : String(response?.language ?? 'unknown'),
    confidence: 0.75,
  };
}

async function transcribeWithGroq(
  audioBuffer: Buffer,
  mimeType?: string,
  translateToEnglish: boolean = false,
): Promise<{ text: string; language: string; confidence: number }> {
  const groqModule: any = await import('groq-sdk');
  const Groq = groqModule.default || groqModule.Groq;
  const { toFile } = await import('openai');
  const client: any = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const file = await toFile(audioBuffer, `voice.${audioExtension(mimeType)}`, { type: geminiAudioMime(mimeType) });
  const configuredModel = process.env.VOICE_TRANSCRIPTION_GROQ_MODEL || 'whisper-large-v3-turbo';
  const response = translateToEnglish && client.audio.translations?.create
    ? await client.audio.translations.create({
      file, model: process.env.VOICE_TRANSLATION_GROQ_MODEL || 'whisper-large-v3',
      response_format: 'json',
    })
    : await client.audio.transcriptions.create({
      file, model: configuredModel, response_format: 'verbose_json',
    });
  const text = String(response?.text ?? '').trim();
  if (looksLikeSilence(text)) return { text: '', language: 'unknown', confidence: 0 };
  return {
    text,
    language: translateToEnglish ? 'en-US' : String(response?.language ?? 'unknown'),
    confidence: 0.75,
  };
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
      model: voiceGeminiModel(),
      contents: [
        {
          role: 'user',
          parts: [
            { text: `Transcribe this audio and output the result in ENGLISH ONLY, following these rules STRICTLY:

1. English speech → transcribe VERBATIM, word-for-word exactly as spoken. Do NOT summarize, shorten, clean up, rephrase, or "improve" anything. Keep every word, repetitions and filler words included. The output must be the complete literal sentence(s) the speaker said.
2. Urdu / Hindi / any other language → translate faithfully, sentence by sentence, COMPLETE — every sentence the speaker said must appear in the output; nothing omitted, nothing condensed. Preserve meaning and tone; keep numbers and proper names exactly as spoken.
3. Mixed speech → keep the English parts verbatim as rule 1; translate only the non-English parts as rule 2.

NEVER produce a summary, a paraphrase, or a shortened version. Length of output should correspond to length of speech. Return ONLY the English transcript — no commentary, no source-language original, no brackets, no labels. If the audio has no clear speech, return an empty response.` },
            { inlineData: { mimeType: geminiAudioMime(mimeType), data: audioBuffer.toString('base64') } },
          ],
        },
      ],
      config: { maxOutputTokens: 2000 }, // was 500 — a >2.5min voice note silently truncated mid-transcript
    });
    const raw = (result.text ?? '').trim();
    if (looksLikeSilence(raw)) {
      log.info('Gemini English-translate transcript looks like silence; returning empty', { textLen: raw.length });
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
    model: voiceGeminiModel(),
    contents: [
      {
        role: 'user',
        parts: [
          { text: `Transcribe this audio. Return ONLY the spoken words VERBATIM, word-for-word exactly as spoken \u2014 no commentary, no labels, no quotes, no brackets. Do NOT summarize, shorten, clean up, or rephrase; keep every word including repetitions and fillers. Output length must correspond to speech length.

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
    config: { maxOutputTokens: 2000 }, // was 500 — a >2.5min voice note silently truncated mid-transcript
  });

  let raw = (result.text ?? '').trim();
  if (looksLikeSilence(raw)) {
    log.info('Gemini transcript looks like silence/boilerplate; returning empty', { textLen: raw.length });
    return { text: '', language: 'unknown', confidence: 0 };
  }
  // Safety net: if Gemini ignored the rule and emitted Devanagari anyway,
  // retry once with a stronger forbid clause. After one retry, if it
  // still emits Hindi script, accept the Latin-script fallback by
  // asking for transliteration explicitly (last resort).
  const hasDevanagari = /[\u0900-\u097F]/.test(raw);
  if (hasDevanagari) {
    log.warn('Gemini emitted Devanagari despite Urdu-only instruction; retrying', { textLen: raw.length });
    try {
      const retry = await ai.models.generateContent({
        model: voiceGeminiModel(),
        contents: [
          {
            role: 'user',
            parts: [
              { text: `Transcribe this audio. The speaker is from Pakistan and speaks URDU. Output the transcript in URDU SCRIPT (Arabic script, U+0600 to U+06FF) \u2014 for example \u0633\u0631 \u0627\u062F\u06BE\u0631 \u0633\u06D2 \u06C1\u0645. You are FORBIDDEN from using Devanagari / Hindi script (U+0900 to U+097F). If you cannot transcribe in Urdu script, transliterate to Roman Urdu (Latin letters, e.g. "Sir idhar se hum") \u2014 but NEVER Hindi script. Return ONLY the transcript, no commentary.` },
              { inlineData: { mimeType: geminiAudioMime(mimeType), data: audioBuffer.toString('base64') } },
            ],
          },
        ],
        config: { maxOutputTokens: 2000 }, // was 500 — a >2.5min voice note silently truncated mid-transcript
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
    model: voiceGeminiModel(),
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

      const [response] = await withVoiceTimeout('google_tts', client.synthesizeSpeech({
        input: { text },
        voice: voiceConfig,
        audioConfig: { audioEncoding: 'OGG_OPUS' as any, speakingRate: 1.0, pitch: 0 },
      }));

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
