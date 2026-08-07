/**
 * repairService — allowlisted self-healing framework (hardening audit
 * 2026-07-14 #5; reworked same day for staging-readiness item #12).
 *
 * Rules (unchanged in spirit, tightened in mechanics):
 *   - REPAIRS ARE CODE, in the REPAIR_RULES allowlist. No LLM ever
 *     generates repair logic. Nothing edits source, runs migrations,
 *     deploys, or rotates credentials.
 *   - AUDIT-FIRST: the attempt row is INSERTED (pessimistically as
 *     'apply_failed') BEFORE any mutation and updated to the real
 *     outcome after verification. If that insert fails, the outcome is
 *     'audit_unavailable' and NOTHING is mutated — no ledger, no
 *     repair. A crash mid-apply leaves an honest 'apply_failed' row.
 *   - SCOPE-CORRECT BUDGETS: every rule declares 'global' | 'tenant';
 *     attempts and cooldowns are counted at that scope (tenant A can
 *     never consume tenant B's budget; global rules count only
 *     global rows).
 *   - detect() throwing is 'detect_failed' (visible), never silently
 *     'nothing to repair'.
 *   - VERIFY EXACT ROWS: verification re-reads the specific ids the
 *     rule touched. verify-fail is never reported healed.
 *   - Exhaustion escalates to a human ONCE per 24h window per
 *     rule+scope (deduped in the ledger itself).
 *   - Schema comes from migration 20260714_ops_hardening — no runtime
 *     DDL. Missing table = audit_unavailable = no mutation.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('self-heal');

export type RepairScope = 'global' | 'tenant';

export interface RepairContext {
  clientNumber?: string;
}

export interface RepairPrecondition {
  summary: string;
  before: Record<string, unknown>;
}

export interface RepairRule {
  id: string;
  description: string;
  scope: RepairScope;
  maxAttemptsPerDay: number;
  cooldownMin: number;
  detect(ctx: RepairContext): Promise<RepairPrecondition | null>;
  apply(ctx: RepairContext, pre: RepairPrecondition): Promise<Record<string, unknown>>;
  verify(ctx: RepairContext, pre: RepairPrecondition, after: Record<string, unknown>): Promise<boolean>;
}

export type RepairOutcome =
  | 'healed' | 'verify_failed' | 'apply_failed'
  | 'skipped_cooldown' | 'skipped_exhausted'
  | 'nothing_to_repair' | 'detect_failed' | 'audit_unavailable';

// ── Ledger access (migrated schema only — no DDL) ───────────────────

function scopeWhere(rule: RepairRule, ctx: RepairContext): { sql: string; params: unknown[] } {
  // Budgets count at the rule's declared scope: global rules count ONLY
  // global rows; tenant rules count ONLY that tenant's rows.
  return rule.scope === 'tenant'
    ? { sql: 'client_number = $2', params: [ctx.clientNumber ?? null] }
    : { sql: 'client_number IS NULL', params: [] };
}

async function attemptsInLast24h(rule: RepairRule, ctx: RepairContext): Promise<{ count: number; lastAt: Date | null; exhaustedNotified: boolean } | null> {
  try {
    const w = scopeWhere(rule, ctx);
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number; last_at: Date | null; notified: number }>>(
      `SELECT
         COUNT(*) FILTER (WHERE outcome IN ('healed','verify_failed','apply_failed'))::int AS n,
         MAX(created_at) FILTER (WHERE outcome IN ('healed','verify_failed','apply_failed')) AS last_at,
         COUNT(*) FILTER (WHERE outcome = 'skipped_exhausted')::int AS notified
       FROM self_heal_log
       WHERE rule_id = $1 AND ${w.sql}
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      rule.id, ...w.params,
    );
    const r = rows[0];
    return { count: r?.n ?? 0, lastAt: r?.last_at ?? null, exhaustedNotified: (r?.notified ?? 0) > 0 };
  } catch (e: any) {
    log.error('self-heal ledger unavailable — repairs disabled until schema is restored', { rule: rule.id, error: e?.message });
    return null; // fail CLOSED
  }
}

async function insertAttempt(rule: RepairRule, ctx: RepairContext, outcome: RepairOutcome, pre?: RepairPrecondition | null): Promise<bigint | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: bigint }>>(
      `INSERT INTO self_heal_log (rule_id, scope, client_number, outcome, summary, before_state)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
      rule.id, rule.scope, rule.scope === 'tenant' ? (ctx.clientNumber ?? null) : null,
      outcome, pre?.summary ?? null, pre ? JSON.stringify(pre.before) : null,
    );
    return rows[0]?.id ?? null;
  } catch (e: any) {
    log.error('self-heal audit insert failed', { rule: rule.id, error: e?.message });
    return null;
  }
}

async function finalizeAttempt(id: bigint, outcome: RepairOutcome, after?: Record<string, unknown>): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE self_heal_log SET outcome = $2, after_state = $3::jsonb WHERE id = $1`,
    id, outcome, after ? JSON.stringify(after) : null,
  ).catch((e: any) => log.error('self-heal audit finalize failed', { id: String(id), error: e?.message }));
}

// ── Rule execution ──────────────────────────────────────────────────

export async function runRepairRule(rule: RepairRule, ctx: RepairContext): Promise<RepairOutcome> {
  if (rule.scope === 'tenant' && !ctx.clientNumber) return 'nothing_to_repair';

  let pre: RepairPrecondition | null;
  try {
    pre = await rule.detect(ctx);
  } catch (e: any) {
    // Visible failure — a broken detector is an incident, not "healthy".
    log.error('self-heal detect failed', { rule: rule.id, clientNumber: ctx.clientNumber, error: e?.message });
    await insertAttempt(rule, ctx, 'detect_failed', { summary: `detect threw: ${String(e?.message).slice(0, 200)}`, before: {} });
    return 'detect_failed';
  }
  if (!pre) return 'nothing_to_repair';

  const budget = await attemptsInLast24h(rule, ctx);
  if (budget === null) return 'audit_unavailable'; // ledger down → NO mutation

  if (budget.count >= rule.maxAttemptsPerDay) {
    if (!budget.exhaustedNotified) {
      // Escalate ONCE per rolling 24h window (the skipped_exhausted row
      // itself is the dedup marker).
      await insertAttempt(rule, ctx, 'skipped_exhausted', pre);
      try {
        const { log: sysLog } = await import('../systemLogService');
        await sysLog({
          level: 'error', category: 'self_heal', source: `repair:${rule.id}`,
          message: `self-heal exhausted (${budget.count}/${rule.maxAttemptsPerDay} in 24h) for "${rule.id}"${ctx.clientNumber ? ` tenant ${ctx.clientNumber}` : ''}: ${pre.summary}. Human action required — see runbook docs/brain_hardening_audit_2026-07-14.md.`,
        } as any);
      } catch { /* ledger row remains the signal */ }
    }
    return 'skipped_exhausted';
  }
  if (budget.lastAt && Date.now() - new Date(budget.lastAt).getTime() < rule.cooldownMin * 60_000) {
    return 'skipped_cooldown';
  }

  // AUDIT-FIRST: pessimistic row before any mutation. Insert failure =
  // no audit = no repair.
  const attemptId = await insertAttempt(rule, ctx, 'apply_failed', pre);
  if (attemptId === null) return 'audit_unavailable';

  let after: Record<string, unknown>;
  try {
    after = await rule.apply(ctx, pre);
  } catch (e: any) {
    await finalizeAttempt(attemptId, 'apply_failed', { error: String(e?.message).slice(0, 300) });
    log.warn('repair apply failed', { rule: rule.id, error: e?.message });
    return 'apply_failed';
  }

  let verified = false;
  try {
    verified = await rule.verify(ctx, pre, after);
  } catch { verified = false; }

  await finalizeAttempt(attemptId, verified ? 'healed' : 'verify_failed', after);
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
  scope: 'global',
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
  scope: 'global',
  maxAttemptsPerDay: 12,
  cooldownMin: 60,
  async detect() {
    const rows = await prisma.userConnector.findMany({ select: { id: true, metadata: true } });
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
  description: "Atomically claim a bounded batch (25) of feed_events rows parked in status='dlq' >1h and requeue them to 'new' for feedPublishRetry. FOR UPDATE SKIP LOCKED — concurrent workers can never claim the same rows.",
  scope: 'tenant',
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
    // Atomic claim: SKIP LOCKED means a concurrent replica selecting at
    // the same moment gets DIFFERENT rows (or none). The exact claimed
    // ids are returned for id-exact verification.
    const claimed = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
      `WITH claimed AS (
         SELECT id FROM feed_events
          WHERE client_number = $1 AND status = 'dlq'
            AND created_at < NOW() - INTERVAL '1 hour'
          ORDER BY created_at ASC
          LIMIT 25
          FOR UPDATE SKIP LOCKED
       )
       UPDATE feed_events SET status = 'new'
        WHERE id IN (SELECT id FROM claimed)
       RETURNING id`,
      ctx.clientNumber,
    );
    return { requeuedIds: claimed.map((c) => Number(c.id)) };
  },
  async verify(ctx, _pre, after) {
    const ids = (after.requeuedIds as number[]) ?? [];
    if (ids.length === 0) return false; // claimed nothing → nothing healed
    // Verify the EXACT rows we touched left the DLQ (they may already
    // be further along the pipeline — anything except 'dlq' counts).
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM feed_events
        WHERE client_number = $1 AND id = ANY($2::int[]) AND status = 'dlq'`,
      ctx.clientNumber, ids,
    );
    return (rows[0]?.n ?? 0) === 0;
  },
};


/**
 * DEF-099 — an ask that got an answer the owner was never told about.
 *
 * This is the failure that started everything. On 2026-08-06 Hamna answered,
 * the thread consumed her reply, every component reported healthy, and the
 * owner heard nothing. It took ten rounds of manual log reading to find, and it
 * was only findable because he reported it.
 *
 * `delegation_threads.owner_notified_at` (DEF-081) made it a QUERY: a thread
 * with an inbound reply and a null notified timestamp is, by definition, an
 * answer nobody passed on. This rule closes the loop — it does not just detect
 * the gap, it tells him, and stamps the column only after a CONFIRMED send.
 *
 * Bounded hard. One batch, oldest first, and the stamp is applied per-thread
 * only when that thread's own send returned sent. A partial batch leaves the
 * rest for the next pass rather than marking them told.
 */
const unnotifiedAnsweredAsk: RepairRule = {
  id: 'unnotified_answered_ask',
  description: 'Tell the owner about delegation threads that received a counterpart reply but were never notified (owner_notified_at IS NULL). Stamps only after a confirmed send.',
  scope: 'tenant',
  maxAttemptsPerDay: 24,
  // 30 is the framework's floor, asserted by the allowlist test. A repair that
  // can retry every few minutes is a repair loop waiting to happen, and this
  // one sends real WhatsApps to a real person.
  cooldownMin: 30,
  async detect(ctx) {
    if (!ctx.clientNumber) return null;
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; owner_user_id: number; title: string | null }>>(
      `SELECT t.id, t.owner_user_id, oi.title
         FROM delegation_threads t
         LEFT JOIN open_items oi ON oi.id = t.open_item_id
        WHERE t.client_number = $1
          AND t.owner_notified_at IS NULL
          AND EXISTS (SELECT 1 FROM delegation_thread_events e
                       WHERE e.thread_id = t.id AND e.event_type = 'inbound_received')
        ORDER BY t.updated_at ASC
        LIMIT 5`,
      ctx.clientNumber,
    );
    if (rows.length === 0) return null;
    return {
      summary: `${rows.length} ask(s) answered by a counterpart with the owner never told`,
      before: { threadIds: rows.map((r) => r.id), rows },
    };
  },
  async apply(ctx, pre) {
    const rows = (pre.before.rows as Array<{ id: string; owner_user_id: number; title: string | null }>) ?? [];
    const { brainContactsUser } = await import('../notifications/brainOutboundService');
    const notified: string[] = [];

    for (const r of rows) {
      // Per-thread, not per-batch: a send that fails must not stamp anything.
      const result = await brainContactsUser({
        userId: r.owner_user_id,
        kind: 'unnotified_answered_ask',
        summary: 'A reply came in that you were never told about',
        body: `Someone replied about ${r.title ? `"${r.title}"` : 'an item you delegated'} and I never passed it on. I've picked it up now — tell me if you want anything done about it.`,
        urgency: 'normal',
        channel: 'text',
        dedupKey: `unnotified_ask:${r.id}`,
      }).catch(() => ({ sent: false } as any));

      if (result?.sent) {
        // Written is not delivered — the stamp goes on only after the send
        // confirmed. Conflating those two is the entire DEF-081 class, and
        // stamping optimistically here would recreate it inside its own fix.
        await prisma.$executeRawUnsafe(
          `UPDATE delegation_threads SET owner_notified_at = NOW()
            WHERE id = $1 AND client_number = $2 AND owner_notified_at IS NULL`,
          r.id, ctx.clientNumber,
        );
        notified.push(r.id);
      }
    }
    return { notifiedThreadIds: notified };
  },
  async verify(ctx, _pre, after) {
    const ids = (after.notifiedThreadIds as string[]) ?? [];
    if (ids.length === 0) return false; // told nobody → healed nothing
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM delegation_threads
        WHERE client_number = $1 AND id = ANY($2::text[]) AND owner_notified_at IS NULL`,
      ctx.clientNumber, ids,
    );
    return (rows[0]?.n ?? 0) === 0;
  },
};

/**
 * DEF-100 — a question that was queued and never asked.
 *
 * Observed 2026-08-07: prompts 283 (queued 15:48) and 290 (queued 18:28) sat in
 * `queued` and were never sent. A question the owner never sees cannot be
 * answered, so the item behind it stalls silently — and from inside the system
 * everything looks fine, because the row exists.
 *
 * The repair is deliberately the ordinary dispatcher, not a bespoke send: if
 * `sendNextPrompt` is broken, this rule failing is the correct outcome and the
 * verify step will say so. A second send path would be one more implementation
 * of a rule that already has one.
 */
const stuckQueuedPrompt: RepairRule = {
  id: 'stuck_queued_prompt',
  description: 'Dispatch brain_prompt_queue rows stuck in queued past the stall threshold, via the normal dispatcher. Verifies the exact rows left queued.',
  scope: 'tenant',
  maxAttemptsPerDay: 24,
  cooldownMin: 30,
  async detect(ctx) {
    if (!ctx.clientNumber) return null;
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; user_id: number }>>(
      `SELECT id::text, user_id FROM brain_prompt_queue
        WHERE client_number = $1 AND state = 'queued'
          AND queued_at < NOW() - INTERVAL '30 minutes'
        ORDER BY queued_at ASC LIMIT 10`,
      ctx.clientNumber,
    );
    if (rows.length === 0) return null;
    return {
      summary: `${rows.length} question(s) queued over 30 min and never asked`,
      before: { promptIds: rows.map((r) => r.id), userIds: [...new Set(rows.map((r) => r.user_id))] },
    };
  },
  async apply(_ctx, pre) {
    const userIds = (pre.before.userIds as number[]) ?? [];
    const { sendNextPrompt } = await import('../brainPrompts/brainPromptQueueService');
    const dispatched: number[] = [];
    for (const userId of userIds) {
      // Per-user: the dispatcher advances one user's queue at a time, and a
      // failure for one user must not abandon the others.
      await sendNextPrompt(userId).then(() => dispatched.push(userId)).catch(() => {});
    }
    return { promptIds: pre.before.promptIds, dispatchedForUsers: dispatched };
  },
  async verify(ctx, _pre, after) {
    const ids = (after.promptIds as string[]) ?? [];
    if (ids.length === 0) return false;
    // Verify the EXACT rows moved. Anything other than 'queued' counts — sent,
    // answered, even expired means the queue advanced rather than stalling.
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM brain_prompt_queue
        WHERE client_number = $1 AND id = ANY($2::bigint[]) AND state = 'queued'`,
      ctx.clientNumber, ids.map((i) => BigInt(i)),
    );
    return (rows[0]?.n ?? 0) < ids.length; // at least one moved
  },
};

