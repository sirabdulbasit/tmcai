/**
 * LlmProvider — minimal interface every LLM backend (Gemini, Anthropic, OpenAI)
 * implements. The orchestrator only sees this interface; switching providers
 * is a config change in ai_settings, not a code change.
 *
 * Phase A only uses `chat()` (with optional streaming) and `ping()`. Embeddings
 * and tool-use specifics will expand the interface in later phases.
 */

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Optional: for assistant messages that emit tool calls */
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
  /** Optional: for role='tool' messages — the result of a tool call */
  toolCallId?: string;
  toolName?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for params */
  parameters: Record<string, unknown>;
}

export interface ChatOptions {
  systemPrompt: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Streaming output. If undefined, caller wants a single buffered response. */
  onTokens?: (chunk: string) => void;
  /** Max tokens for response. */
  maxOutputTokens?: number;
  /** 0-1. Higher = more creative; lower = more deterministic. */
  temperature?: number;
  /** Abort controller for client-side cancellation */
  signal?: AbortSignal;
  /** Per-call model override (e.g. a fast Flash model for extraction). Falls
   *  back to the provider's configured model when omitted. */
  model?: string;
  /** Tenant identity (client number) for per-tenant LLM fairness/rate-limiting.
   *  When set, this call is also bounded by the per-tenant concurrency cap so
   *  one client can't monopolise the shared provider quota. */
  tenantKey?: string | number;
  /**
   * How many tokens the model may spend thinking before it answers.
   *
   * OMIT for the provider's own default. On a reasoning model that default is
   * DYNAMIC — the model chooses, without an upper bound, and the caller pays
   * the latency. Measured on gemini-2.5-pro against the real assistant prompt,
   * the word "Hi" drew anywhere from 16 to 2,159 thinking tokens, i.e. 2s to
   * 26s, for the same three characters.
   *
   * A number is a HINT, not a ceiling: the model overshoots it when the
   * question genuinely needs the room. That is the property the caller relies
   * on — a low budget buys a fast common case without capping a hard one.
   */
  thinkingBudget?: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /**
     * Tokens the model spent THINKING before it answered. Google bills these as
     * output, but reports them in a separate counter, so a reader of
     * `outputTokens` alone sees a fraction of what was actually charged — the
     * turn that prompted this field recorded 39 output tokens against 1,235
     * thinking tokens. Undefined on a provider that does not report them.
     */
    thinkingTokens?: number;
  };
  /** Provider-reported model name (could differ from requested, e.g. fallback) */
  modelUsed: string;
  /** 'stop' | 'tool_use' | 'max_tokens' | 'safety' | 'error' */
  finishReason: string;
}

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

/**
 * Provider-agnostic LLM interface. Each tenant's provider is resolved at
 * runtime from ai_settings. Cache instances per tenant to avoid re-auth on
 * every request.
 */
export interface LlmProvider {
  readonly providerKey: 'google' | 'anthropic' | 'openai';
  readonly model: string;

  /** Run a chat completion. */
  chat(opts: ChatOptions): Promise<ChatResponse>;

  /** Lightweight liveness check — used by the Test Connection button. */
  ping(): Promise<PingResult>;

  /**
   * Transcribe a voice note to text. `base64Audio` is the raw audio bytes
   * (no data: prefix); `mimeType` is the recording's type (e.g. audio/webm,
   * audio/mp4, audio/ogg). Returns the verbatim transcript, preserving the
   * spoken language(s) — Urdu, English, or code-switched. Optional: a provider
   * that can't do speech-to-text simply omits it (the controller 501s).
   */
  transcribeAudio?(base64Audio: string, mimeType: string): Promise<string>;

  /**
   * Describe an image in words so it can take the same text path as a typed
   * message. `base64Image` is the raw image bytes (no data: prefix); `mimeType`
   * is the image's type (e.g. image/jpeg, image/png, image/webp). Returns a
   * plain-language description that preserves any text/numbers visible in the
   * image verbatim — used, for instance, when someone WhatsApps a screenshot.
   * Optional: a provider without vision simply omits it (the caller degrades to
   * treating the image as un-read media).
   */
  describeImage?(base64Image: string, mimeType: string): Promise<string>;
}
