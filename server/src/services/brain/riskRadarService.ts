/**
 * Risk Radar — daily forward-looking risk surface (per-user).
 *
 * v16's `risk_radar` job emits a typed RiskFlagDoc separate from the
 * morning brief. We replicate the pattern multi-user: each user has
 * their own enabled-signals + thresholds + schedule. A CFO sees
 * cash-runway flags, a CTO sees infra/SLA flags, a sales lead sees
 * deal-stagnation flags — all from the same engine, configured per
 * person.
 *
 * The radar reads RESTING STATE — what's already in the system but
 * silently aging in dangerous ways. It complements the criticality
 * engine, which reacts to *new* events. No double-counting: the radar
 * primarily surfaces things the criticality engine *cannot* see because
 * nothing new arrived.
 *
 * Six default signals (each user can toggle/threshold individually):
 *   1. stagnant_criticality — high-criticality items still open after N days
 *   2. decay                — open items aged > 1.5× typical resolution
 *   3. silence              — sender tempo: silence >> typical window
 *   4. imminence            — instructions/commitments due in next 48h
 *   5. crm_stagnation       — Odoo-mirrored opportunities idle > N days
 *   6. contradicted_pages   — wiki pages flagged contradicted/stale
 *
 * Output: one RiskFlagDoc per (clientNumber, userId, runDate). Ranked.
 * Re-running the same day overwrites in place (UPSERT on stable id).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { callLLM } from '../llmRouter';
import { writeDoc as writeBrainDoc } from './brainDocsService';

const log = createLogger('risk-radar');

// ─── Types ────────────────────────────────────────────────────────

export type FlagSignal =
  | 'stagnant_criticality'
  | 'decay'
  | 'silence'
  | 'imminence'
  | 'crm_stagnation'
  | 'contradicted_pages'
  | 'custom_keywords'
  | 'tone_shift';

export type FlagSeverity = 'high' | 'medium' | 'low';

export interface RiskFlag {
  id: string;
  signal: FlagSignal;
  severity: FlagSeverity;
  /** One-line title shown in the UI card. */
  title: string;
  /** 1-2 sentence explanation citing concrete signals. */
  reason: string;
  /** Where to click — open item id, wiki page id, etc. */
  sourceRefs: Array<{ kind: string; id: string | number; label?: string }>;
  /** Suggested next step (one short imperative). Optional. */
  suggestedAction?: string;
  /** Numeric score 0..1 used for ranking. Higher = surface higher. */
  rank: number;
}

export interface RiskRadarConfig {
  enabled: boolean;
  schedule: string;          // cron — default '15 8 * * *' (08:15 PKT)
  timezone: string;          // default 'Asia/Karachi'
  deliveryChannel: 'in_app' | 'email' | 'both' | 'none';
  signals: {
    stagnant_criticality: { enabled: boolean; min_score: number; max_age_days: number };
    decay:               { enabled: boolean; age_multiplier: number };
    silence:             { enabled: boolean; silence_multiplier: number };
    imminence:           { enabled: boolean; hours_ahead: number };
    crm_stagnation:      { enabled: boolean; stagnant_days: number };
    contradicted_pages:  { enabled: boolean };
    custom_keywords:     { enabled: boolean; keywords: string[] };
    tone_shift:          { enabled: boolean; min_negative_count: number; lookback_days: number };
  };
  /** Per-user skip list. Senders matching any entry in `excludeEmails`
   *  or any domain in `excludeDomains` are dropped from silence +
   *  tone_shift signals (in addition to the system-wide noise filter
   *  for no-reply/bot domains). */
  excludeSenders?: { emails: string[]; domains: string[] };
  max_flags: number;
  narrate: boolean;
}

export const DEFAULT_RADAR_CONFIG: RiskRadarConfig = {
  enabled: true,
  schedule: '15 8 * * *',
  timezone: 'Asia/Karachi',
  deliveryChannel: 'in_app',
  signals: {
    stagnant_criticality: { enabled: true, min_score: 0.6, max_age_days: 7 },
    decay:                { enabled: true, age_multiplier: 1.5 },
    silence:              { enabled: true, silence_multiplier: 3 },
    imminence:            { enabled: true, hours_ahead: 48 },
    crm_stagnation:       { enabled: true, stagnant_days: 14 },
    contradicted_pages:   { enabled: true },
    custom_keywords:      { enabled: false, keywords: [] },
    tone_shift:           { enabled: true, min_negative_count: 2, lookback_days: 7 },
  },
  excludeSenders: { emails: [], domains: [] },
  max_flags: 12,
  narrate: true,
};

