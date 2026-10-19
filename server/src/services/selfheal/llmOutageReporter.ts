/**
 * DEF-334 (3) — the writer half of the LLM-outage alarm.
 *
 * Twice measured while this did not exist: the 2026-09-29→10-09 billing
 * outage ran every criticality/triage decision on deterministic fallbacks for
 * DAYS (~2,500 failures/hour) and the owner learned it from a 51 MB error log,
 * not from Brain; the 10-16 compound outage (gemini DNS + claude
 * credit-balance 400s) drove 50 more silent fallbacks. A capability that dies
 * without telling anyone is the `fabricated-status` class wearing ops
 * clothes — the receipt must exist the moment the degradation starts.
 *
 * Deliberately a separate module from `llmRouter`, exactly like
 * `rawQueryFindingReporter` (DEF-085) and for the same reason: the router is
 * in the import closure of ~every script, including the ones
 * `operatorScriptParity.test.ts` declares WRITE-FREE. The router therefore
 * stays pure (count + bounded log) and the long-running server injects this
 * writer at boot. A one-shot script gets the bounded log line and writes
 * nothing.
 *
 * Two legs per active tenant, mirroring DEF-329's alarm (whose direct-email
 * leg is the one delivery LIVE-VERIFIED to reach the owner, 10-07):
 *   1. a durable `llm_provider_down` health finding — tenant-scoped, so it is
 *      the owner's finding, not a SYSTEM-scope row nobody owns; repeats
 *      collapse on (clientNumber, kind, subjectId) while open;
 *   2. a direct SA/AD ops email through the shared helper, independent of the
 *      user-facing opt-in gate. Facts only, fixed wording — the governance
 *      ruling allows a fixed string ONLY when the model is unreachable, and
 *      this alarm's trigger IS every model being unreachable.
 *
 * There is deliberately NO model-phrased leg: when this fires, no provider
 * can phrase anything. A retrospective, model-phrased "I was dark from X to
 * Y" on recovery is named as a future increment, not built here.
 *
 * DEF-340 (Codex it-79(6) directive #2): the recovery half. The alert opens a
 * CRITICAL finding; without a resolve path the owner is left staring at a
 * stale "all providers down" after they recover — a `fabricated-status`-shaped
 * claim at the END of the death the alarm fixed at the START. The router's
 * recovery latch now fires `reportLlmRecoveryAsResolution`, which resolves the
 * open finding per tenant, carrying the dark-window duration.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { recordFinding, resolveOpenFindings } from './healthFindingService';
import {
  setLlmOutageReporter, setLlmRecoveryReporter,
  type LlmOutageReport, type LlmRecoveryReport,
} from '../llmRouter';

const log = createLogger('llm-outage');

export const LLM_PROVIDER_DOWN_KIND = 'llm_provider_down';

export async function reportLlmOutageAsAlert(report: LlmOutageReport): Promise<void> {
  const tenants = await prisma.$queryRawUnsafe<Array<{ client_number: string }>>(
    `SELECT client_number FROM tenants WHERE is_active = true`,
  ).catch((e: any) => {
    log.warn('llm-outage alert could not list tenants', { error: String(e?.message ?? e).slice(0, 200) });
    return [] as Array<{ client_number: string }>;
  });

  const firstFailureAt = new Date(report.firstFailureAt).toISOString();

  for (const t of tenants) {
    // Leg 1 — the durable receipt. Every decision made while this finding is
    // open ran on a deterministic fallback, and now the database says so.
    await recordFinding({
      clientNumber: t.client_number,
      kind: LLM_PROVIDER_DOWN_KIND,
      severity: 'critical',
      source: 'llm-router',
      subjectType: 'llm_outage',
      subjectId: LLM_PROVIDER_DOWN_KIND,
      summary: `every LLM provider is failing — Brain is running on deterministic fallbacks (${report.consecutiveFailures} consecutive full failures since ${firstFailureAt})`,
      evidence: {
        consecutiveFailures: report.consecutiveFailures,
        firstFailureAt,
        providerErrors: report.errors,
        purpose: report.purpose,
      },
    }).catch((e: any) => {
      log.warn('llm-outage finding write failed', {
        clientNumber: t.client_number, error: String(e?.message ?? e).slice(0, 200),
      });
    });

    // Leg 2 — the direct ops email. Independent of the opt-in gate that
    // silenced DEF-329's first alarm for 23.5 hours.
    try {
      const { sendAdminOpsEmail, escapeOpsHtml } = await import('../notifications/adminOpsAlert');
      const subject = `[Nexeo] All AI providers failing — decisions running on fallbacks (${t.client_number})`;
      const html = `
        <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px;">
          <p><strong>Every LLM provider is failing.</strong> Message prioritisation, triage and
          reasoning are running on deterministic fallbacks until a provider recovers.</p>
          <p>Consecutive full failures: <strong>${report.consecutiveFailures}</strong><br/>
          Failing since: <strong>${escapeOpsHtml(firstFailureAt)}</strong></p>
          <p>Provider errors, verbatim:</p>
          <pre style="background:#f6f6f6; padding:8px; white-space:pre-wrap;">${escapeOpsHtml(report.errors.join('\n'))}</pre>
          <p>This alarm repeats at most once per 24h while the outage lasts. Recovery
          resolves this finding automatically and is logged by the router
          ("llm providers recovered").</p>
        </div>`;
      const { total, results } = await sendAdminOpsEmail({ clientNumber: t.client_number, subject, html });
      log.info('llm-outage ops email dispatched', {
        clientNumber: t.client_number, total,
        failed: results.filter((r) => !r.ok).length,
      });
    } catch (e: any) {
      log.warn('llm-outage ops email failed', {
        clientNumber: t.client_number, error: String(e?.message ?? e).slice(0, 200),
      });
    }
  }
}

/**
 * DEF-340 — the recovery half: resolve what the alert opened. Per active
 * tenant, every OPEN `llm_provider_down` finding is marked healed with the
 * dark-window duration on the record. 0 resolved is fine (an outage shorter
 * than the announce threshold opened nothing); a failed write stays logged
 * and the finding stays honest-by-omission (open) rather than silently lost.
 */
export async function reportLlmRecoveryAsResolution(report: LlmRecoveryReport): Promise<void> {
  const tenants = await prisma.$queryRawUnsafe<Array<{ client_number: string }>>(
    `SELECT client_number FROM tenants WHERE is_active = true`,
  ).catch((e: any) => {
    log.warn('llm-recovery could not list tenants', { error: String(e?.message ?? e).slice(0, 200) });
    return [] as Array<{ client_number: string }>;
  });

  const darkForSec = Math.round(report.darkForMs / 1000);
  for (const t of tenants) {
    const resolved = await resolveOpenFindings({
      clientNumber: t.client_number,
      kind: LLM_PROVIDER_DOWN_KIND,
      subjectId: LLM_PROVIDER_DOWN_KIND,
      action: `recovered after ${darkForSec}s dark`,
    });
    log.info('llm-outage finding resolved on recovery', {
      clientNumber: t.client_number,
      resolved, // null = the resolve WRITE failed and was logged, finding left open
      darkForMs: report.darkForMs,
      afterConsecutiveFailures: report.afterConsecutiveFailures,
    });
  }
}

/** Wire the router's latch to the alert legs. Called once, from server boot. */
export function installLlmOutageReporter(): void {
  setLlmOutageReporter(reportLlmOutageAsAlert);
  setLlmRecoveryReporter(reportLlmRecoveryAsResolution);
}
