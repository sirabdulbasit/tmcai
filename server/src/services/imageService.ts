/**
 * DEF-110 — Brain can read an image.
 *
 * The owner asked four times across two days:
 *   08-08 16:27  "can you read the image if I send you any kind of image here?"
 *                -> "Honest answer, Sir: no. I can only process text and voice
 *                    notes right now, not images or other files."
 *   08-08 16:27  "So improve your capability so you can also read image if I send"
 *   08-10 16:26  "can you read the image?"
 *   08-10 16:38  "can i send image now for you read?"
 *
 * The honest refusal was correct and is now obsolete. Everything needed already
 * existed: WhatsApp media download is the path voice notes arrive on,
 * gemini-2.5-flash is configured and already receives media as inlineData with
 * a mime type, and the inbound handler's messageType union already had 'image'
 * in it.
 *
 * Deliberately mirrors voiceService rather than inventing a second media
 * pattern: same provider order (Gemini, then OpenAI where configured), same
 * bounded-error logging, same "return empty and let the caller say so" contract.
 * A second, differently-shaped media pipeline would be the
 * protection-with-two-implementations shape that has produced most of this
 * week's defects.
 *
 * What it returns is a DESCRIPTION, and the caller feeds it into the same text
 * path a transcript uses. That matters for the no-fabrication rule: Brain reads
 * the description as observed input, exactly as it reads "🎙️ Heard: …", rather
 * than claiming to have seen something it inferred.
 */
import createLogger from '../utils/logger';

const log = createLogger('image');

const imageGeminiModel = () => process.env.IMAGE_VISION_GEMINI_MODEL || 'gemini-2.5-flash';

export type ImageReadFailure = 'no_provider' | 'invalid_media' | 'unreadable' | 'provider_failed';

export interface ImageReadResult {
  text: string;
  provider: 'gemini' | 'openai' | 'none';
  failureReason?: ImageReadFailure;
}

/** WhatsApp sends jpeg/png/webp; anything exotic is passed through and the
 *  provider decides. Stripping parameters matters — Gemini rejects
 *  "image/jpeg; codecs=..." style values the way it rejects audio mismatches. */
function normaliseImageMime(mime?: string): string {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  return base.startsWith('image/') ? base : 'image/jpeg';
}

function boundedError(e: unknown): string {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return s.slice(0, 300);
}

/**
 * The instruction is the load-bearing part.
 *
 * It asks for a factual description and explicitly forbids speculation, because
 * the output is fed to Brain as if observed. An image model that guesses at
 * intent ("this looks like an urgent invoice") would inject inference into a
 * block the no-fabrication rule treats as ground truth — the same class of
 * error as a transcript that summarises instead of transcribing.
 *
 * Text is called out separately because most of what he sends is screenshots:
 * a WhatsApp thread, an invoice, an error message. Transcribing the text
 * verbatim is usually the entire value.
 */
const VISION_PROMPT = `Describe this image factually and completely, for someone who cannot see it.

Rules:
1. If the image contains TEXT (a screenshot, document, invoice, error message, chat thread), transcribe that text VERBATIM and in full. Preserve names, numbers, dates and amounts exactly. This is usually the most important content.
2. Describe what is visibly present — people, objects, layout, charts — in plain language.
3. Do NOT speculate about intent, urgency, mood, or what the sender wants. Do NOT summarise a document's meaning; report what it says.
4. If something is unreadable or cut off, say so explicitly rather than guessing.
5. Return only the description. No preamble, no commentary.`;

async function readWithGemini(buffer: Buffer, mimeType: string): Promise<string> {
  const { getGenAI } = await import('./genaiClient');
  const ai = getGenAI();
  const result = await ai.models.generateContent({
    model: imageGeminiModel(),
    contents: [{
      role: 'user',
      parts: [
        { text: VISION_PROMPT },
        { inlineData: { mimeType, data: buffer.toString('base64') } },
      ],
    }],
    // Screenshots of long threads are the common case and truncating one mid
    // transcript would reproduce DEF-093's failure in a new place.
    config: { maxOutputTokens: 2000 },
  });
  return (result.text ?? '').trim();
}

async function readWithOpenAI(buffer: Buffer, mimeType: string): Promise<string> {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: process.env.IMAGE_VISION_OPENAI_MODEL || 'gpt-4o-mini',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: VISION_PROMPT },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } },
      ] as any,
    }],
  });
  return (res.choices?.[0]?.message?.content ?? '').trim();
}

/**
 * Read an inbound image. Returns empty text with a failureReason rather than
 * throwing — the caller decides what to tell the user, and a thrown error here
 * would take down the whole inbound turn.
 */
export async function describeInboundImage(
  buffer: Buffer,
  mimeType?: string,
): Promise<ImageReadResult> {
  const mime = normaliseImageMime(mimeType);
  const geminiConfigured = process.env.USE_VERTEX_AI === 'true' || Boolean(process.env.GEMINI_API_KEY);

  if (geminiConfigured) {
    const started = Date.now();
    try {
      const text = await readWithGemini(buffer, mime);
      if (text) {
        log.info('Image read', { provider: 'gemini', textLen: text.length, bytes: buffer.length, mimeType: mime, latencyMs: Date.now() - started });
        return { text, provider: 'gemini' };
      }
      log.warn('Image read returned empty', { provider: 'gemini', bytes: buffer.length, mimeType: mime });
    } catch (e) {
      log.error('Image provider failed', { provider: 'gemini', error: boundedError(e), bytes: buffer.length, mimeType: mime });
    }
  }

  if (process.env.OPENAI_API_KEY) {
    const started = Date.now();
    try {
      const text = await readWithOpenAI(buffer, mime);
      if (text) {
        log.info('Image read', { provider: 'openai', textLen: text.length, bytes: buffer.length, mimeType: mime, latencyMs: Date.now() - started });
        return { text, provider: 'openai' };
      }
    } catch (e) {
      log.error('Image provider failed', { provider: 'openai', error: boundedError(e), bytes: buffer.length, mimeType: mime });
    }
  }

  const failureReason: ImageReadFailure = geminiConfigured || process.env.OPENAI_API_KEY
    ? 'unreadable'
    : 'no_provider';
  return { text: '', provider: 'none', failureReason };
}

/**
 * What the user is told when an image could not be read.
 *
 * A bracketed system marker, not Brain prose — the owner's standing rule is
 * that every Brain-surface reply is LLM-generated or a bracketed marker, and
 * `answerSanitizer` already renders markers of this shape.
 */
export function imageReadFailureMarker(reason?: ImageReadFailure): string {
  switch (reason) {
    case 'no_provider':  return '[no image reader configured — I could not look at that image]';
    case 'invalid_media': return '[I could not download that image]';
    default:              return '[I could not read that image — send it again, or describe it in text]';
  }
}