export interface RunResult {
  docId: string;
  runDate: string;
  flags: RiskFlag[];
  summary: string;
  narrative: string | null;
  flagCount: number;
  highSeverityCount: number;
  sourceSignals: Record<string, { candidates: number; emitted: number }>;
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Run the radar for one user. Reads config (with defaults), gathers
 * signals, ranks flags, optionally narrates, persists a RiskFlagDoc,
 * and returns the result. Idempotent on (clientNumber, userId, today).
 */
export async function runForUser(
  clientNumber: string,
  userId: number,
  opts: { force?: boolean; runDate?: Date } = {},
): Promise<RunResult> {
  const config = await loadConfig(clientNumber, userId);
  if (!config.enabled && !opts.force) {
    return emptyResult(clientNumber, userId, opts.runDate ?? new Date(), 'radar disabled for this user');
  }

  const runDate = opts.runDate ?? new Date();
  const dateStr = runDate.toISOString().slice(0, 10);
  const docId = `risk:${clientNumber}:${userId}:${dateStr}`;

  // Gather flags via two paths:
  //   1) Rule executor — runs every enabled risk_rule (system + tenant +
  //      user) against feed_event / open_item / wiki_page sources.
  //      Replaces the old static gatherers (silence, decay, tone_shift,
  //      crm_stagnation, contradicted_pages, custom_keywords, stagnant
  //      criticality).
  //   2) Imminence — kept as a built-in static gatherer because it is
  //      purely time-based (calendar events, due-dates, instructions
  //      with dueAt) and not noise-prone.
  const sourceSignals: Record<string, { candidates: number; emitted: number }> = {};
  const [ruleHits, imminenceFlags] = await Promise.all([
    (async () => {
      const { executeAllRules } = await import('./riskRulesService');
      return executeAllRules(clientNumber, userId);
    })().catch(() => [] as Array<RiskFlag>),
    config.signals.imminence.enabled
      ? gatherImminence(clientNumber, userId, config.signals.imminence, sourceSignals)
      : Promise.resolve([]),
  ]);

  // Map RuleHit → RiskFlag shape so the existing UI keeps rendering.
  const ruleFlags: RiskFlag[] = (ruleHits as any[]).map((h) => ({
    id: `rule:${h.ruleId}:${h.sourceKind}:${h.sourceId}`,
    signal: signalForSource(h.sourceKind),
    severity: h.severity,
    title: h.title,
    reason: h.reason,
    sourceRefs: [{ kind: h.sourceKind, id: h.sourceId }],
    suggestedAction: h.suggestedAction ?? undefined,
    rank: h.rank,
  }));

  // Diagnostics: count rule hits by source for the source_signals block.
  const ruleCounts: Record<string, number> = {};
  for (const h of ruleHits as any[]) {
    ruleCounts[h.sourceKind] = (ruleCounts[h.sourceKind] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(ruleCounts)) {
    sourceSignals[`rule_${k}`] = { candidates: v, emitted: v };
  }

  const allFlags: RiskFlag[] = [...ruleFlags, ...imminenceFlags];
  // Rank descending and trim to max_flags
  allFlags.sort((a, b) => b.rank - a.rank);
  const flags = allFlags.slice(0, config.max_flags);
  const highSeverityCount = flags.filter((f) => f.severity === 'high').length;

  const summary = buildSummary(flags, highSeverityCount);
  let narrative: string | null = null;
  let model: string | null = null;
  let tokensInput: number | null = null;
  let tokensOutput: number | null = null;
  if (config.narrate && flags.length > 0) {
    const r = await narrateFlags(clientNumber, userId, flags).catch((err) => {
      log.warn('narration failed — radar still emits flags', { error: err.message });
      return null;
    });
    if (r) {
      narrative = r.text;
      model = r.provider;
      tokensInput = r.tokensInput ?? null;
      tokensOutput = r.tokensOutput ?? null;
    }
  }

  // UPSERT the doc — re-running the same day replaces in place. Stable
  // id `risk:<client>:<user>:<YYYY-MM-DD>` makes the upsert deterministic.
  await prisma.riskFlagDoc.upsert({
    where: { id: docId },
    create: {
      id: docId, clientNumber, userId,
      runDate: new Date(dateStr),
      flags: flags as unknown as object,
      narrative, summary,
      flagCount: flags.length,
      highSeverityCount,
      sourceSignals: sourceSignals as unknown as object,
      model: model ?? undefined,
      tokensInput: tokensInput ?? undefined,
      tokensOutput: tokensOutput ?? undefined,
      status: 'active',
    },
    update: {
      generatedAt: new Date(),
      flags: flags as unknown as object,
      narrative, summary,
      flagCount: flags.length,
      highSeverityCount,
      sourceSignals: sourceSignals as unknown as object,
      model: model ?? undefined,
      tokensInput: tokensInput ?? undefined,
      tokensOutput: tokensOutput ?? undefined,
      status: 'active',
      error: null,
    },
  });

  // Mirror to the typed Brain Doc store so the radar joins the unified
  // replay/audit/feedback substrate alongside morning_brief, ask_invocation
  // and proposal docs. The risk_flag_docs row stays as the read-optimized
  // projection; brain_docs row is what feedback / replay paths consume.
  // Failure here is non-fatal — the projection has already been written.
  await writeBrainDoc({
    clientNumber, userId,
    docType: 'risk_radar',
    scopeKey: dateStr,
    inputSummary: {
      run_date: dateStr,
      enabled_signals: Object.entries(config.signals)
        .filter(([, v]) => (v as { enabled?: boolean }).enabled)
        .map(([k]) => k),
      thresholds: config.signals,
      max_flags: config.max_flags,
      narrate: config.narrate,
    },
    sourceEventIds: collectSourceEventIds(flags),
    output: { flags, sourceSignals } as unknown as Record<string, unknown>,
    prose: narrative,
    summary,
    model: model ?? null,
    tokensInput, tokensOutput,
    projectionId: docId,
  }).catch((err: any) => {
    log.warn('brain_doc mirror write failed (radar projection still saved)', {
      clientNumber, userId, runDate: dateStr, error: err.message,
    });
  });

  log.info('risk radar run complete', {
    clientNumber, userId, runDate: dateStr,
    flagCount: flags.length, highSeverityCount,
  });
  return { docId, runDate: dateStr, flags, summary, narrative, flagCount: flags.length, highSeverityCount, sourceSignals };
}

/** Pull source event ids out of flags so brain_docs can index them. */
function collectSourceEventIds(flags: RiskFlag[]): string[] {
  const out = new Set<string>();
  for (const f of flags) {
    for (const r of f.sourceRefs ?? []) {
      if (r.kind === 'feed_event') out.add(String(r.id));
    }
  }
  return Array.from(out);
}

/**
 * Run the radar for every active user across every tenant. Called from
 * the leader-locked daily cron; per-user iteration is sequential so a
 * single user's failure doesn't poison the rest.
 */
export async function runForAllActiveUsers(): Promise<{ tenants: number; users: number; succeeded: number; failed: number }> {
  const rows = await prisma.$queryRawUnsafe<Array<{ client_number: string; id: number }>>(
    `SELECT u.client_number, u.id
       FROM users u
      WHERE u.is_active = TRUE`,
  );
  let succeeded = 0, failed = 0;
  const tenants = new Set<string>();
  for (const r of rows) {
    tenants.add(r.client_number);
    try {
      await runForUser(r.client_number, r.id);
      succeeded += 1;
    } catch (err: any) {
      failed += 1;
      log.warn('runForUser failed', { clientNumber: r.client_number, userId: r.id, error: err.message });
    }
  }
  return { tenants: tenants.size, users: rows.length, succeeded, failed };
}

/** Read latest RiskFlagDoc for a user. Returns null if none exists. */
export async function getLatestForUser(clientNumber: string, userId: number) {
  return prisma.riskFlagDoc.findFirst({
    where: { clientNumber, userId, status: 'active' },
    orderBy: { runDate: 'desc' },
  });
}

/** Read config (filling in defaults for missing keys). */
export async function loadConfig(clientNumber: string, userId: number): Promise<RiskRadarConfig> {
  const row = await prisma.brainConfig.findUnique({
    where: { userId },
    select: { riskRadarConfig: true, clientNumber: true },
  });
  if (!row || row.clientNumber !== clientNumber) return { ...DEFAULT_RADAR_CONFIG };
  return mergeConfig(row.riskRadarConfig as Partial<RiskRadarConfig> | null);
}

/** Persist a config update for a user. Validates structure. */
export async function saveConfig(
  clientNumber: string,
  userId: number,
  patch: Partial<RiskRadarConfig>,
): Promise<RiskRadarConfig> {
  // Ensure brain_configs row exists
  const existing = await prisma.brainConfig.findUnique({ where: { userId }, select: { id: true, clientNumber: true } });
  if (!existing) {
    await prisma.brainConfig.create({ data: { userId, clientNumber } });
  } else if (existing.clientNumber !== clientNumber) {
    throw new Error('user does not belong to this tenant');
  }
  const current = await loadConfig(clientNumber, userId);
  const merged = mergeConfig({ ...current, ...patch });
  await prisma.brainConfig.update({
    where: { userId },
    data: { riskRadarConfig: merged as unknown as object },
  });
  return merged;
}

/** Map a rule's source kind to the legacy FlagSignal value so the UI
 *  keeps showing a meaningful chip. Rule-driven hits use a per-source
 *  signal label so the user can tell at a glance whether the flag came
 *  from a feed event, an open item, or a wiki/CRM page. */
function signalForSource(sourceKind: string): FlagSignal {
  // We map to the closest pre-existing chip label so the UI doesn't
  // need updating. tone_shift / silence are more specific than the
  // generic "feed event" — but with rule-driven flags we don't know
  // the user's intent. Use a single generic for clarity.
  if (sourceKind === 'open_item') return 'stagnant_criticality';
  if (sourceKind === 'wiki_page') return 'crm_stagnation';
  return 'custom_keywords';
}

// ─── Sender noise filters ────────────────────────────────────────
//
// Many feed senders are useless for "follow-up" or "tone-shift" flags
// because they're machines, not people who reply:
//   · the user themselves (auto-flagged on outbound where user_id = self)
//   · no-reply / mailer-daemon / postmaster / notifications@…
//   · Google Calendar shared-calendar bot identities
//   · GitHub / Jira / Linear / Slack notification bots
//   · Stripe / billing / receipt senders
// We filter these out of the silence + tone_shift signals so the radar
// surfaces real relationships at risk, not bot floods.
const NOISE_LOCALPART_PREFIXES = [
  'no-reply', 'noreply', 'no_reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster', 'notifications', 'notification',
  'auto-confirm', 'auto_confirm', 'autoreply', 'auto-reply',
  'system', 'admin', 'service', 'support',
  'invitations', 'calendar', 'invite',
  'receipts', 'billing', 'invoice',
];
const NOISE_DOMAINS = [
  'google.com',                  // Calendar share/notification bots
  'mail.anthropic.com',
  'sendgrid.net', 'sendgrid.com',
  'mailgun.org', 'mailgun.net',
  'amazonses.com',
  'github.com',                  // notification bot subdomains too
  'atlassian.com', 'atlassian.net',
  'linear.app',
  'slack.com',
  'stripe.com',
  'docusign.net', 'docusign.com',
];

/**
 * Returns true when the email looks like a bot / notification / system
 * sender that should NOT trigger silence or tone_shift flags.
 */
function isNoiseSender(email: string): boolean {
  const e = (email ?? '').toLowerCase().trim();
  if (!e || !e.includes('@')) return false;
  const [local, domain] = e.split('@');
  for (const p of NOISE_LOCALPART_PREFIXES) {
    if (local === p || local.startsWith(`${p}-`) || local.startsWith(`${p}_`) || local.startsWith(`${p}.`)) return true;
  }
  for (const d of NOISE_DOMAINS) {
    if (domain === d || domain.endsWith(`.${d}`)) return true;
  }
  return false;
}

/** Look up the user's own email so we can exclude self-emails from
 *  sender-based signals (silence / tone_shift). */
async function getUserEmail(userId: number): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return u?.email ? u.email.toLowerCase() : null;
}

// ─── Signal gatherers ─────────────────────────────────────────────

async function gatherStagnantCriticality(
  clientNumber: string, userId: number,
  cfg: RiskRadarConfig['signals']['stagnant_criticality'],
  diag: Record<string, { candidates: number; emitted: number }>,
): Promise<RiskFlag[]> {
  // Read items where ANY of three signals indicates importance:
  //   1. priority_score (0..10) populated by priorityScoreService — canonical
  //   2. metadata.criticality.composite (0..1) — when triage stamps it
  //   3. priority='critical' or 'high' — fallback when neither is populated
  // Threshold cfg.min_score is on the 0..1 scale; we map priority_score >= min*10.
  const minScore01 = cfg.min_score;
  const minScore10 = minScore01 * 10;
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, item_number AS "itemNumber", title, priority, status, due_date AS "dueDate",
            created_at AS "createdAt",
            priority_score AS "priorityScore10",
            (metadata->'criticality'->>'composite')::float AS "compositeFromMetadata"
       FROM open_items
      WHERE client_number = $1 AND user_id = $2
        AND status NOT IN ('CLOSED','INFORMED','SNOOZED')
        AND created_at >= NOW() - (INTERVAL '1 day' * $3)
        AND (
          priority_score >= $4
          OR (metadata->'criticality'->>'composite')::float >= $5
          OR priority IN ('critical','high')
        )
      ORDER BY COALESCE(priority_score, 0) DESC, created_at ASC
      LIMIT 50`,
    clientNumber, userId, cfg.max_age_days, minScore10, minScore01,
  ).catch(() => [] as any[]);
  diag.stagnant_criticality = { candidates: rows.length, emitted: 0 };

  const flags: RiskFlag[] = rows.map((r) => {
    const ageDays = Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 86400000);
    // Normalize to 0..1 from whichever source we have.
    const fromMeta: number = Number(r.compositeFromMetadata ?? 0);
    const fromScore10: number = Number(r.priorityScore10 ?? 0);
    const fromPriority: number = r.priority === 'critical' ? 0.85 : r.priority === 'high' ? 0.7 : 0;
    const composite = Math.max(fromMeta, fromScore10 / 10, fromPriority);
    const sourceLabel =
      fromMeta >= minScore01 ? 'criticality engine' :
      fromScore10 >= minScore10 ? 'priority score' :
      'priority tier';
    const severity: FlagSeverity = composite >= 0.85 ? 'high' : composite >= 0.7 ? 'medium' : 'low';
    return {
      id: `stagnant:${r.id}`,
      signal: 'stagnant_criticality',
      severity,
      title: `Critical item still open: "${truncate(r.title, 80)}"`,
      reason: `${sourceLabel} flagged this at ${composite.toFixed(2)} when it arrived ${ageDays}d ago. Still ${r.status} with no movement.`,
      sourceRefs: [{ kind: 'open_item', id: r.id, label: `#${r.itemNumber}` }],
      suggestedAction: 'Triage now or delegate.',
      rank: composite + ageDays * 0.02,
    };
  });
  diag.stagnant_criticality.emitted = flags.length;
  return flags;
}

