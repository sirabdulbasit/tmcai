// ═════════════════════════════════════════════════════════════════════════════
// instantEvaluation — D4 (2026-07-09): ingestion-triggered proactive pass.
//
// Proactivity was batch-on-cron: an inbound email/WhatsApp sat until the
// next daily risk-radar tick before Brain reacted. Ingestion now schedules
// an IMMEDIATE evaluation, debounced per user so message bursts cost one
// radar run per window, not one per message.
//
// Deliberately NO ingest-side "high-signal" keyword filter — significance
// is judged by the radar's own rules + LLM (no-hardcoded-judgement rule).
// Quiet hours, dedup, and autonomy gating are enforced downstream by the
// D3 outreach path (prompt queue + executor), so triggering the radar
// often is safe; it only ever surfaces what crosses its own thresholds,
// and the docId dedup means a same-day re-run never double-pings.
// ═════════════════════════════════════════════════════════════════════════════

import createLogger from '../../utils/logger';

const log = createLogger('instant-evaluation');

export const DEBOUNCE_MS = 30 * 60 * 1000; // one radar run per user per 30 min

// In-memory per-process debounce. A multi-process deploy would run the
// radar once per process per window — acceptable: runForUser upserts a
// deterministic per-day docId, so extra runs converge on the same doc.
const lastRunAt = new Map<string, number>();

export function resetDebounce(): void {
  lastRunAt.clear();
}

export async function maybeTriggerInstantEvaluation(
  clientNumber: string,
  userId: number,
  opts: {
    /** Injectable for tests; defaults to riskRadarService.runForUser. */
    run?: (clientNumber: string, userId: number) => Promise<unknown>;
    now?: number;
  } = {},
): Promise<{ triggered: boolean }> {
  const key = `${clientNumber}:${userId}`;
  const now = opts.now ?? Date.now();
  const last = lastRunAt.get(key);
  if (last !== undefined && now - last < DEBOUNCE_MS) {
    return { triggered: false };
  }
  lastRunAt.set(key, now);
  try {
    const run = opts.run
      ?? (async (cn: string, uid: number) => {
        const { runForUser } = await import('../brain/riskRadarService');
        return runForUser(cn, uid);
      });
    await run(clientNumber, userId);
    log.info('instant evaluation ran', { clientNumber, userId });
    return { triggered: true };
  } catch (err: any) {
    // Release the debounce slot so the next ingest can retry rather than
    // waiting out a window that never actually evaluated.
    lastRunAt.delete(key);
    log.warn('instant evaluation failed', { clientNumber, userId, err: err?.message });
    return { triggered: false };
  }
}
