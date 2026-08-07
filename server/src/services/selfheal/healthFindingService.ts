/**
 * Layer 1 of self-healing: record a real failure somewhere it can be QUERIED.
 *
 * The problem this solves, stated exactly: every defect on 2026-08-06/07
 * reached us because the owner reported it. Seven health jobs were running and
 * not one raised anything, because they watch components while the failures
 * were in the loop between them. For Hamna's lost reply the WhatsApp session
 * was healthy, ingest was healthy, correlation worked, the thread consumed it —
 * every component green, and the owner was never told.
 *
 * The two pieces of evidence that mattered that day —
 * `inbound consume failed, reason: illegal_transition` and a reply that
 * produced no row — existed only in pm2 logs. Unqueryable, rotated, gone. So
 * each break had to be found by hand, one at a time, over roughly ten rounds.
 *
 * A `log.warn` tells a human who happens to be reading. A finding row tells the
 * self-heal pass, the perturbation generator, and the notify stage. That is the
 * whole difference, and it is why this is the prerequisite for everything else.
 *
 * ── HOW TO USE IT ────────────────────────────────────────────────────────────
 * Alongside the existing log line, never instead of it — logs stay useful for
 * humans reading live:
 *
 *   log.warn({ ... }, 'inbound consume failed');
 *   void recordFinding({
 *     clientNumber, kind: 'reply_consume_failed', severity: 'error',
 *     source: 'delegation-capture', subjectType: 'delegation_thread',
 *     subjectId: threadId, summary: `reply could not be consumed: ${reason}`,
 *     evidence: { reason, threadState, candidateStates },
 *   });
 *
 * `void` is deliberate. Recording a finding must never change the outcome of
 * the turn it describes — a monitor that can break the thing it monitors is
 * worse than no monitor. Every failure inside here is swallowed after being
 * logged.
 */

import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('health-finding');

export type FindingSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface RecordFindingInput {
  clientNumber: string;
  /**
   * Stable class key — snake_case, e.g. 'reply_consume_failed',
   * 'ask_never_notified', 'raw_query_failed', 'llm_judgement_fallback'.
   *
   * This is the load-bearing field. Grouping on it answers "has this class
   * come back?", which is the difference between *progressing* (new root
   * cause) and *circling* (the earlier fix failed to close the class, so the
   * next change must be structural, never another patch on the reported
   * instance). Invent a new kind only for a genuinely new class.
   */
  kind: string;
  severity?: FindingSeverity;
  /** The service that noticed, e.g. 'delegation-capture', 'brain-outbound'. */
  source: string;
  /**
   * The ask this failure belongs to. The absence of exactly this join is what
   * made "she answered and he never heard about it" a question the database
   * could not answer.
   */
  subjectType?: string;
  subjectId?: string;
  userId?: number;
  summary: string;
  /** State at the time — whatever a diagnosing agent will wish it had. */
  evidence?: Record<string, unknown>;
}

/**
 * Upsert a finding, collapsing repeats.
 *
 * A raw query failing every 90 seconds for 24 hours (DEF-085) is ONE finding
 * seen ~960 times, not 960 findings. Collapsing on
 * (clientNumber, kind, subjectId) while `status='open'` is what keeps this
 * table small enough that someone — or something — will actually act on it.
 * The partial unique index enforces that; this function keeps the counter and
 * `lastSeenAt` moving so the age and the rate stay visible.
 *
 * Returns the finding id, or null if recording failed. Callers should ignore
 * the return value unless they specifically need the id.
 */
