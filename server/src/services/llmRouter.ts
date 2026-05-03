/**
 * Unified LLM call with automatic fallback.
 *
 * Default order: Gemini → Gemini Flash → Claude. Gemini is the primary
 * because it's the provider we have billing set up for. Claude is a
 * fallback that only kicks in if Gemini is down AND Anthropic credits are
 * available. No Anthropic credit means no effect on the system — the
 * router never calls Claude unless Gemini has failed.
 *
 *     const answer = await callLLM(systemPrompt, userMessage, { maxTokens: 512 });
 */
import { callClaude } from './claudeService';
import { callGemini } from './geminiService';
import { recordLlmSpend } from './llmSpendService';

export type LlmProvider = 'claude' | 'gemini' | 'gemini-flash';

export interface CallLlmResult {
  text: string;
  provider: LlmProvider;
}

export interface CallLlmOpts {
  maxTokens?: number;
  /** Preferred order. Default: ['gemini', 'gemini-flash', 'claude']. */
  providers?: LlmProvider[];
  /** Hard timeout per provider attempt (ms). Default 15000. */
  timeoutMs?: number;
  /** Which user / tenant this call is on behalf of — used for spend
   *  tracking. Leave undefined for system-level calls. */
  userId?: number;
  clientNumber?: string;
  /** Free-text label for analytics ('triage', 'chat', 'scribe', etc.) */
  purpose?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const BACKOFF_MS = 1_000;

/** 429 detection — Gemini/Anthropic errors vary, so we match broadly. */
function isRateLimited(err: any): boolean {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate') || msg.includes('quota') || msg.includes('too many requests');
}

/** Abortable wrapper — resolves either with text or throws 'timeout'. */
async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callProvider(
  provider: LlmProvider,
  systemPrompt: string,
  userMessage: string,
  maxTokens?: number,
): Promise<string> {
  switch (provider) {
    case 'claude':
      return await callClaude(systemPrompt, userMessage, { maxTokens });
    case 'gemini':
      return await callGemini(systemPrompt, userMessage, { maxTokens });
    case 'gemini-flash':
      return await callGemini(systemPrompt, userMessage, { maxTokens, flash: true });
  }
}

/** Rough token estimator when the provider doesn't return usage —
 *  ~4 chars/token is the industry heuristic for English prompts. */
function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

export async function callLLM(
  systemPrompt: string,
  userMessage: string,
  opts?: CallLlmOpts,
): Promise<CallLlmResult> {
  const order = opts?.providers ?? ['gemini', 'gemini-flash', 'claude'];
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const errors: string[] = [];
  const inputTokens = estimateTokens(systemPrompt) + estimateTokens(userMessage);

  for (const provider of order) {
    // Up to 2 attempts per provider — retry ONCE on 429 with backoff.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await withTimeout(
          () => callProvider(provider, systemPrompt, userMessage, opts?.maxTokens),
          timeoutMs,
        );
        if (text && text.trim().length > 0) {
          const outputTokens = estimateTokens(text);
          // Fire-and-forget spend record
          void recordLlmSpend({
            provider, userId: opts?.userId, clientNumber: opts?.clientNumber,
            purpose: opts?.purpose ?? 'unknown',
            inputTokens, outputTokens,
          }).catch(() => {});
          return { text, provider };
        }
        errors.push(`${provider}[try${attempt + 1}]: empty response`);
        break; // empty response, move to next provider
      } catch (err: any) {
        const rateLimited = isRateLimited(err);
        if (rateLimited && attempt === 0) {
          // Back off once, retry same provider
          errors.push(`${provider}[try${attempt + 1}]: rate-limited, backing off ${BACKOFF_MS}ms`);
          await new Promise((r) => setTimeout(r, BACKOFF_MS));
          continue;
        }
        errors.push(`${provider}[try${attempt + 1}]: ${err.message}`);
        break;
      }
    }
  }
  throw new Error(`All LLM providers failed: ${errors.join(' | ')}`);
}