async function gatherDecay(
  clientNumber: string, userId: number,
  cfg: RiskRadarConfig['signals']['decay'],
  diag: Record<string, { candidates: number; emitted: number }>,
): Promise<RiskFlag[]> {
  // Use a per-user typical resolution time. Compute from CLOSED items in
  // the last 60 days; default to 4 days if not enough history.
  const stats = await prisma.$queryRawUnsafe<Array<{ median_days: number | null; n: number }>>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400.0
            ) AS median_days,
            COUNT(*)::int AS n
       FROM open_items
      WHERE client_number = $1 AND user_id = $2
        AND status IN ('CLOSED','INFORMED')
        AND updated_at >= NOW() - INTERVAL '60 days'`,
    clientNumber, userId,
  ).catch(() => [{ median_days: null, n: 0 }] as any);
  const median = (stats[0]?.median_days && stats[0].n >= 5) ? stats[0].median_days : 4;
  const threshold = median * cfg.age_multiplier;

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, item_number AS "itemNumber", title, priority, status, created_at AS "createdAt"
       FROM open_items
      WHERE client_number = $1 AND user_id = $2
        AND status NOT IN ('CLOSED','INFORMED','SNOOZED','DELEGATED')
        AND created_at < NOW() - (INTERVAL '1 day' * $3)
      ORDER BY created_at ASC
      LIMIT 50`,
    clientNumber, userId, threshold,
  ).catch(() => [] as any[]);
  diag.decay = { candidates: rows.length, emitted: 0 };

  const flags: RiskFlag[] = rows.map((r) => {
    const ageDays = Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 86400000);
    const overshoot = ageDays / threshold; // >1
    const severity: FlagSeverity = overshoot >= 3 ? 'high' : overshoot >= 2 ? 'medium' : 'low';
    return {
      id: `decay:${r.id}`,
      signal: 'decay',
      severity,
      title: `Aging item: "${truncate(r.title, 80)}"`,
      reason: `Open ${ageDays}d — ${overshoot.toFixed(1)}× your typical ${median.toFixed(1)}d resolution time.`,
      sourceRefs: [{ kind: 'open_item', id: r.id, label: `#${r.itemNumber}` }],
      suggestedAction: 'Close, delegate, or snooze with a deadline.',
      rank: 0.4 + Math.min(0.5, overshoot / 6),
    };
  });
  diag.decay.emitted = flags.length;
  return flags;
}

