/**
 * repairService — allowlisted self-healing framework (hardening audit
 * 2026-07-14, item #5).
 *
 * Before this, auto-repair was a single hardcoded rule inside
 * systemLogService (context-limit bump). This framework generalises the
 * pattern under strict rules:
 *
 *   - REPAIRS ARE CODE, in the REPAIR_RULES allowlist below. No LLM
 *     ever generates or executes repair logic. Nothing here edits
 *     source, runs migrations, deploys, or rotates credentials.
 *   - Every rule: precondition check (detect) → bounded apply →
 *     post-verify → audit row (before/after in self_heal_log). A repair
 *     whose verify fails is recorded 'verify_failed' — NEVER "healed".
 *   - Attempt cap per day + cooldown between attempts, per rule (and
 *     per tenant for tenant-scoped rules). Exhaustion escalates to
 *     system_logs (level=error, category self_heal) for a human — with
 *     a recommendation, not further mutation.
 *   - Tenant-scoped rules only ever touch rows of the tenant being
 *     passed; global rules touch infra tables only.
 *
 * The existing menders this wraps (all idempotent):
 *   stale_connector_error_metadata → connectorHealthService.sweepStaleErrorMetadata
 *   stuck_scribe_markers           → scribeRecovery.recoverStuckScribes
 *   feed_dlq_replay                → resets bounded batch of feed_events
 *                                    status 'dlq'→'new' for feedPublishRetry
 *
 * The legacy context-limit auto-fix in systemLogService keeps running
 * unchanged (it already has its own caps); new repairs land here.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('self-heal');

export interface RepairContext {
  clientNumber?: string;
}

export interface RepairPrecondition {
  /** Human-readable summary of what detect() found. */
  summary: string;
  /** Machine snapshot for the audit row ("before"). */
  before: Record<string, unknown>;
}

export interface RepairRule {
  id: string;
  description: string;
  /** true → apply() must be tenant-scoped and runs once per tenant. */
  tenantScoped: boolean;
  maxAttemptsPerDay: number;
  cooldownMin: number;
  /** Look, don't touch. null = nothing to repair (the normal case). */
  detect(ctx: RepairContext): Promise<RepairPrecondition | null>;
  /** The bounded, reversible mutation. Returns the "after" snapshot. */
  apply(ctx: RepairContext, pre: RepairPrecondition): Promise<Record<string, unknown>>;
  /** Re-check the system of record. false = repair did NOT stick. */
  verify(ctx: RepairContext, pre: RepairPrecondition): Promise<boolean>;
}

export type RepairOutcome = 'healed' | 'verify_failed' | 'apply_failed' | 'skipped_cooldown' | 'skipped_exhausted' | 'nothing_to_repair';

// ── Audit / attempt bookkeeping (unmanaged raw table, same pattern as
//    system_logs and job_runs) ────────────────────────────────────────

let tableEnsured = false;
async function ensureLogTable(): Promise<void> {
  if (tableEnsured) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS self_heal_log (
      id BIGSERIAL PRIMARY KEY,
      rule_id TEXT NOT NULL,
      client_number TEXT,
      outcome TEXT NOT NULL,
      summary TEXT,
      before_state JSONB,
      after_state JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS self_heal_log_rule_time_idx ON self_heal_log (rule_id, created_at DESC)`,
  );
  tableEnsured = true;
}

async function recordAttempt(
  rule: RepairRule, ctx: RepairContext, outcome: RepairOutcome,
  pre?: RepairPrecondition | null, after?: Record<string, unknown>,
): Promise<void> {
  try {
    await ensureLogTable();
    await prisma.$executeRawUnsafe(
      `INSERT INTO self_heal_log (rule_id, client_number, outcome, summary, before_state, after_state)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      rule.id, ctx.clientNumber ?? null, outcome,
      pre?.summary ?? null,
      pre ? JSON.stringify(pre.before) : null,
      after ? JSON.stringify(after) : null,
    );
  } catch (e: any) {
    log.warn('self-heal audit write failed', { rule: rule.id, error: e?.message });
  }
}

async function attemptsInLast24h(rule: RepairRule, ctx: RepairContext): Promise<{ count: number; lastAt: Date | null }> {
  try {
    await ensureLogTable();
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number; last_at: Date | null }>>(
      `SELECT COUNT(*)::int AS n, MAX(created_at) AS last_at FROM self_heal_log
        WHERE rule_id = $1
          AND ($2::text IS NULL OR client_number = $2)
          AND outcome IN ('healed','verify_failed','apply_failed')
          AND created_at >= NOW() - INTERVAL '24 hours'`,
      rule.id, ctx.clientNumber ?? null,
    );
    return { count: rows[0]?.n ?? 0, lastAt: rows[0]?.last_at ?? null };
  } catch {
    // Bookkeeping unavailable → fail CLOSED: report the cap as reached
    // so we never mutate without being able to count attempts.
    return { count: Number.MAX_SAFE_INTEGER, lastAt: null };
  }
}

