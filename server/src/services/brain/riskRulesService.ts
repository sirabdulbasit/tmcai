/**
 * Risk Rules — user-defined rules driving Risk Radar flags.
 *
 * Replaces the static-signal model (silence / decay / tone_shift / etc.)
 * with a rules-driven approach: each rule has a predicate against a
 * data source, a severity, and a flag template. Three scopes (system,
 * tenant, user) with the same override pattern as gate_rules.
 *
 * Predicate DSL is identical to gate_rules — we reuse `matches()` from
 * ruleEngineService. Sources differ in which fields are available:
 *
 *   feed_event:  subject, body_preview, sender_email, sender_domain,
 *                sender_name, source_type, event_type, recipient_count,
 *                is_cc_only, has_attachment, sentiment_score,
 *                urgency_score, tone, importance_stars, hours_ago
 *
 *   open_item:   title, type, status, priority, archetype,
 *                age_days, hours_until_due, days_overdue, has_due_date,
 *                priority_score, source_feed
 *
 *   wiki_page:   page_type, status, title, last_updated_days_ago,
 *                imported_from, odoo_stage, expected_revenue,
 *                probability, stagnant_days, deadline_overrun_days,
 *                has_deadline
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { matches, type Predicate } from '../triage/ruleEngineService';
import { getStarsForSender } from '../knowledge/entitySweepService';

const log = createLogger('risk-rules');

export type RuleSource = 'feed_event' | 'open_item' | 'wiki_page';
export type RuleSeverity = 'low' | 'medium' | 'high';

export interface RiskRule {
  id: number;
  scope: 'system' | 'tenant' | 'user';
  clientNumber: string | null;
  userId: number | null;
  ruleKey: string | null;
  name: string;
  description: string | null;
  source: RuleSource;
  lookbackHours: number | null;
  predicate: Predicate;
  severity: RuleSeverity;
  titleTemplate: string | null;
  reasonTemplate: string | null;
  suggestedAction: string | null;
  enabled: boolean;
  fireCount: number;
  lastFiredAt: Date | null;
}

export interface RuleHit {
  ruleId: number;
  ruleName: string;
  ruleKey: string | null;
  severity: RuleSeverity;
  signal: 'rule';            // single signal type for rule-driven flags
  title: string;
  reason: string;
  suggestedAction: string | null;
  sourceKind: string;        // 'open_item' | 'wiki_page' | 'feed_event'
  sourceId: string | number; // row id
  rank: number;              // for ordering
}

// ─── CRUD ────────────────────────────────────────────────────────

export async function listRulesFor(clientNumber: string, userId: number): Promise<RiskRule[]> {
  // Visibility: system + tenant + user-owned. Plus filter out system
  // rules that have an active override for this user/tenant.
  const overrides = await prisma.riskRuleOverride.findMany({
    where: {
      OR: [
        { clientNumber, scope: 'tenant', disabled: true },
        { clientNumber, scope: 'user', userId, disabled: true },
      ],
    },
    select: { ruleKey: true },
  });
  const disabledKeys = new Set(overrides.map((o) => o.ruleKey));

  const rules = await prisma.riskRule.findMany({
    where: {
      enabled: true,
      OR: [
        { scope: 'system', clientNumber: null },
        { scope: 'tenant', clientNumber },
        { scope: 'user', clientNumber, userId },
      ],
    },
  });
  return rules
    .filter((r) => !(r.ruleKey && disabledKeys.has(r.ruleKey)))
    .map(rowToRule);
}

export async function listRulesEditable(clientNumber: string, userId: number, isAdmin: boolean) {
  // For the editor: include disabled rules + show overrides so the user
  // can re-enable system rules they previously turned off.
  const where: any = {
    OR: [
      { scope: 'system', clientNumber: null },
      ...(isAdmin ? [{ scope: 'tenant', clientNumber }] : [{ scope: 'tenant', clientNumber, enabled: true }]),
      { scope: 'user', clientNumber, userId },
    ],
  };
  const rules = await prisma.riskRule.findMany({ where, orderBy: [{ scope: 'asc' }, { name: 'asc' }] });
  const overrides = await prisma.riskRuleOverride.findMany({
    where: {
      OR: [
        { clientNumber, scope: 'tenant' },
        { clientNumber, scope: 'user', userId },
      ],
    },
  });
  return { rules: rules.map(rowToRule), overrides };
}

export async function createUserRule(
  clientNumber: string, userId: number,
  input: Omit<RiskRule, 'id' | 'scope' | 'clientNumber' | 'userId' | 'ruleKey' | 'enabled' | 'fireCount' | 'lastFiredAt'> & { enabled?: boolean },
): Promise<RiskRule> {
  const created = await prisma.riskRule.create({
    data: {
      scope: 'user',
      clientNumber, userId,
      name: input.name.slice(0, 200),
      description: input.description ?? null,
      source: input.source,
      lookbackHours: input.lookbackHours ?? 24,
      predicate: input.predicate as object,
      severity: input.severity,
      titleTemplate: input.titleTemplate ?? null,
      reasonTemplate: input.reasonTemplate ?? null,
      suggestedAction: input.suggestedAction ?? null,
      enabled: input.enabled ?? true,
      createdByUserId: userId,
    },
  });
  return rowToRule(created);
}

export async function updateRule(
  id: number, clientNumber: string, userId: number, isAdmin: boolean,
  patch: Partial<RiskRule>,
): Promise<RiskRule> {
  const existing = await prisma.riskRule.findUnique({ where: { id } });
  if (!existing) throw new Error('rule not found');
  // Authorization: user-rule owner OR admin for tenant rule. System
  // rules can't be edited; user toggles them via the override table.
  if (existing.scope === 'user' && (existing.clientNumber !== clientNumber || existing.userId !== userId)) {
    throw new Error('not your rule');
  }
  if (existing.scope === 'tenant' && (existing.clientNumber !== clientNumber || !isAdmin)) {
    throw new Error('admin required for tenant rules');
  }
  if (existing.scope === 'system') throw new Error('system rules are immutable; use the override toggle');

  const updated = await prisma.riskRule.update({
    where: { id },
    data: {
      ...(patch.name !== undefined && { name: patch.name.slice(0, 200) }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.source !== undefined && { source: patch.source }),
      ...(patch.lookbackHours !== undefined && { lookbackHours: patch.lookbackHours }),
      ...(patch.predicate !== undefined && { predicate: patch.predicate as object }),
      ...(patch.severity !== undefined && { severity: patch.severity }),
      ...(patch.titleTemplate !== undefined && { titleTemplate: patch.titleTemplate }),
      ...(patch.reasonTemplate !== undefined && { reasonTemplate: patch.reasonTemplate }),
      ...(patch.suggestedAction !== undefined && { suggestedAction: patch.suggestedAction }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      updatedByUserId: userId,
    },
  });
  return rowToRule(updated);
}

export async function deleteRule(id: number, clientNumber: string, userId: number, isAdmin: boolean): Promise<void> {
  const existing = await prisma.riskRule.findUnique({ where: { id } });
  if (!existing) return;
  if (existing.scope === 'system') throw new Error('system rules cannot be deleted; disable instead');
  if (existing.scope === 'user' && (existing.clientNumber !== clientNumber || existing.userId !== userId)) {
    throw new Error('not your rule');
  }
  if (existing.scope === 'tenant' && !isAdmin) throw new Error('admin required for tenant rules');
  await prisma.riskRule.delete({ where: { id } });
}

export async function toggleSystemRule(
  ruleKey: string, clientNumber: string, userId: number, isAdmin: boolean,
  scope: 'tenant' | 'user', disabled: boolean, reason?: string,
): Promise<void> {
  if (scope === 'tenant' && !isAdmin) throw new Error('admin required');
  // user-scope: anyone can override for self. For tenant scope, set
  // user_id = null. For user scope, set user_id = self.
  if (disabled) {
    await prisma.$transaction([
      prisma.riskRuleOverride.deleteMany({
        where: scope === 'tenant'
          ? { ruleKey, scope: 'tenant', clientNumber, userId: null }
          : { ruleKey, scope: 'user', clientNumber, userId },
      }),
      prisma.riskRuleOverride.create({
        data: {
          ruleKey, scope, clientNumber,
          userId: scope === 'user' ? userId : null,
          disabled: true, reason: reason ?? null,
        },
      }),
    ]);
  } else {
    await prisma.riskRuleOverride.deleteMany({
      where: scope === 'tenant'
        ? { ruleKey, scope: 'tenant', clientNumber, userId: null }
        : { ruleKey, scope: 'user', clientNumber, userId },
    });
  }
}

// ─── Executor ─────────────────────────────────────────────────────

export async function executeAllRules(clientNumber: string, userId: number): Promise<RuleHit[]> {
  const rules = await listRulesFor(clientNumber, userId);
  if (rules.length === 0) return [];

  // Group by source so we read each table once.
  const bySource: Record<RuleSource, RiskRule[]> = {
    feed_event: [], open_item: [], wiki_page: [],
  };
  for (const r of rules) bySource[r.source].push(r);

  const [fe, oi, wp] = await Promise.all([
    bySource.feed_event.length > 0
      ? executeFeedEventRules(clientNumber, userId, bySource.feed_event)
      : Promise.resolve<RuleHit[]>([]),
    bySource.open_item.length > 0
      ? executeOpenItemRules(clientNumber, userId, bySource.open_item)
      : Promise.resolve<RuleHit[]>([]),
    bySource.wiki_page.length > 0
      ? executeWikiPageRules(clientNumber, userId, bySource.wiki_page)
      : Promise.resolve<RuleHit[]>([]),
  ]);

  const hits = [...fe, ...oi, ...wp];

  // Update fire counts (best-effort; failures don't affect radar output).
  if (hits.length > 0) {
    const counts = new Map<number, number>();
    for (const h of hits) counts.set(h.ruleId, (counts.get(h.ruleId) ?? 0) + 1);
    await Promise.all(Array.from(counts.entries()).map(([id, n]) =>
      prisma.riskRule.update({
        where: { id },
        data: { fireCount: { increment: n }, lastFiredAt: new Date() },
      }).catch(() => {}),
    ));
  }
  return hits;
}

// ─── Per-source executors ─────────────────────────────────────────

async function executeFeedEventRules(clientNumber: string, userId: number, rules: RiskRule[]): Promise<RuleHit[]> {
  // Find the longest lookback so we make ONE query covering all rules.
  const longest = Math.max(...rules.map((r) => r.lookbackHours ?? 24), 24);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, source_type, sender_email, sender_name,
            raw_payload->>'subject' AS subject,
            raw_payload->>'snippet' AS snippet,
            raw_payload->>'body' AS body,
            sentiment_score, urgency_score, tone,
            event_type,
            EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0 AS hours_ago,
            created_at
       FROM feed_events
      WHERE client_number = $1 AND user_id = $2
        AND created_at >= NOW() - (INTERVAL '1 hour' * $3)
      ORDER BY created_at DESC
      LIMIT 500`,
    clientNumber, userId, longest,
  ).catch(() => [] as any[]);

  // Bulk-fetch importance stars for senders.
  const senders = Array.from(new Set(rows.map((r) => (r.sender_email ?? '').toLowerCase()).filter(Boolean)));
  const starsBySender = new Map<string, number>();
  await Promise.all(senders.map(async (s) => {
    starsBySender.set(s, await getStarsForSender(clientNumber, userId, s).catch(() => 0));
  }));

  const hits: RuleHit[] = [];
  for (const rule of rules) {
    const lookback = rule.lookbackHours ?? 24;
    for (const r of rows) {
      if (Number(r.hours_ago) > lookback) continue;
      const senderEmail = (r.sender_email ?? '').toLowerCase();
      const ctx = {
        sender_email: senderEmail,
        sender_domain: senderEmail.includes('@') ? senderEmail.split('@')[1] : '',
        sender_name: (r.sender_name ?? '').toLowerCase(),
        subject: (r.subject ?? '').toLowerCase(),
        body_preview: (r.snippet ?? r.body ?? '').toLowerCase(),
        source_type: r.source_type,
        event_type: r.event_type ?? '',
        sentiment_score: Number(r.sentiment_score ?? 0),
        urgency_score: Number(r.urgency_score ?? 0),
        tone: (r.tone ?? '').toLowerCase(),
        importance_stars: starsBySender.get(senderEmail) ?? 0,
        hours_ago: Number(r.hours_ago),
      };
      try {
        if (matches(rule.predicate, ctx)) {
          hits.push({
            ruleId: rule.id, ruleName: rule.name, ruleKey: rule.ruleKey,
            severity: rule.severity, signal: 'rule',
            title: applyTemplate(rule.titleTemplate, ctx, defaultFeedTitle(rule, r)),
            reason: applyTemplate(rule.reasonTemplate, ctx, defaultFeedReason(r, ctx)),
            suggestedAction: rule.suggestedAction,
            sourceKind: 'feed_event', sourceId: r.id,
            rank: rankBySeverity(rule.severity) + (ctx.importance_stars * 0.05),
          });
        }
      } catch (err: any) {
        log.warn('rule predicate failed', { ruleId: rule.id, error: err.message });
      }
    }
  }
  return hits;
}

async function executeOpenItemRules(clientNumber: string, userId: number, rules: RiskRule[]): Promise<RuleHit[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, item_number, title, description, type, status, priority, archetype,
            priority_score, source_feed, due_date, created_at, updated_at,
            EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0 AS age_days,
            CASE WHEN due_date IS NULL THEN NULL
                 ELSE EXTRACT(EPOCH FROM (due_date - NOW())) / 3600.0 END AS hours_until_due,
            CASE WHEN due_date IS NULL OR due_date >= NOW() THEN 0
                 ELSE EXTRACT(EPOCH FROM (NOW() - due_date)) / 86400.0 END AS days_overdue
       FROM open_items
      WHERE client_number = $1 AND user_id = $2
        AND status NOT IN ('CLOSED','CANCELLED','INFORMED')
      ORDER BY priority_score DESC NULLS LAST, created_at ASC
      LIMIT 500`,
    clientNumber, userId,
  ).catch(() => [] as any[]);

  const hits: RuleHit[] = [];
  for (const rule of rules) {
    for (const r of rows) {
      const ctx = {
        title: (r.title ?? '').toLowerCase(),
        description: (r.description ?? '').toLowerCase(),
        type: r.type ?? '',
        status: r.status,
        priority: r.priority,
        archetype: r.archetype ?? '',
        priority_score: Number(r.priority_score ?? 0),
        source_feed: r.source_feed ?? '',
        age_days: Number(r.age_days ?? 0),
        has_due_date: r.due_date != null,
        hours_until_due: r.hours_until_due == null ? -1 : Number(r.hours_until_due),
        days_overdue: Number(r.days_overdue ?? 0),
      };
      try {
        if (matches(rule.predicate, ctx)) {
          hits.push({
            ruleId: rule.id, ruleName: rule.name, ruleKey: rule.ruleKey,
            severity: rule.severity, signal: 'rule',
            title: applyTemplate(rule.titleTemplate, { ...ctx, title: r.title, item_number: r.item_number },
              `${rule.name}: "${truncate(r.title, 80)}"`),
            reason: applyTemplate(rule.reasonTemplate, ctx,
              `${r.priority} priority · ${Math.round(ctx.age_days)}d old · status ${r.status}` +
              (ctx.days_overdue > 0 ? ` · ${Math.round(ctx.days_overdue)}d overdue` : '')),
            suggestedAction: rule.suggestedAction,
            sourceKind: 'open_item', sourceId: r.id,
            rank: rankBySeverity(rule.severity) + Math.min(0.3, ctx.age_days / 30),
          });
        }
      } catch (err: any) {
        log.warn('rule predicate failed', { ruleId: rule.id, error: err.message });
      }
    }
  }
  return hits;
}

async function executeWikiPageRules(clientNumber: string, userId: number, rules: RiskRule[]): Promise<RuleHit[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, page_type, status, last_updated_at, last_updated_by, metadata,
            EXTRACT(EPOCH FROM (NOW() - last_updated_at)) / 86400.0 AS last_updated_days_ago
       FROM wiki_pages
      WHERE client_number = $1
        AND (user_id = $2 OR metadata->>'scope' = 'tenant'
             OR metadata->'discovered_by_users' @> $3::jsonb)
        AND status <> 'deleted'
      ORDER BY last_updated_at DESC
      LIMIT 500`,
    clientNumber, userId, JSON.stringify([userId]),
  ).catch(() => [] as any[]);

  const hits: RuleHit[] = [];
  for (const rule of rules) {
    for (const r of rows) {
      const meta = r.metadata ?? {};
      const odooStage = meta.odoo_stage ?? '';
      const expRev = Number(meta.expected_revenue ?? 0);
      const probability = Number(meta.probability ?? 0);
      const importedFrom = meta.imported_from ?? meta.source ?? '';
      const deadlineISO = meta.deadline ?? meta.date_deadline ?? null;
      const stagnantDays = Number(r.last_updated_days_ago ?? 0);
      const deadlineOverrunDays = deadlineISO
        ? Math.max(0, (Date.now() - new Date(deadlineISO).getTime()) / 86400000)
        : 0;
      const ctx = {
        title: (r.title ?? '').toLowerCase(),
        page_type: r.page_type,
        status: r.status,
        imported_from: importedFrom,
        odoo_stage: odooStage,
        expected_revenue: expRev,
        probability,
        last_updated_days_ago: stagnantDays,
        stagnant_days: stagnantDays,
        deadline_overrun_days: deadlineOverrunDays,
        has_deadline: !!deadlineISO,
      };
      try {
        if (matches(rule.predicate, ctx)) {
          hits.push({
            ruleId: rule.id, ruleName: rule.name, ruleKey: rule.ruleKey,
            severity: rule.severity, signal: 'rule',
            title: applyTemplate(rule.titleTemplate, { ...ctx, title: r.title },
              `${rule.name}: "${truncate(r.title, 80)}"`),
            reason: applyTemplate(rule.reasonTemplate, ctx,
              `${r.page_type} · last updated ${Math.round(stagnantDays)}d ago` +
              (odooStage ? ` · stage ${odooStage}` : '') +
              (expRev ? ` · value ${expRev}` : '')),
            suggestedAction: rule.suggestedAction,
            sourceKind: 'wiki_page', sourceId: r.id,
            rank: rankBySeverity(rule.severity) + Math.min(0.3, stagnantDays / 60),
          });
        }
      } catch (err: any) {
        log.warn('rule predicate failed', { ruleId: rule.id, error: err.message });
      }
    }
  }
  return hits;
}

// ─── helpers ──────────────────────────────────────────────────────

function applyTemplate(tpl: string | null | undefined, ctx: Record<string, unknown>, fallback: string): string {
  if (!tpl) return fallback;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => {
    const v = ctx[k];
    if (v == null) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
    return String(v).slice(0, 200);
  });
}

function defaultFeedTitle(rule: RiskRule, r: any): string {
  const subj = String(r.subject ?? '').slice(0, 80);
  const sender = String(r.sender_name ?? r.sender_email ?? 'unknown');
  return subj ? `${rule.name}: "${subj}" — ${sender}` : `${rule.name} — ${sender}`;
}

function defaultFeedReason(r: any, ctx: any): string {
  const bits: string[] = [];
  if (ctx.urgency_score >= 0.6) bits.push(`urgency ${ctx.urgency_score.toFixed(2)}`);
  if (ctx.sentiment_score <= -0.3) bits.push(`sentiment ${ctx.sentiment_score.toFixed(2)}`);
  if (ctx.tone && ctx.tone !== 'neutral') bits.push(`tone ${ctx.tone}`);
  if (ctx.importance_stars > 0) bits.push(`★${ctx.importance_stars}/5`);
  bits.push(`${Math.round(ctx.hours_ago)}h ago`);
  return bits.join(' · ');
}

function rankBySeverity(sev: RuleSeverity): number {
  return sev === 'high' ? 0.7 : sev === 'medium' ? 0.4 : 0.2;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function rowToRule(r: any): RiskRule {
  return {
    id: r.id,
    scope: r.scope,
    clientNumber: r.clientNumber,
    userId: r.userId,
    ruleKey: r.ruleKey,
    name: r.name,
    description: r.description,
    source: r.source,
    lookbackHours: r.lookbackHours,
    predicate: r.predicate as Predicate,
    severity: r.severity,
    titleTemplate: r.titleTemplate,
    reasonTemplate: r.reasonTemplate,
    suggestedAction: r.suggestedAction,
    enabled: r.enabled,
    fireCount: r.fireCount,
    lastFiredAt: r.lastFiredAt,
  };
}