export const REPAIR_RULES: readonly RepairRule[] = [
  staleConnectorMetadata,
  stuckScribeMarkers,
  feedDlqReplay,
  // DEF-099/100 — the two gaps that actually reached the owner. Everything
  // above repairs infrastructure; these two repair the LOOP, which is where
  // every failure on 2026-08-06/07 actually lived.
  unnotifiedAnsweredAsk,
  stuckQueuedPrompt,
];

/** One pass over all rules: global rules once, tenant rules per active
 *  tenant. Registered hourly in server.ts under the job runner's lease
 *  (cross-replica single execution). */
export async function runSelfHealPass(): Promise<Record<string, RepairOutcome[]>> {
  const results: Record<string, RepairOutcome[]> = {};
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true } as any,
    select: { clientNumber: true },
  }).catch(() => [] as Array<{ clientNumber: string }>);

  for (const rule of REPAIR_RULES) {
    results[rule.id] = [];
    if (rule.scope === 'tenant') {
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
    return await prisma.$queryRawUnsafe<any[]>(
      `SELECT rule_id, scope, client_number, outcome, summary, created_at
         FROM self_heal_log ORDER BY created_at DESC LIMIT $1`,
      Math.min(Math.max(limit, 1), 200),
    );
  } catch { return []; }
}