async function gatherSilence(
  clientNumber: string, userId: number,
  cfg: RiskRadarConfig['signals']['silence'],
  diag: Record<string, { candidates: number; emitted: number }>,
): Promise<RiskFlag[]> {
  // Per-sender tempo from feed_events. Anyone whose typical reply window
  // is < currentSilence × silence_multiplier and we've been waiting on
  // them gets flagged.
  //
  // Noise filters (bake into SQL to keep the candidate set small):
  //   · skip the user's own email (you can't be silent toward yourself)
  //   · skip no-reply / notification bots — see isNoiseSender + filtered post-query
  //   · raise minimum sample count to 5 (was 3) so a one-week-old contact
  //     with a single gap doesn't dominate the radar
  const userEmail = await getUserEmail(userId);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `WITH gaps AS (
       SELECT sender_email,
              EXTRACT(EPOCH FROM (LEAD(created_at) OVER (PARTITION BY sender_email ORDER BY created_at) - created_at)) / 3600.0 AS gap_hours,
              created_at
         FROM feed_events
        WHERE client_number = $1 AND user_id = $2 AND sender_email IS NOT NULL
          AND ($4::text IS NULL OR lower(sender_email) <> $4)
          AND created_at >= NOW() - INTERVAL '60 days'
     ),
     stats AS (
       SELECT sender_email,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY gap_hours) AS typical_window,
              COUNT(*) AS n,
              MAX(created_at) AS last_seen
         FROM gaps
        WHERE gap_hours BETWEEN 0 AND 336
        GROUP BY sender_email
       HAVING COUNT(*) >= 5
     )
     SELECT sender_email, typical_window, n, last_seen,
            EXTRACT(EPOCH FROM (NOW() - last_seen)) / 3600.0 AS silence_hours
       FROM stats
      WHERE EXTRACT(EPOCH FROM (NOW() - last_seen)) / 3600.0 > typical_window * $3
      ORDER BY silence_hours DESC
      LIMIT 60`,
    clientNumber, userId, cfg.silence_multiplier, userEmail,
  ).catch(() => [] as any[]);
  diag.silence = { candidates: rows.length, emitted: 0 };

  // Strip noise senders (no-reply, calendar bots, etc.) AND the user's
  // own opt-in exclude list (emails + domains) post-query.
  const config = await loadConfig(clientNumber, userId);
  const userExcludeEmails = new Set((config.excludeSenders?.emails ?? []).map((e) => e.toLowerCase().trim()));
  const userExcludeDomains = new Set((config.excludeSenders?.domains ?? []).map((d) => d.toLowerCase().trim().replace(/^@/, '')));
  const filtered = rows.filter((r) => {
    const e = String(r.sender_email).toLowerCase();
    if (isNoiseSender(e)) return false;
    if (userExcludeEmails.has(e)) return false;
    const dom = e.includes('@') ? e.split('@')[1] : '';
    if (dom && userExcludeDomains.has(dom)) return false;
    return true;
  });

  // Rank by importance × ratio so a 5★ sender outranks a 1★ at same ratio.
  const { getStarsForSender } = await import('../knowledge/entitySweepService');
  const starred = await Promise.all(filtered.map(async (r) => ({
    row: r,
    stars: await getStarsForSender(clientNumber, userId, String(r.sender_email)).catch(() => 0),
  })));
  starred.sort((a, b) => {
    const da = (a.stars * 10) + (Number(a.row.silence_hours) / Number(a.row.typical_window));
    const db = (b.stars * 10) + (Number(b.row.silence_hours) / Number(b.row.typical_window));
    return db - da;
  });

  // Cap to 6 silence flags max per radar — anything more is noise.
  // Users who want to see all silent senders open the Contacts tab
  // and sort by "last seen".
  const top = starred.slice(0, 6);

  const flags: RiskFlag[] = top.map(({ row: r, stars }) => {
    const ratio = Number(r.silence_hours) / Number(r.typical_window);
    let severity: FlagSeverity = ratio >= 6 ? 'high' : ratio >= 4 ? 'medium' : 'low';
    if (stars >= 4) severity = 'high';
    else if (stars === 3 && severity === 'low') severity = 'medium';
    const starHint = stars > 0 ? ` (★${stars}/5)` : '';
    return {
      id: `silence:${r.sender_email}`,
      signal: 'silence',
      severity,
      title: `Unusual silence from ${r.sender_email}${starHint}`,
      reason: `Last contact ${Math.round(Number(r.silence_hours))}h ago; typical window is ~${Math.round(Number(r.typical_window))}h (${ratio.toFixed(1)}× over).`,
      sourceRefs: [{ kind: 'sender', id: r.sender_email }],
      suggestedAction: 'Send a follow-up or check open items with them.',
      rank: 0.4 + Math.min(0.45, ratio / 12) + (stars >= 4 ? 0.15 : 0),
    };
  });
  diag.silence.emitted = flags.length;
  return flags;
}

