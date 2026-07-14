import createLogger from '../../utils/logger';
import { addMessage } from '../../services/chatHistoryService';
import { logQuery } from '../../services/auditService';
import { trackUsage } from '../../services/tokenUsageService';
import { logSlowResponse } from '../../services/systemLogService';
import { updateMemoryFromMessage } from '../../services/memoryService';
import { learnFromMessage } from '../../services/learningService';

const log = createLogger('chat:post');

/**
 * Post-response processing: save history, audit log, token tracking, memory extraction.
 * All operations are non-blocking (fire-and-forget).
 */
export function postProcess(params: {
  userId: number | undefined;
  clientNumber: string | undefined;
  conversationId: number | undefined;
  message: string;
  provider: string;
  responseChunks: string[];
  systemPrompt: string;
  startTime: number;
  totalChars: number;
  piiMapping: Record<string, string>;
  topScore: number;
  intentType: string;
}): void {
  const {
    userId, clientNumber, conversationId, message, provider,
    responseChunks, systemPrompt, startTime, totalChars,
    piiMapping, topScore, intentType,
  } = params;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const estimatedTokens = Math.ceil(totalChars / 4);
  const contextTokens = Math.ceil((systemPrompt.length + message.length) / 4);
  const matchedCount = systemPrompt.split('## ').length - 1;

  // Save history
  if (userId && conversationId) {
    addMessage({
      clientNumber: clientNumber!,
      conversationId,
      role: 'assistant',
      content: responseChunks.join(''),
      provider,
      inputTokens: contextTokens,
      outputTokens: estimatedTokens,
      responseTimeMs: Math.round(parseFloat(elapsed) * 1000),
    }).catch(() => {});
  }

  // Audit log
  logQuery({
    clientNumber,
    userId,
    query: message,
    provider,
    chunksRetrieved: matchedCount,
    topScore,
    piiEntitiesCount: Object.keys(piiMapping).length,
    inputTokens: contextTokens,
    outputTokens: estimatedTokens,
    responseTimeMs: Math.round(parseFloat(elapsed) * 1000),
    intentType,
  }).catch(() => {});

  // Track token consumption
  if (userId && clientNumber) {
    trackUsage(clientNumber, userId, provider, contextTokens, estimatedTokens, message, intentType, Math.round(parseFloat(elapsed) * 1000)).catch(() => {});
  }

  // Log slow responses
  if (parseFloat(elapsed) > 20) {
    logSlowResponse(message, parseFloat(elapsed), provider, userId).catch(() => {});
  }

  // Background: extract memories + learn patterns
  if (userId && clientNumber) {
    updateMemoryFromMessage(userId, clientNumber, message).catch(() => {});
    learnFromMessage(clientNumber, userId, message, intentType).catch(() => {});
    // In-chat learning (2026-07-14): same capture as the WhatsApp path
    // — passing remarks with durability markers become PROPOSED
    // governed memories (pending user approval). Channel parity.
    import('../../services/learning/standingPreferenceCapture')
      .then(({ captureStandingPreference }) => captureStandingPreference({
        clientNumber, userId, userMessage: message,
      }))
      .catch(() => {});
  }
}

/**
 * Compute meta object for the SSE response.
 */
export function computeMeta(params: {
  startTime: number;
  totalChars: number;
  systemPrompt: string;
  message: string;
  conversationId: number | undefined;
  pipelineMs: number;
}): Record<string, any> {
  const { startTime, totalChars, systemPrompt, message, conversationId, pipelineMs } = params;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const estimatedTokens = Math.ceil(totalChars / 4);
  const contextTokens = Math.ceil((systemPrompt.length + message.length) / 4);

  return {
    type: 'meta',
    elapsed,
    outputTokens: estimatedTokens,
    inputTokens: contextTokens,
    totalTokens: estimatedTokens + contextTokens,
    dataLastUpdated: undefined, // caller fills in
    conversationId: conversationId || undefined,
    pipelineMs,
  };
}
