// ═════════════════════════════════════════════════════════════════════════════
// brainRetry — retry wrapper for the ONE central brain (answerAsBrain).
//
// Per Directive 1 (one central brain, many transports): when the brain call
// fails transiently, we retry the SAME brain — we never fall back to a
// degraded parallel pipeline. The brain degrades in latency, not competence.
// On total failure the user gets a bracketed system marker (a status message,
// not code pretending to be Brain).
// ═════════════════════════════════════════════════════════════════════════════

import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:brain-retry');

export interface BrainAskResult { answer: string; [k: string]: any }

export async function askBrainWithRetry<T extends BrainAskResult>(
  ask: () => Promise<T>,
  opts: { retryDelayMs?: number } = {},
): Promise<{ answer: string; degraded: boolean; result?: T }> {
  const retryDelayMs = opts.retryDelayMs ?? 1500;
  try {
    const result = await ask();
    return { answer: result.answer, degraded: false, result };
  } catch (err1: any) {
    log.warn('answerAsBrain failed — retrying the same brain (no degraded fallback)', { error: err1?.message });
    if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    try {
      const result = await ask();
      log.info('answerAsBrain retry succeeded');
      return { answer: result.answer, degraded: false, result };
    } catch (err2: any) {
      // Metric hook: fallback frequency must stay visible (spec A2.3)
      log.error('answerAsBrain failed twice — returning bracketed system marker', { error: err2?.message });
      return {
        answer: `[Brain unavailable — ${err2?.message ?? 'unknown error'}. Try again in a moment or use the web.]`,
        degraded: true,
      };
    }
  }
}