async function gatherImminence(
  clientNumber: string, userId: number,
  cfg: RiskRadarConfig['signals']['imminence'],
  diag: Record<string, { candidates: number; emitted: number }>,
): Promise<RiskFlag[]> {
  // Three sources of imminence:
  //   1. Open items with due_date in the window
  //   2. Standing instructions with metadata.dueAt in the window
  //   3. Calendar events (gcal | outlook_calendar) starting within the window
  const horizon = cfg.hours_ahead;
  const [dueOpenItems, dueInstructions, upcomingMeetings] = await Promise.all([
    prisma.$queryRawUnsafe<any[]>(
      `SELECT id, item_number AS "itemNumber", title, priority, due_date AS "dueDate"
         FROM open_items
        WHERE client_number = $1 AND user_id = $2
          AND status NOT IN ('CLOSED','INFORMED')
          AND due_date IS NOT NULL
          AND due_date BETWEEN NOW() AND NOW() + (INTERVAL '1 hour' * $3)
        ORDER BY due_date ASC LIMIT 30`,
      clientNumber, userId, horizon,
    ).catch(() => [] as any[]),
    prisma.$queryRawUnsafe<any[]>(
      `SELECT id, title, metadata->>'kind' AS kind, metadata->>'dueAt' AS "dueAt",
              metadata->>'originalText' AS "originalText"
         FROM wiki_pages
        WHERE client_number = $1 AND page_type = 'instruction'
          AND user_id = $2 AND status = 'active'
          AND metadata->>'status' = 'active'
          AND metadata->>'dueAt' IS NOT NULL
          AND (metadata->>'dueAt')::timestamptz BETWEEN NOW() AND NOW() + (INTERVAL '1 hour' * $3)
        ORDER BY (metadata->>'dueAt')::timestamptz ASC LIMIT 30`,
      clientNumber, userId, horizon,
    ).catch(() => [] as any[]),
    // Calendar feed events. Both gcal and outlook_calendar normalize to a
    // payload that includes a `start` ISO timestamp (gcal: event.start.dateTime,
    // outlook: event.start). We read whichever is populated.
    prisma.$queryRawUnsafe<any[]>(
      `SELECT id, source_type AS "sourceType",
              raw_payload->>'subject' AS subject,
              raw_payload->>'summary' AS summary,
              COALESCE(
                raw_payload->'start'->>'dateTime',
                raw_payload->>'start',
                raw_payload->>'startTime'
              ) AS start_ts,
              raw_payload->>'location' AS location,
              raw_payload->'organizer'->>'emailAddress' AS organizer_email
         FROM feed_events
        WHERE client_number = $1 AND user_id = $2
          AND source_type IN ('gcal','outlook_calendar')
          AND status NOT IN ('dlq','skipped')
          AND COALESCE(
                raw_payload->'start'->>'dateTime',
                raw_payload->>'start',
                raw_payload->>'startTime'
              ) IS NOT NULL
          AND (COALESCE(
                 raw_payload->'start'->>'dateTime',
                 raw_payload->>'start',
                 raw_payload->>'startTime'
              ))::timestamptz BETWEEN NOW() AND NOW() + (INTERVAL '1 hour' * $3)
        ORDER BY (COALESCE(
                    raw_payload->'start'->>'dateTime',
                    raw_payload->>'start',
                    raw_payload->>'startTime'
                  ))::timestamptz ASC
        LIMIT 25`,
      clientNumber, userId, horizon,
    ).catch(() => [] as any[]),
  ]);

  diag.imminence = {
    candidates: dueOpenItems.length + dueInstructions.length + upcomingMeetings.length,
    emitted: 0,
  };
  const flags: RiskFlag[] = [];

  for (const r of dueOpenItems) {
    const hoursLeft = Math.max(0, (new Date(r.dueDate).getTime() - Date.now()) / 3600000);
    const severity: FlagSeverity = hoursLeft <= 12 ? 'high' : hoursLeft <= 24 ? 'medium' : 'low';
    flags.push({
      id: `imminence-oi:${r.id}`,
      signal: 'imminence',
      severity,
      title: `Due in ${Math.round(hoursLeft)}h: "${truncate(r.title, 80)}"`,
      reason: `Open item due ${new Date(r.dueDate).toISOString().slice(0, 16).replace('T', ' ')}; priority ${r.priority}.`,
      sourceRefs: [{ kind: 'open_item', id: r.id, label: `#${r.itemNumber}` }],
      rank: 0.5 + Math.min(0.45, (horizon - hoursLeft) / horizon * 0.45),
    });
  }
  for (const r of dueInstructions) {
    const due = new Date(r.dueAt);
    const hoursLeft = Math.max(0, (due.getTime() - Date.now()) / 3600000);
    const severity: FlagSeverity = hoursLeft <= 12 ? 'high' : hoursLeft <= 24 ? 'medium' : 'low';
    flags.push({
      id: `imminence-instr:${r.id}`,
      signal: 'imminence',
      severity,
      title: `Standing instruction due in ${Math.round(hoursLeft)}h`,
      reason: `${r.kind ?? 'todo'}: ${truncate(r.originalText ?? r.title, 140)}`,
      sourceRefs: [{ kind: 'instruction', id: r.id }],
      rank: 0.45 + Math.min(0.45, (horizon - hoursLeft) / horizon * 0.45),
    });
  }
  for (const m of upcomingMeetings) {
    const start = new Date(m.start_ts);
    const hoursLeft = Math.max(0, (start.getTime() - Date.now()) / 3600000);
    const rawTitle = (m.subject || m.summary || '').trim();

    // Skip noise meetings — calendar holds, recurring placeholders, blank
    // entries. These flood the radar with imminent flags that don't carry
    // any decision value. A meeting with attendees + a real title is
    // worth flagging; a "(untitled)" 30-min block isn't.
    if (!rawTitle) continue;
    const lower = rawTitle.toLowerCase();
    if (lower === '(untitled)' || lower === 'untitled' || lower === 'busy' || lower === 'block' || lower === 'hold') continue;

    // Meetings within 12h are high; 12-24h medium; rest low.
    const severity: FlagSeverity = hoursLeft <= 4 ? 'high' : hoursLeft <= 24 ? 'medium' : 'low';
    const where = m.location ? ` · ${m.location}` : '';
    flags.push({
      id: `imminence-meeting:${m.id}`,
      signal: 'imminence',
      severity,
      title: `Meeting in ${Math.round(hoursLeft)}h: "${truncate(rawTitle, 80)}"`,
      reason: `${m.sourceType === 'gcal' ? 'Google' : 'Outlook'} calendar at ${start.toISOString().slice(0, 16).replace('T', ' ')}${where}.`,
      sourceRefs: [{ kind: 'feed_event', id: m.id }],
      suggestedAction: hoursLeft <= 4 ? 'Confirm prep is done.' : undefined,
      rank: 0.55 + Math.min(0.4, (horizon - hoursLeft) / horizon * 0.4),
    });
  }
  diag.imminence.emitted = flags.length;
  return flags;
}