export async function recordFinding(input: RecordFindingInput): Promise<string | null> {
  try {
    const severity = input.severity ?? 'warn';
    const subjectId = input.subjectId ?? null;

    // Raw upsert: the dedup target is a PARTIAL unique index
    // (WHERE status = 'open') over COALESCE(subject_id, ''), which Prisma's
    // typed `upsert` cannot express. A healed finding that recurs therefore
    // opens a NEW row rather than reviving the old one — deliberate, because
    // "this came back after we fixed it" is the single most important signal
    // this table carries, and merging it into the old row would erase it.
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO brain_health_findings
        (id, client_number, kind, severity, source, subject_type, subject_id,
         user_id, summary, evidence, status, first_seen_at, last_seen_at,
         occurrences, created_at, updated_at)
      VALUES
        (gen_random_uuid()::text, ${input.clientNumber}, ${input.kind}, ${severity},
         ${input.source}, ${input.subjectType ?? null}, ${subjectId},
         ${input.userId ?? null}, ${input.summary},
         ${input.evidence ? JSON.stringify(input.evidence) : null}::jsonb,
         'open', now(), now(), 1, now(), now())
      ON CONFLICT (client_number, kind, COALESCE(subject_id, ''))
        WHERE status = 'open'
      DO UPDATE SET
        occurrences  = brain_health_findings.occurrences + 1,
        last_seen_at = now(),
        updated_at   = now(),
        -- A class that escalates matters; one that calms down does not un-matter.
        severity     = CASE
                         WHEN ${severity} = 'critical' THEN 'critical'
                         WHEN brain_health_findings.severity = 'critical' THEN 'critical'
                         WHEN ${severity} = 'error' OR brain_health_findings.severity = 'error' THEN 'error'
                         ELSE brain_health_findings.severity
                       END,
        -- Keep the freshest evidence: the latest occurrence is the one still
        -- reproducible, and stale evidence sends a diagnosis down a dead end.
        evidence     = COALESCE(${input.evidence ? JSON.stringify(input.evidence) : null}::jsonb,
                                brain_health_findings.evidence),
        summary      = ${input.summary}
      RETURNING id
    `;
    return rows[0]?.id ?? null;
  } catch (err) {
    // Swallowed on purpose, after being logged. A monitor that can break the
    // turn it is monitoring is worse than no monitor at all.
    log.warn('could not record health finding', {
      err: err instanceof Error ? err.message : String(err),
      kind: input.kind,
      source: input.source,
    });
    return null;
  }
}

/** Mark a finding healed by a repair rule. `action` names which rule did it. */
export async function markHealed(id: string, action: string): Promise<void> {
  try {
    await prisma.brainHealthFinding.update({
      where: { id },
      data: { status: 'healed', healedAt: new Date(), healAction: action },
    });
  } catch (err) {
    log.warn('could not mark finding healed', { err: err instanceof Error ? err.message : String(err), id });
  }
}

/** Count a heal attempt so a rule that cannot fix something stops retrying. */
export async function noteHealAttempt(id: string): Promise<number> {
  try {
    const r = await prisma.brainHealthFinding.update({
      where: { id },
      data: { healAttempts: { increment: 1 }, updatedAt: new Date() },
      select: { healAttempts: true },
    });
    return r.healAttempts;
  } catch {
    return 0;
  }
}

/**
 * What is wrong right now, worst first. The self-heal pass's primary read, and
 * the basis of the notify summary.
 */
export async function openFindings(clientNumber: string, limit = 50) {
  return prisma.brainHealthFinding.findMany({
    where: { clientNumber, status: 'open' },
    orderBy: [{ severity: 'desc' }, { lastSeenAt: 'desc' }],
    take: limit,
  });
}

/**
 * Open findings the owner has never been told about.
 *
 * Same discipline as `delegation_threads.owner_notified_at`: `notifiedAt` is
 * stamped only after a CONFIRMED send, never at enqueue, because conflating
 * written with delivered is the entire DEF-081 class.
 */
export async function unnotifiedFindings(clientNumber: string, limit = 20) {
  return prisma.brainHealthFinding.findMany({
    where: { clientNumber, status: 'open', notifiedAt: null },
    orderBy: [{ severity: 'desc' }, { firstSeenAt: 'asc' }],
    take: limit,
  });
}

/** Stamp findings as told — only ever called after a confirmed send. */
export async function markNotified(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    await prisma.brainHealthFinding.updateMany({
      where: { id: { in: ids } },
      data: { notifiedAt: new Date() },
    });
  } catch (err) {
    log.warn('could not stamp findings as notified', { err: err instanceof Error ? err.message : String(err) });
  }
}
