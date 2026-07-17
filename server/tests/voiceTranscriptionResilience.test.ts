import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  googleRecognitionEncoding,
  transcribeVoiceNote,
  voiceTranscriptionFailureMarker,
} from '../src/services/voiceService';

describe('voice transcription resilience', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['audio/ogg; codecs=opus', 'OGG_OPUS'],
    ['audio/opus', 'OGG_OPUS'],
    ['audio/webm;codecs=opus', 'WEBM_OPUS'],
    ['audio/mpeg', 'MP3'],
    ['audio/flac', 'FLAC'],
    ['audio/wav', 'LINEAR16'],
  ])('maps %s to the correct Google encoding', (mime, encoding) => {
    expect(googleRecognitionEncoding(mime)).toBe(encoding);
  });

  it.each(['audio/mp4', 'audio/m4a', 'audio/aac', undefined])(
    'does not falsely label %s as OGG_OPUS',
    (mime) => expect(googleRecognitionEncoding(mime)).toBeUndefined(),
  );

  it('rejects empty media before contacting a provider', async () => {
    const result = await transcribeVoiceNote(Buffer.alloc(0), 'audio/ogg');
    expect(result).toMatchObject({
      text: '', provider: 'none', failureReason: 'invalid_media',
    });
  });

  it('reports unavailable when no speech provider is configured', async () => {
    vi.stubEnv('USE_VERTEX_AI', 'false');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');
    const result = await transcribeVoiceNote(Buffer.alloc(32, 1), 'audio/ogg');
    expect(result).toMatchObject({
      text: '', provider: 'none', failureReason: 'provider_unavailable',
    });
  });

  it('gives a specific retry instruction when speech is unclear', () => {
    expect(voiceTranscriptionFailureMarker('no_speech')).toContain('slightly longer voice note');
  });

  it('does not expose provider internals in a service outage marker', () => {
    const marker = voiceTranscriptionFailureMarker('provider_failed');
    expect(marker).toContain('temporarily unavailable');
    expect(marker).not.toMatch(/Gemini|Google|OpenAI|API/i);
  });
});