async function gatherCrmStagnation(
  clientNumber: string, _userId: number,
  cfg: RiskRadarConfig['signals']['crm_stagnation'],
  diag: Record<string, { candidates: number; emitted: number }>,
): Promise<RiskFlag[]> {
  // Read Odoo-mirrored opportunities (page_type='project' from odoo_mirror)
  // whose last_updated_at is older than `stagnant_days`. Tenant-shared so
  // every user in the tenant sees them; we don't filter by userId.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, last_updated_at AS "lastUpdatedAt", metadata
       FROM wiki_pages
      WHERE client_number = $1
        AND page_type = 'project'
        AND last_updated_by = 'odoo_mirror'
        AND status = 'active'
        AND last_updated_at < NOW() - (INTERVAL '1 day' * $2)
      ORDER BY last_updated_at ASC LIMIT 25`,
    clientNumber, cfg.stagnant_days,
  ).catch(() => [] as any[]);
  diag.crm_stagnation = { candidates: rows.length, emitted: 0 };

  const flags: RiskFlag[] = rows.map((r) => {
    const days = Math.floor((Date.now() - new Date(r.lastUpdatedAt).getTime()) / 86400000);
    const probability = Number(r.metadata?.probability ?? 0);
    const revenue = Number(r.metadata?.expected_revenue ?? 0);
    const severity: FlagSeverity = (revenue >= 100_000 && probability >= 50) ? 'high' : days >= cfg.stagnant_days * 2 ? 'medium' : 'low';
    return {
      id: `crm-stag:${r.id}`,
      signal: 'crm_stagnation',
      severity,
      title: `Deal stagnant ${days}d: "${truncate(r.title, 80)}"`,
      reason: `Stage "${r.metadata?.odoo_stage ?? 'unknown'}", probability ${probability}%${revenue ? `, value ~${revenue}` : ''}. No update in ${days} days.`,
      sourceRefs: [{ kind: 'wiki_page', id: r.id }],
      suggestedAction: 'Nudge the deal owner or update the stage.',
      rank: 0.4 + Math.min(0.5, days / 60) + (revenue >= 100_000 ? 0.05 : 0),
    };
  });
  diag.crm_stagnation.emitted = flags.length;
  return flags;
}

async function gatherContradictedPages(
  clientNumber: string, userId: number,
  diag: Record<string, { candidates: number; emitted: number }>,
): Promise<RiskFlag[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, page_type AS "pageType", last_updated_at AS "lastUpdatedAt"
       FROM wiki_pages
      WHERE client_number = $1
        AND status IN ('contradicted','stale')
        AND (user_id = $2 OR page_type IN ('org_doc','policy','project','decision','pattern'))
      ORDER BY last_updated_at DESC LIMIT 15`,
    clientNumber, userId,
  ).catch(() => [] as any[]);
  diag.contradicted_pages = { candidates: rows.length, emitted: 0 };

  const flags: RiskFlag[] = rows.map((r) => ({
    id: `contradict:${r.id}`,
    signal: 'contradicted_pages',
    severity: 'medium' as FlagSeverity,
    title: `Wiki page needs attention: "${truncate(r.title, 80)}"`,
    reason: `Status=${r.status ?? 'contradicted'} on ${r.pageType}. Brain may give wrong answers until this is resolved.`,
    sourceRefs: [{ kind: 'wiki_page', id: r.id }],
    suggestedAction: 'Open the page and reconcile or supersede.',
    rank: 0.35,
  }));
  diag.contradicted_pages.emitted = flags.length;
  return flags;
}

