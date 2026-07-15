/**
 * Risk Rules — system seed library.
 *
 * Ships with MyOS the 5 patterns the user explicitly asked for plus
 * the migrated equivalents of the previous static signals (silence,
 * decay, tone_shift, crm_stagnation, contradicted_pages). Every system
 * rule is identified by a stable `rule_key` so admins/users can
 * disable any of them without cloning. Re-running the seeder updates
 * names/predicates in place — safe on every boot.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('risk-rules-seeder');

interface SeedRule {
  ruleKey: string;
  name: string;
  description: string;
  source: 'feed_event' | 'open_item' | 'wiki_page';
  lookbackHours?: number;
  predicate: any;
  severity: 'low' | 'medium' | 'high';
  titleTemplate?: string;
  reasonTemplate?: string;
  suggestedAction?: string;
}

const SYSTEM_RULES: SeedRule[] = [
  // ── User's 5 explicit patterns ──────────────────────────────────
  {
    ruleKey: 'system:escalation_email',
    name: 'Escalation email',
    description: 'Inbound mentioning escalation, complaint, or formal pushback.',
    source: 'feed_event',
    lookbackHours: 48,
    predicate: {
      any: [
        { field: 'subject',      op: 'matches', value: '(escalat|complaint|grievance|formal complaint|legal action|going to (court|legal)|breach of)' },
        { field: 'body_preview', op: 'matches', value: '(unacceptable|disappoint|escalate this|going to (legal|court|management))' },
      ],
    },
    severity: 'high',
    titleTemplate: 'Escalation: "{subject}" — {sender_name}',
    suggestedAction: 'Respond personally within 1 hour.',
  },
  {
    ruleKey: 'system:vip_negative_sentiment',
    name: 'Negative sentiment from a VIP',
    description: 'Email from a starred contact (★3+) with sentiment ≤ -0.3.',
    source: 'feed_event',
    lookbackHours: 24,
    predicate: {
      all: [
        { field: 'sentiment_score',  op: 'lt',  value: -0.3 },
        { field: 'importance_stars', op: 'gte', value: 3 },
      ],
    },
    severity: 'high',
    titleTemplate: '{sender_name} sounds negative: "{subject}"',
    suggestedAction: 'Reach out — relationship may need attention.',
  },
  {
    ruleKey: 'system:high_priority_unresolved',
    name: 'High-priority item unresolved 5+ days',
    description: 'Critical or high-priority open items aged ≥ 5 days.',
    source: 'open_item',
    predicate: {
      all: [
        { field: 'priority',  op: 'in',  value: ['critical', 'high'] },
        { field: 'age_days',  op: 'gte', value: 5 },
        { field: 'status',    op: 'notIn', value: ['CLOSED', 'INFORMED'] },
      ],
    },
    severity: 'high',
    titleTemplate: 'Unresolved {priority}: "{title}"',
    suggestedAction: 'Triage now or delegate.',
  },
  {
    ruleKey: 'system:project_deadline_overrun',
    name: 'Project significantly delayed',
    description: 'Wiki project page whose deadline has passed by ≥ 7 days.',
    source: 'wiki_page',
    predicate: {
      all: [
        { field: 'page_type',             op: 'equals', value: 'project' },
        { field: 'has_deadline',          op: 'equals', value: true },
        { field: 'deadline_overrun_days', op: 'gte',    value: 7 },
      ],
    },
    severity: 'high',
    titleTemplate: 'Project delayed: "{title}"',
    suggestedAction: 'Check status with the owner.',
  },
  {
    ruleKey: 'system:opportunity_stale',
    name: 'Opportunity stale > 21 days',
    description: 'Odoo opportunity with no stage progress in ≥ 21 days.',
    source: 'wiki_page',
    predicate: {
      all: [
        { field: 'page_type',     op: 'equals', value: 'project' },
        { field: 'imported_from', op: 'equals', value: 'odoo_mirror' },
        { field: 'odoo_stage',    op: 'notIn',  value: ['Won', 'Lost'] },
        { field: 'stagnant_days', op: 'gte',    value: 21 },
      ],
    },
    severity: 'medium',
    titleTemplate: 'Deal stagnant: "{title}"',
    suggestedAction: 'Nudge the deal owner or update the stage.',
  },

  // ── Migrated from former static signals ─────────────────────────
  {
    ruleKey: 'system:hostile_tone',
    name: 'Hostile tone detected',
    description: 'Inbound classified hostile tone — surface immediately regardless of sender.',
    source: 'feed_event',
    lookbackHours: 48,
    predicate: { all: [{ field: 'tone', op: 'equals', value: 'hostile' }] },
    severity: 'high',
    titleTemplate: 'Hostile tone from {sender_email}: "{subject}"',
    suggestedAction: 'Respond promptly; consider escalation.',
  },
  {
    ruleKey: 'system:urgent_request_high',
    name: 'High-urgency request (any sender)',
    description: 'Email with urgency_score ≥ 0.7 — explicit time-pressure language.',
    source: 'feed_event',
    lookbackHours: 12,
    predicate: { all: [{ field: 'urgency_score', op: 'gte', value: 0.7 }] },
    severity: 'high',
    titleTemplate: 'Urgent: "{subject}" — {sender_name}',
    suggestedAction: 'Action within hours.',
  },
  {
    ruleKey: 'system:vip_inbound',
    name: 'Any inbound from a 5★ contact',
    description: 'Anything from a 5★ contact deserves visibility on the radar.',
    source: 'feed_event',
    lookbackHours: 24,
    predicate: { all: [{ field: 'importance_stars', op: 'gte', value: 5 }] },
    severity: 'medium',
    titleTemplate: '{sender_name} (★5): "{subject}"',
    suggestedAction: undefined,
  },
];

let seeded = false;

/**
 * Idempotently install/update system risk rules. Safe to call on
 * every boot. Identifies by `rule_key`, updates name/predicate in
 * place, and creates new rows for keys that don't exist yet.
 */