// ── Rule execution ──────────────────────────────────────────────────

export async function runRepairRule(rule: RepairRule, ctx: RepairContext): Promise<RepairOutcome> {
  let pre: RepairPrecondition | null;
  try {
    pre = await rule.detect(ctx);
  } catch (e: any) {
    log.warn('detect failed — treating as nothing to repair', { rule: rule.id, error: e?.message });
    return 'nothing_to_repair';
  }
  if (!pre) return 'nothing_to_repair';

  const { count, lastAt } = await attemptsInLast24h(rule, ctx);
  if (count >= rule.maxAttemptsPerDay) {
    // Exhausted: escalate to a human, recommend, stop mutating.
    await recordAttempt(rule, ctx, 'skipped_exhausted', pre);
    try {
      const { log: sysLog } = await import('../systemLogService');
      await sysLog({
        level: 'error', category: 'self_heal', source: `repair:${rule.id}`,
        message: `self-heal exhausted (${count}/${rule.maxAttemptsPerDay} in 24h) for "${rule.id}"${ctx.clientNumber ? ` tenant ${ctx.clientNumber}` : ''}: ${pre.summary}. Human action required — see runbook docs/brain_hardening_audit_2026-07-14.md.`,
      } as any);
    } catch { /* visible via self_heal_log regardless */ }
    return 'skipped_exhausted';
  }
  if (lastAt && Date.now() - new Date(lastAt).getTime() < rule.cooldownMin * 60_000) {
    return 'skipped_cooldown';
  }

  let after: Record<string, unknown>;
  try {
    after = await rule.apply(ctx, pre);
  } catch (e: any) {
    await recordAttempt(rule, ctx, 'apply_failed', pre, { error: e?.message });
    log.warn('repair apply failed', { rule: rule.id, error: e?.message });
    return 'apply_failed';
  }

  let verified = false;
  try {
    verified = await rule.verify(ctx, pre);
  } catch { verified = false; }

  await recordAttempt(rule, ctx, verified ? 'healed' : 'verify_failed', pre, after);
  if (verified) {
    log.info('self-heal succeeded', { rule: rule.id, clientNumber: ctx.clientNumber, summary: pre.summary });
  } else {
    log.warn('repair applied but verification FAILED — not claiming healed', { rule: rule.id, clientNumber: ctx.clientNumber });
  }
  return verified ? 'healed' : 'verify_failed';
}

// ── The allowlist ───────────────────────────────────────────────────

const staleConnectorMetadata: RepairRule = {
  id: 'stale_connector_error_metadata',
  description: "Clear stale lastRefreshError/staleSince metadata from connectors whose status is back to 'connected' (recovery already confirmed by connectorSyncTracker).",
  tenantScoped: false,
  maxAttemptsPerDay: 24,
  cooldownMin: 30,
  async detect() {
    const rows = await prisma.userConnector.findMany({
      where: { status: 'connected' } as any,
      select: { id: true, metadata: true },
    });
    const dirty = rows.filter((r: any) => {
      const m = r.metadata ?? {};
      return Boolean(m.lastRefreshError || m.staleSince || m.lastError);
    });
    if (dirty.length === 0) return null;
    return {
      summary: `${dirty.length} connected connector(s) carrying stale error metadata`,
      before: { dirtyConnectorIds: dirty.map((d: any) => d.id) },
    };
  },
  async apply() {
    const { sweepStaleErrorMetadata } = await import('../connectorHealthService');
    const r = await sweepStaleErrorMetadata();
    return { scanned: r.scanned, cleaned: r.cleaned };
  },
  async verify(_ctx, pre) {
    const ids = (pre.before.dirtyConnectorIds as string[]) ?? [];
    const rows = await prisma.userConnector.findMany({
      where: { id: { in: ids as any } } as any,
      select: { metadata: true, status: true },
    });
    return rows.every((r: any) => {
      if (r.status !== 'connected') return true; // legitimately re-degraded — not our claim to make
      const m = r.metadata ?? {};
      return !m.lastRefreshError && !m.staleSince && !m.lastError;
    });
  },
};