/**
 * Tone-shift signal: find senders whose recent messages have been
 * meaningfully more negative than their long-term baseline. Two
 * conditions:
 *   1. ≥ N messages with sentiment_score ≤ -0.3 in the last `lookback_days`
 *   2. The sender's prior baseline (60-day average ex-window) was > 0
 *
 * Hostile-tone events surface immediately regardless of count — one
 * hostile message from a previously-collaborative sender is itself a
 * red flag.
 */
async function gatherToneShift(
  clientNumber: string, userId: number,
  cfg: RiskRadarConfig['signals']['tone_shift'],
  diag: Record<string, { candidates: number; emitted: number }>,
): Promise<RiskFlag[]> {
  const userEmail = await getUserEmail(userId);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `WITH recent AS (
       SELECT sender_email,
              AVG(sentiment_score)::float AS recent_avg,
              COUNT(*) FILTER (WHERE sentiment_score <= -0.3)::int AS negative_count,
              COUNT(*) FILTER (WHERE tone = 'hostile')::int AS hostile_count,
              MAX(sentiment_rationale) AS last_rationale,
              MAX(created_at) AS last_at
         FROM feed_events
        WHERE client_number = $1 AND user_id = $2
          AND sender_email IS NOT NULL
          AND ($5::text IS NULL OR lower(sender_email) <> $5)
          AND sentiment_analyzed_at IS NOT NULL
          AND created_at >= NOW() - (INTERVAL '1 day' * $3)
        GROUP BY sender_email
     ),
     baseline AS (
       SELECT sender_email,
              AVG(sentiment_score)::float AS baseline_avg,
              COUNT(*)::int AS baseline_n
         FROM feed_events
        WHERE client_number = $1 AND user_id = $2
          AND sender_email IS NOT NULL
          AND ($5::text IS NULL OR lower(sender_email) <> $5)
          AND sentiment_analyzed_at IS NOT NULL
          AND created_at >= NOW() - INTERVAL '60 days'
          AND created_at <  NOW() - (INTERVAL '1 day' * $3)
        GROUP BY sender_email
     )
     SELECT r.sender_email, r.recent_avg, r.negative_count, r.hostile_count,
            r.last_rationale, r.last_at,
            COALESCE(b.baseline_avg, 0) AS baseline_avg,
            COALESCE(b.baseline_n, 0)::int AS baseline_n
       FROM recent r
       LEFT JOIN baseline b ON b.sender_email = r.sender_email
      WHERE r.hostile_count > 0
         OR (r.negative_count >= $4
             AND COALESCE(b.baseline_avg, 0) > -0.1)
      ORDER BY r.recent_avg ASC
      LIMIT 30`,
    clientNumber, userId, cfg.lookback_days, cfg.min_negative_count, userEmail,
  ).catch(() => [] as any[]);
  // Strip noise senders (no-reply, calendar bots) AND the user's own
  // exclude list so a hostile-toned bounce or excluded-by-choice sender
  // doesn't masquerade as a relationship at risk.
  const config = await loadConfig(clientNumber, userId);
  const excludeEmails = new Set((config.excludeSenders?.emails ?? []).map((e) => e.toLowerCase().trim()));
  const excludeDomains = new Set((config.excludeSenders?.domains ?? []).map((d) => d.toLowerCase().trim().replace(/^@/, '')));
  const filtered = rows.filter((r) => {
    const e = String(r.sender_email).toLowerCase();
    if (isNoiseSender(e)) return false;
    if (excludeEmails.has(e)) return false;
    const dom = e.includes('@') ? e.split('@')[1] : '';
    if (dom && excludeDomains.has(dom)) return false;
    return true;
  });
  diag.tone_shift = { candidates: filtered.length, emitted: 0 };

  // Bulk-fetch stars for all senders so we can amplify severity for
  // user-rated important contacts. Cap to top 6 to avoid flooding.
  const { getStarsForSender } = await import('../knowledge/entitySweepService');
  const starsMap = new Map<string, number>();
  for (const r of filtered) {
    starsMap.set(r.sender_email, await getStarsForSender(clientNumber, userId, r.sender_email).catch(() => 0));
  }
  // Rank by stars × drop, take top 6.
  const sorted = [...filtered].sort((a, b) => {
    const sa = (starsMap.get(a.sender_email) ?? 0) * 10
      + (Number(a.baseline_avg ?? 0) - Number(a.recent_avg ?? 0));
    const sb = (starsMap.get(b.sender_email) ?? 0) * 10
      + (Number(b.baseline_avg ?? 0) - Number(b.recent_avg ?? 0));
    return sb - sa;
  }).slice(0, 6);

  const flags: RiskFlag[] = sorted.map((r) => {
    const recent = Number(r.recent_avg ?? 0);
    const baseline = Number(r.baseline_avg ?? 0);
    const drop = baseline - recent;
    const hostile = Number(r.hostile_count ?? 0) > 0;
    const stars = starsMap.get(r.sender_email) ?? 0;
    let severity: FlagSeverity = hostile ? 'high' : drop >= 0.6 ? 'high' : drop >= 0.3 ? 'medium' : 'low';
    // Stars-4/5 senders: any tone shift bumps to high severity. Stars-3
    // bumps low → medium. The user explicitly cares about these people.
    if (stars >= 4) severity = 'high';
    else if (stars === 3 && severity === 'low') severity = 'medium';

    const starHint = stars > 0 ? ` (★${stars}/5 importance)` : '';
    const explainer = hostile
      ? `Hostile tone detected from ${r.sender_email}${starHint}.`
      : `${r.sender_email}${starHint}: tone shifted from ${baseline.toFixed(2)} (60d baseline) to ${recent.toFixed(2)} (last ${cfg.lookback_days}d) over ${r.negative_count} negative message${r.negative_count === 1 ? '' : 's'}.`;
    return {
      id: `tone:${r.sender_email}`,
      signal: 'tone_shift',
      severity,
      title: hostile
        ? `Hostile tone from ${r.sender_email}`
        : `${r.sender_email} sounds frustrated`,
      reason: explainer + (r.last_rationale ? ` — "${String(r.last_rationale).slice(0, 140)}"` : ''),
      sourceRefs: [{ kind: 'sender', id: r.sender_email }],
      suggestedAction: hostile ? 'Respond promptly; consider escalation.' : 'Reach out — relationship may need attention.',
      rank: 0.55 + Math.min(0.4, drop) + (hostile ? 0.1 : 0) + (stars >= 4 ? 0.15 : 0),
    };
  });
  diag.tone_shift.emitted = flags.length;
  return flags;
}