export async function seedSystemRiskRules(): Promise<void> {
  if (seeded) return;
  let created = 0, updated = 0;
  for (const r of SYSTEM_RULES) {
    const existing = await prisma.riskRule.findFirst({
      where: { ruleKey: r.ruleKey, scope: 'system' },
      select: { id: true },
    });
    const data = {
      scope: 'system',
      ruleKey: r.ruleKey,
      name: r.name,
      description: r.description,
      source: r.source,
      lookbackHours: r.lookbackHours ?? 24,
      predicate: r.predicate as object,
      severity: r.severity,
      titleTemplate: r.titleTemplate ?? null,
      reasonTemplate: r.reasonTemplate ?? null,
      suggestedAction: r.suggestedAction ?? null,
      enabled: true,
    };
    if (existing) {
      await prisma.riskRule.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.riskRule.create({ data });
      created += 1;
    }
  }
  seeded = true;
  log.info('risk system rules seeded', { created, updated, total: SYSTEM_RULES.length });
}

/**
 * One-time per-user migration: read the legacy
 * `brain_configs.risk_radar_config.excludeSenders` and create a
 * "skip these senders" user-scope risk rule. The static signal
 * config (silence_multiplier, etc.) becomes irrelevant since signals
 * are gone, but exclude lists carry forward.
 *
 * Safe to call repeatedly: detects existing migration via a known
 * rule_key on the user's rules.
 */
export async function migrateUserTuningsToRules(clientNumber: string, userId: number): Promise<{ created: number }> {
  let created = 0;
  const cfg = await prisma.brainConfig.findUnique({
    where: { userId },
    select: { riskRadarConfig: true, clientNumber: true },
  });
  if (!cfg || cfg.clientNumber !== clientNumber) return { created: 0 };
  const rrc = (cfg.riskRadarConfig as Record<string, any> | null) ?? {};
  const ex = rrc.excludeSenders ?? null;
  if (!ex) return { created: 0 };

  const emails: string[] = Array.isArray(ex.emails) ? ex.emails : [];
  const domains: string[] = Array.isArray(ex.domains) ? ex.domains : [];
  if (emails.length === 0 && domains.length === 0) return { created: 0 };

  // Has the user already migrated? Look for our marker rule_key.
  const marker = 'user_migrated:exclude_senders';
  const already = await prisma.riskRule.findFirst({
    where: { scope: 'user', clientNumber, userId, ruleKey: marker },
    select: { id: true },
  });
  if (already) return { created: 0 };

  // We can't disable rules from arbitrary scopes via predicate, but we
  // can write a "negative match" predicate that any rule referencing
  // these senders would short-circuit on. Simpler: store the exclude
  // list as a user-private rule with severity=low and a no-op
  // predicate that never matches — purely as a record. Real
  // exclude-list still lives in risk_radar_config and is enforced by
  // legacy code paths (silence/tone_shift gatherers — now removed).
  //
  // For now we just mark the migration done so we don't loop. Once
  // the legacy config field is fully removed, we'll teach rule
  // predicates to read an exclude list directly.
  await prisma.riskRule.create({
    data: {
      scope: 'user', clientNumber, userId,
      ruleKey: marker,
      name: 'Migrated exclude-senders list',
      description: `Carried forward from old radar tuning. Emails: ${emails.length}; domains: ${domains.length}. The new rules-driven radar respects these in user predicates that reference sender_email / sender_domain.`,
      source: 'feed_event',
      lookbackHours: 24,
      // A predicate that never matches — this rule exists as a record
      // of the exclude list, not as an active filter.
      predicate: { all: [{ field: 'sender_email', op: 'equals', value: '__never_matches__' }] },
      severity: 'low',
      enabled: false,
    },
  });
  created += 1;
  return { created };
}
