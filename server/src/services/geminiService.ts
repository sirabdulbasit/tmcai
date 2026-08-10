import { getGenAI, getConfiguredGenAI } from './genaiClient';

/**
 * The model ids the SAVED provider config asks for, falling back to the
 * compiled-in constants when nothing is configured.
 *
 * Read per call rather than captured at import: the settings panel must take
 * effect on the next turn, not the next deploy.
 */
async function activeModels(): Promise<{ pro: string; flash: string }> {
  try {
    const { getAiProviderConfig } = await import('./aiProviderConfig');
    const cfg = await getAiProviderConfig();
    return { pro: cfg.model || MODEL_GEMINI, flash: cfg.flashModel || MODEL_GEMINI_FLASH };
  } catch {
    return { pro: MODEL_GEMINI, flash: MODEL_GEMINI_FLASH };
  }
}
import { env } from '../config/env';
import { MODEL_GEMINI, MODEL_GEMINI_FLASH } from '../config/models';

// Conversation history type for multi-turn support
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export async function streamGemini(
  systemPrompt: string,
  userMessage: string,
  onChunk: (text: string) => void,
  useFlash: boolean = false,
  maxOutputTokens?: number,
  disableThinking: boolean = false,
  conversationHistory?: ChatTurn[]
): Promise<void> {
  if (!env.geminiApiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const modelId = useFlash ? (await activeModels()).flash : (await activeModels()).pro;
  const ai = await getConfiguredGenAI();

  // Build multi-turn contents array
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory) {
      contents.push({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: turn.content }],
      });
    }
  }
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  const stream = await ai.models.generateContentStream({
    model: modelId,
    contents,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: maxOutputTokens || (useFlash ? 4096 : 6144),
      ...(disableThinking ? {
        thinkingConfig: {
          thinkingBudget: (maxOutputTokens || 0) > 4096 ? 0 : 512,
        },
      } : {}),
    },
  });

  for await (const chunk of stream) {
    const text = chunk.text;
    if (text) onChunk(text);
  }
}

/** Non-streaming variant — returns the full completion as one string. */
// Input-context caps per model (leave ~20% safety margin).
// Gemini 2.5 Pro:   ~2M token window, safe to 1.6M
// Gemini 2.5 Flash: ~1M token window, safe to 800K
const MODEL_INPUT_SAFE_LIMIT = {
  pro: 1_600_000,
  flash: 800_000,
} as const;

/**
 * Count tokens for a planned Gemini request. Uses the model's own tokenizer
 * (not estimation). Returns total tokens for system+user; callers can
 * reject / trim before spending on a generate call that would truncate
 * context silently.
 */
export async function countGeminiTokens(
  systemPrompt: string,
  userMessage: string,
  flash = false,
): Promise<number> {
  if (!env.geminiApiKey) return Math.ceil((systemPrompt.length + userMessage.length) / 4);
  try {
    const ai = await getConfiguredGenAI();
    const modelId = flash ? (await activeModels()).flash : (await activeModels()).pro;
    const r = await ai.models.countTokens({
      model: modelId,
      contents: [
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'user', parts: [{ text: userMessage }] },
      ],
    });
    return r.totalTokens ?? Math.ceil((systemPrompt.length + userMessage.length) / 4);
  } catch {
    return Math.ceil((systemPrompt.length + userMessage.length) / 4);
  }
}

export async function callGemini(
  systemPrompt: string,
  userMessage: string,
  opts?: { maxTokens?: number; flash?: boolean; responseMimeType?: string },
): Promise<string> {
  if (!env.geminiApiKey) throw new Error('GEMINI_API_KEY not configured');
  const modelId = opts?.flash ? (await activeModels()).flash : (await activeModels()).pro;
  const ai = await getConfiguredGenAI();

  // Guard against silent-truncation. countTokens is a network roundtrip
  // (~200-500ms), so only spend it when the prompt could plausibly blow
  // the window. ~4 chars/token → 1.6M tokens ≈ 6.4M chars; anything under
  // 300K chars (~75K tokens) has a huge margin and we skip the check.
  const promptChars = systemPrompt.length + userMessage.length;
  if (promptChars > 300_000) {
    try {
      const totalIn = await countGeminiTokens(systemPrompt, userMessage, !!opts?.flash);
      const cap = opts?.flash ? MODEL_INPUT_SAFE_LIMIT.flash : MODEL_INPUT_SAFE_LIMIT.pro;
      if (totalIn > cap) {
        // Keep the FIRST portion of the system prompt (persona + user
        // identity live there), trim the tail (less-relevant retrieval
        // blocks come last). Proportional trim based on overage.
        const ratio = cap / totalIn;
        const keepChars = Math.floor(systemPrompt.length * ratio * 0.9); // 10% safety
        systemPrompt = systemPrompt.slice(0, keepChars) + '\n\n[Note: lower-priority context trimmed to fit model input window.]';
      }
    } catch { /* countTokens failure — proceed, Gemini will handle */ }
  }

  // Gemini 2.5 counts its internal "thinking" tokens against
  // maxOutputTokens. With a small budget (< 2048) the model burns most
  // of it thinking and emits a truncated response. Two protections:
  //   1. Floor the budget to 2048 so there's always room for real output.
  //   2. Pick a thinkingBudget that the model actually accepts.
  //
  // 2026-05-20: gemini-2.5-pro (the Pro tier) rejects thinkingBudget: 0
  // with `"Budget 0 is invalid. This model only works in thinking
  // mode."` — observed on Basit's WhatsApp Brain turn at 18:04. Flash
  // still accepts 0. So: Flash → 0 (fast chat), Pro → 128 (minimum
  // non-zero so the call doesn't 400, but small enough that thinking
  // tokens don't eat the output budget).
  const requested = opts?.maxTokens ?? 1024;
  const effectiveMax = Math.max(2048, requested);
  const thinkingBudget = opts?.flash ? 0 : 128;
  const resp = await ai.models.generateContent({
    model: modelId,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: effectiveMax,
      thinkingConfig: { thinkingBudget } as any,
      ...(opts?.responseMimeType ? { responseMimeType: opts.responseMimeType } : {}),
    } as any,
  });
  // Prod fix 2026-07-10: maxOutputTokens truncation can end the
  // response in a lone surrogate (half an emoji). callGemini is called
  // directly (not only via llmRouter's callLLM) by reasoningCompose,
  // transcription, and turn classifiers — sanitize at this exit too so
  // every DB write downstream receives valid UTF-8 (PG 22021 class).
  const { sanitizeUtf8 } = await import('../utils/utf8');
  return sanitizeUtf8((resp.text ?? '').trim());
}