async function gatherCustomKeywords(
  clientNumber: string, userId: number,
  cfg: RiskRadarConfig['signals']['custom_keywords'],
  diag: Record<string, { candidates: number; emitted: number }>,
): Promise<RiskFlag[]> {
  if (!cfg.keywords?.length) {
    diag.custom_keywords = { candidates: 0, emitted: 0 };
    return [];
  }
  // Match recent feed events by keyword in subject/preview. Each match
  // is one flag; the user defined the keywords, so confidence is high.
  const orClause = cfg.keywords.map((_, i) => `(raw_payload->>'subject' ILIKE $${i + 3} OR raw_payload->>'preview' ILIKE $${i + 3})`).join(' OR ');
  const args: any[] = [clientNumber, userId, ...cfg.keywords.map((k) => `%${k}%`)];
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, source_type AS "sourceType", sender_email AS "senderEmail",
            raw_payload->>'subject' AS subject,
            created_at AS "createdAt"
       FROM feed_events
      WHERE client_number = $1 AND user_id = $2
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND (${orClause})
      ORDER BY created_at DESC LIMIT 30`,
    ...args,
  ).catch(() => [] as any[]);
  diag.custom_keywords = { candidates: rows.length, emitted: 0 };

  const flags: RiskFlag[] = rows.map((r) => ({
    id: `custom:${r.id}`,
    signal: 'custom_keywords',
    severity: 'medium' as FlagSeverity,
    title: `Watchlist hit: "${truncate(r.subject ?? '(no subject)', 80)}"`,
    reason: `Matched custom keyword in ${r.sourceType} from ${r.senderEmail ?? 'unknown sender'}.`,
    sourceRefs: [{ kind: 'feed_event', id: r.id }],
    rank: 0.55,
  }));
  diag.custom_keywords.emitted = flags.length;
  return flags;
}

// ─── Narration ───────────────────────────────────────────────────

async function narrateFlags(
  clientNumber: string, userId: number,
  flags: RiskFlag[],
): Promise<{ text: string; provider: string; tokensInput: number | null; tokensOutput: number | null }> {
  const lines: string[] = [];
  for (const f of flags.slice(0, 12)) {
    lines.push(`- [${f.severity}] ${f.title} — ${f.reason}`);
  }
  const system = `You are an executive assistant writing the daily risk-radar narration. The user has signed up for this brief. Write 3–5 sentences in plain English summarizing the most important risks and what to do today. Be specific — name the items. Do NOT add risks that aren't in the list. Do NOT pad with generic advice. End with one short imperative if there's a clear next step.`;
  const user = `RISK FLAGS (ranked):\n${lines.join('\n')}`;
  const r = await callLLM(system, user, {
    maxTokens: 400,
    providers: ['gemini-flash', 'gemini', 'claude'],
    userId, clientNumber, purpose: 'risk_radar_narrate',
  });
  return { text: r.text.trim(), provider: r.provider, tokensInput: null, tokensOutput: null };
}

// ─── Helpers ──────────────────────────────────────────────────────

function buildSummary(flags: RiskFlag[], highCount: number): string {
  if (flags.length === 0) return 'No risks flagged today.';
  const top = flags[0];
  if (highCount === 0) return `${flags.length} flag${flags.length === 1 ? '' : 's'} · top: ${top.title}`;
  return `${highCount} high-severity flag${highCount === 1 ? '' : 's'} of ${flags.length} total · top: ${top.title}`;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function emptyResult(clientNumber: string, userId: number, runDate: Date, reason: string): RunResult {
  const dateStr = runDate.toISOString().slice(0, 10);
  log.info('risk radar skipped', { clientNumber, userId, runDate: dateStr, reason });
  return {
    docId: `risk:${clientNumber}:${userId}:${dateStr}`,
    runDate: dateStr,
    flags: [],
    summary: reason,
    narrative: null,
    flagCount: 0,
    highSeverityCount: 0,
    sourceSignals: {},
  };
}

function mergeConfig(input: Partial<RiskRadarConfig> | null): RiskRadarConfig {
  if (!input) return { ...DEFAULT_RADAR_CONFIG };
  const d = DEFAULT_RADAR_CONFIG;
  return {
    enabled: input.enabled ?? d.enabled,
    schedule: input.schedule ?? d.schedule,
    timezone: input.timezone ?? d.timezone,
    deliveryChannel: (input.deliveryChannel ?? d.deliveryChannel) as RiskRadarConfig['deliveryChannel'],
    signals: {
      stagnant_criticality: { ...d.signals.stagnant_criticality, ...(input.signals?.stagnant_criticality ?? {}) },
      decay:                { ...d.signals.decay, ...(input.signals?.decay ?? {}) },
      silence:              { ...d.signals.silence, ...(input.signals?.silence ?? {}) },
      imminence:            { ...d.signals.imminence, ...(input.signals?.imminence ?? {}) },
      crm_stagnation:       { ...d.signals.crm_stagnation, ...(input.signals?.crm_stagnation ?? {}) },
      contradicted_pages:   { ...d.signals.contradicted_pages, ...(input.signals?.contradicted_pages ?? {}) },
      custom_keywords:      { ...d.signals.custom_keywords, ...(input.signals?.custom_keywords ?? {}) },
      tone_shift:           { ...d.signals.tone_shift, ...(input.signals?.tone_shift ?? {}) },
    },
    excludeSenders: {
      emails: Array.isArray(input.excludeSenders?.emails) ? input.excludeSenders!.emails : (d.excludeSenders?.emails ?? []),
      domains: Array.isArray(input.excludeSenders?.domains) ? input.excludeSenders!.domains : (d.excludeSenders?.domains ?? []),
    },
    max_flags: input.max_flags ?? d.max_flags,
    narrate: input.narrate ?? d.narrate,
  };
}
