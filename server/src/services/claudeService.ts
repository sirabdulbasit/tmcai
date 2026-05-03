import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { MODEL_CLAUDE } from '../config/models';

export async function streamClaude(
  systemPrompt: string,
  userMessage: string,
  onChunk: (text: string) => void
): Promise<void> {
  if (!env.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const client = new Anthropic({ apiKey: env.anthropicApiKey });

  const stream = client.messages.stream({
    model: MODEL_CLAUDE,
    max_tokens: env.maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      onChunk(event.delta.text);
    }
  }
}

/** Non-streaming variant — returns the full completion as one string.
 *  Used by Knowledge Center /brain/ask summarize intent where a single
 *  grounded answer is appropriate. maxTokens defaults low to control cost.
 */
export async function callClaude(
  systemPrompt: string,
  userMessage: string,
  opts?: { maxTokens?: number; model?: string },
): Promise<string> {
  if (!env.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  const msg = await client.messages.create({
    model: opts?.model ?? MODEL_CLAUDE,
    max_tokens: opts?.maxTokens ?? 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return text;
}
