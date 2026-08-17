/**
 * DEF-085 — the writer half of raw-query attribution (Self-Healing rung 1).
 *
 * Deliberately a separate module from `db/rawQueryObservability`, which is
 * imported by `db/prisma.ts` and therefore sits in the import closure of every
 * operator script — including the ones `operatorScriptParity.test.ts` declares
 * WRITE-FREE. Putting `recordFinding` (which reaches
 * a typed finding-row update) into that closure would let a read-only
 * script such as `smokeTenantIsolation` write a findings row. The parity guard
 * caught that and was right to.
 *
 * So the dependency points the other way: the observer stays pure and logs, and
 * the long-running server injects this writer at boot. A one-shot script gets
 * the call site in its output and writes nothing.
 */
import { recordFinding, SYSTEM_SCOPE } from './healthFindingService';
import { currentTenant } from '../../db/tenantContext';
import {
  setRawQueryFindingReporter,
  RAW_QUERY_FAILED_KIND,
  type RawFailureReport,
} from '../../db/rawQueryObservability';

export async function reportRawQueryFailureAsFinding(report: RawFailureReport): Promise<void> {
  const scope = currentTenant();
  await recordFinding({
    clientNumber: scope?.clientNumber ?? SYSTEM_SCOPE,
    kind: RAW_QUERY_FAILED_KIND,
    severity: 'error',
    source: 'raw-query',
    /**
     * Carried because `notifySevereFindings` SKIPS any finding with a null
     * userId (findingNotifier.ts:53) — a finding belongs to whoever it happened
     * to, and there is no global "the owner" (owner instruction, 2026-08-07).
     *
     * Consequence, stated rather than papered over: a raw failure inside a
     * user-scoped request reaches him on WhatsApp, while one in a tenant-less
     * background timer is recorded and visible on the health surface but raises
     * no alert. DEF-085's own failure is a background timer, so it will land as
     * a finding rather than a message. Filling this field with a guessed owner
     * would be a fabricated attribution, which is worse than a quiet row.
     */
    userId: scope?.userId ?? undefined,
    // Signature as the subject, so `recordFinding`'s partial unique index
    // collapses repeats of THIS query while a different broken query still
    // gets its own row.
    subjectType: 'raw_query_signature',
    subjectId: report.signature,
    summary: `raw query failing repeatedly (${report.sqlState ?? 'no sqlstate'}) at ${report.callSite}`,
    evidence: {
      sqlState: report.sqlState,
      callSite: report.callSite,
      sqlShape: report.shape,
      occurrencesInWindow: report.count,
      note: 'SQL shape only — literals stripped, parameter values never recorded',
    },
  });
}

/** Wire the observer to the findings table. Called once, from server boot. */
export function installRawQueryFindingReporter(): void {
  setRawQueryFindingReporter(reportRawQueryFailureAsFinding);
}