const stuckScribeMarkers: RepairRule = {
  id: 'stuck_scribe_markers',
  description: "Reset user_connector scribeStatus='running' markers older than 30 min (crashed mid-scribe) so the UI unblocks re-scribing.",
  tenantScoped: false,
  maxAttemptsPerDay: 12,
  cooldownMin: 60,
  async detect() {
    const rows = await prisma.userConnector.findMany({
      select: { id: true, metadata: true },
    });
    const stuck = rows.filter((r: any) => {
      const m = r.metadata ?? {};
      if (m.scribeStatus !== 'running') return false;
      const startedAt = m.scribeStartedAt ? Date.parse(m.scribeStartedAt) : 0;
      return Date.now() - startedAt >= 30 * 60 * 1000;
    });
    if (stuck.length === 0) return null;
    return {
      summary: `${stuck.length} scribe marker(s) stuck in 'running' for >30 min`,
      before: { stuckConnectorIds: stuck.map((s: any) => s.id) },
    };
  },
  async apply() {
    const { recoverStuckScribes } = await import('../knowledge/scribeRecovery');
    await recoverStuckScribes();
    return { ran: 'recoverStuckScribes' };
  },
  async verify(_ctx, pre) {
    const ids = (pre.before.stuckConnectorIds as string[]) ?? [];
    const rows = await prisma.userConnector.findMany({
      where: { id: { in: ids as any } } as any,
      select: { metadata: true },
    });
    return rows.every((r: any) => (r.metadata as any)?.scribeStatus !== 'running');
  },
};

const feedDlqReplay: RepairRule = {
  id: 'feed_dlq_replay',
  description: "Requeue a bounded batch (25) of feed_events rows from status='dlq' back to 'new' so feedPublishRetry re-attempts them — only rows parked >1h (transient causes have passed).",
  tenantScoped: true,
  maxAttemptsPerDay: 4,
  cooldownMin: 120,
  async detect(ctx) {
    if (!ctx.clientNumber) return null;
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM feed_events
        WHERE client_number = $1 AND status = 'dlq'
          AND created_at < NOW() - INTERVAL '1 hour'`,
      ctx.clientNumber,
    );
    const n = rows[0]?.n ?? 0;
    if (n === 0) return null;
    return { summary: `${n} feed event(s) parked in DLQ >1h`, before: { dlqCount: n } };
  },
  async apply(ctx) {
    const updated = await prisma.$executeRawUnsafe(
      `UPDATE feed_events SET status = 'new'
        WHERE id IN (
          SELECT id FROM feed_events
           WHERE client_number = $1 AND status = 'dlq'
             AND created_at < NOW() - INTERVAL '1 hour'
           ORDER BY created_at ASC
           LIMIT 25
        )`,
      ctx.clientNumber,
    );
    return { requeued: updated };
  },
  async verify(ctx, pre) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM feed_events
        WHERE client_number = $1 AND status = 'dlq'
          AND created_at < NOW() - INTERVAL '1 hour'`,
      ctx.clientNumber,
    );
    // Success = the batch left the DLQ (retry worker takes it from here;
    // rows that fail again re-park and count against the next attempt).
    return (rows[0]?.n ?? 0) < ((pre.before.dlqCount as number) ?? 0);
  },
};

export const REPAIR_RULES: readonly RepairRule[] = [
  staleConnectorMetadata,
  stuckScribeMarkers,
  feedDlqReplay,
];

/** One pass over all rules: global rules once, tenant-scoped rules per
 *  active tenant. Registered hourly in server.ts (leader-locked). */
export async function runSelfHealPass(): Promise<Record<string, RepairOutcome[]>> {
  const results: Record<string, RepairOutcome[]> = {};
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true } as any,
    select: { clientNumber: true },
  }).catch(() => [] as Array<{ clientNumber: string }>);

  for (const rule of REPAIR_RULES) {
    results[rule.id] = [];
    if (rule.tenantScoped) {
      for (const t of tenants) {
        results[rule.id].push(await runRepairRule(rule, { clientNumber: t.clientNumber }));
      }
    } else {
      results[rule.id].push(await runRepairRule(rule, {}));
    }
  }
  return results;
}

/** Recent audit trail for the admin health endpoint. */
export async function getRecentRepairs(limit = 50): Promise<any[]> {
  try {
    await ensureLogTable();
    return await prisma.$queryRawUnsafe<any[]>(
      `SELECT rule_id, client_number, outcome, summary, created_at
         FROM self_heal_log ORDER BY created_at DESC LIMIT $1`,
      Math.min(Math.max(limit, 1), 200),
    );
  } catch { return []; }
}
