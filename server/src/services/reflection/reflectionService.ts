/**
 * MyOS Reflection Agent.
 *
 * Runs nightly (plus on-demand). Walks the last 24–48h of decision_logs +
 * delegation_logs + feed_events + autonomous agent_actions and produces
 * human-readable pattern_insights: "You delegated Acme-related emails to
 * Umair 4 times this week", "3 unread newsletters from sap.com", etc.
 *
 * These land in the `pattern_insights` table and surface on Day Brief's
 * "Noticed overnight" section.
 *
 * No LLM required for v1 — pure aggregation queries. LLM-authored prose can
 * be added later via the llmRouter.
 */
import prisma from '../../db/prisma';

export interface ReflectionSummary {
  userId: number;
  clientNumber: string;
  insightsWritten: number;
  skippedExisting: number;
  durationMs: number;
}

// Only one insight per unique (user, description) within a 7-day window to
// avoid cluttering the Day Brief with duplicates when the Reflection agent
// re-runs.
const DEDUPE_WINDOW_DAYS = 7;

export async function reflectForUser(
  clientNumber: string,
  userId: number,
): Promise<ReflectionSummary> {
  const t0 = Date.now();
  const summary: ReflectionSummary = {
    userId,
    clientNumber,
    insightsWritten: 0,
    skippedExisting: 0,
    durationMs: 0,
  };

  const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const dedupeCutoff = new Date(Date.now() - DEDUPE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Fetch existing fresh insights so we don't duplicate
  const existing = await prisma.patternInsight.findMany({
    where: { clientNumber, userId, createdAt: { gte: dedupeCutoff } },
    select: { description: true },
  }).catch(() => []);
  const seen = new Set(existing.map((e) => e.description));

  const write = async (description: string, evidence: number) => {
    if (seen.has(description)) { summary.skippedExisting += 1; return; }
    await prisma.patternInsight.create({
      data: {
        clientNumber,
        userId,
        description,
        evidenceCount: evidence,
        status: 'new',
      } as any,
    }).catch(() => {});
    summary.insightsWritten += 1;
    seen.add(description);
  };

  // ─── 1. Frequent delegatee for a given archetype in last 7 days ─────
  const topDelegationRows = await prisma.$queryRawUnsafe<Array<{ delegatee_name: string | null; delegatee_email: string | null; task_archetype: string | null; n: number }>>(
    `SELECT delegatee_name, delegatee_email, task_archetype, COUNT(*)::int AS n
     FROM delegation_logs
     WHERE client_number = $1 AND user_id = $2 AND created_at >= $3
     GROUP BY delegatee_name, delegatee_email, task_archetype
     HAVING COUNT(*) >= 3
     ORDER BY n DESC LIMIT 3`,
    clientNumber, userId, since7d,
  ).catch(() => []);
  for (const d of topDelegationRows) {
    const who = d.delegatee_name ?? d.delegatee_email ?? '(someone)';
    const what = d.task_archetype ?? 'items';
    await write(`You delegated ${what.replace('_', ' ')} to ${who} ${d.n} times this week.`, d.n);
  }

  // ─── 2. Repeat senders you keep ignoring ─────────────────────────────
  const repeatIgnores = await prisma.$queryRawUnsafe<Array<{ domain: string; n: number }>>(
    `SELECT SUBSTRING(fe.sender_email FROM '.*@([^>]+)') AS domain, COUNT(*)::int AS n
     FROM decision_logs dl
     JOIN feed_events fe ON fe.id = dl.entity_id
     WHERE dl.client_number = $1 AND dl.user_id = $2
       AND dl.user_decision = 'dismissed'
       AND dl.created_at >= $3
       AND fe.sender_email IS NOT NULL
     GROUP BY domain
     HAVING COUNT(*) >= 3
     ORDER BY n DESC LIMIT 3`,
    clientNumber, userId, since7d,
  ).catch(() => []);
  for (const r of repeatIgnores) {
    if (!r.domain) continue;
    const domain = r.domain.replace('>', '').trim();
    await write(`You've ignored ${r.n} emails from ${domain} this week. Want a rule to auto-archive them?`, r.n);
  }

  // ─── 3. New autonomous actions Brain performed ─────────────────────
  const autoCount = await prisma.agentAction.count({
    where: {
      clientNumber, userId,
      executedByAgent: 'rule_miner_auto',
      createdAt: { gte: since24 },
    } as any,
  }).catch(() => 0);
  if (autoCount > 0) {
    await write(`I handled ${autoCount} item${autoCount > 1 ? 's' : ''} autonomously in the last 24 hours via your active rules.`, autoCount);
  }

  // ─── 4. New contacts worth attention ─────────────────────────────
  // Any external contact with a big jump in interactions over the week
  const newContactsRows = await prisma.$queryRawUnsafe<Array<{ name: string; n: number }>>(
    `SELECT name, relationship_strength::int AS n
     FROM entities
     WHERE client_number = $1 AND entity_type = 'contact'
       AND created_at >= $2
       AND relationship_strength >= 3
     ORDER BY relationship_strength DESC LIMIT 2`,
    clientNumber, since7d,
  ).catch(() => []);
  for (const c of newContactsRows) {
    await write(`New frequent contact: ${c.name} (${c.n} interactions this week).`, c.n);
  }

  // ─── 5. Stale open items ─────────────────────────────────────────
  const staleCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const staleCount = await prisma.openItem.count({
    where: {
      clientNumber, userId,
      status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'WAITING_INFO'] as any },
      updatedAt: { lt: staleCutoff },
    } as any,
  }).catch(() => 0);
  if (staleCount >= 3) {
    await write(`${staleCount} open items haven't moved in 2+ weeks. Want to review them?`, staleCount);
  }

  summary.durationMs = Date.now() - t0;
  return summary;
}

/** Run reflection for every active user in every active tenant. */
export async function reflectAllUsers(): Promise<ReflectionSummary[]> {
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, clientNumber: true },
  });
  const out: ReflectionSummary[] = [];
  for (const u of users) {
    try {
      out.push(await reflectForUser(u.clientNumber, u.id));
    } catch (err: any) {
      console.warn(`[reflection] user=${u.id} failed: ${err.message}`);
    }
  }
  return out;
}
