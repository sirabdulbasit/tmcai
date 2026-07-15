/**
 * MyOS — LLM spend tracker.
 *
 * Logs every LLM call's token usage per (user, purpose, provider) into
 * system_config as a compact daily rollup. Admins can read it via
 * /admin/llm-spend to spot runaway costs, rate-limited users, or users
 * hitting thresholds.
 *
 * Why system_config (not a dedicated table): avoids a migration for a
 * POC; the JSON structure is tiny (<10KB per tenant per day) and reads
 * are rare. If spend analysis becomes central later, promote to a real
 * `llm_spend_daily` table.
 *
 * Shape stored at system_config.value (JSON):
 *   {
 *     "2026-04-22": {
 *       "5": {                        // userId
 *         "gemini":       { in: 12345, out: 678, calls: 42 },
 *         "gemini-flash": { in: ..., out: ..., calls: ... },
 *         "claude":       { in: ..., out: ..., calls: ... },
 *         "byPurpose": { "triage": 12, "chat": 5, ... }
 *       }
 *     }
 *   }
 *   Keyed at system_config.key = 'llm_spend'.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('llm-spend');

type Provider = 'claude' | 'gemini' | 'gemini-flash';

interface SpendParams {
  provider: Provider;
  userId?: number;
  clientNumber?: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
}

// Gemini Flash pricing (per Feb 2026 published rates, USD per 1M tokens):
//   Flash: $0.075 in, $0.30 out
//   Pro:   $1.25 in, $5.00 out
//   Claude Haiku: ~$0.25 in, $1.25 out (close enough for estimation)
const PRICE_PER_M = {
  'gemini-flash': { in: 0.075, out: 0.30 },
  'gemini':       { in: 1.25,  out: 5.00 },
  'claude':       { in: 0.25,  out: 1.25 },
} as const;

export function estimatedCostUsd(p: SpendParams): number {
  const rate = PRICE_PER_M[p.provider];
  if (!rate) return 0;
  return (p.inputTokens / 1_000_000) * rate.in + (p.outputTokens / 1_000_000) * rate.out;
}

function today(): string { return new Date().toISOString().slice(0, 10); }

export async function recordLlmSpend(p: SpendParams): Promise<void> {
  const clientNumber = p.clientNumber ?? 'SYSTEM';
  const userKey = String(p.userId ?? 0);
  const day = today();
  const usd = estimatedCostUsd(p);

  // 1) New time-series row in `llm_spend` (cost dashboard reads from
  //    here; supports timeline, top-N, anomaly, brain-doc cost).
  try {
    await prisma.llmSpend.create({
      data: {
        clientNumber,
        userId: p.userId ?? null,
        provider: p.provider,
        purpose: p.purpose,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        estUsd: usd,
        success: true,
      },
    });
  } catch (err: any) {
    log.warn('llm_spend row insert failed', { error: err.message });
  }

  // 2) Legacy daily JSON rollup in `system_config`. Kept until the
  //    dashboard cuts over fully; lets `getSpendReport` (which existing
  //    /admin/llm-spend depends on) keep working without breakage.
  try {
    const existing = await prisma.systemConfig.findUnique({
      where: { clientNumber_key: { clientNumber, key: 'llm_spend' } },
      select: { value: true },
    }).catch(() => null);

    const db: any = existing?.value ? safeParse(existing.value) : {};
    if (!db[day]) db[day] = {};
    if (!db[day][userKey]) db[day][userKey] = { byPurpose: {} };
    const bucket = db[day][userKey];
    if (!bucket[p.provider]) bucket[p.provider] = { in: 0, out: 0, calls: 0 };
    bucket[p.provider].in += p.inputTokens;
    bucket[p.provider].out += p.outputTokens;
    bucket[p.provider].calls += 1;
    bucket.byPurpose[p.purpose] = (bucket.byPurpose[p.purpose] ?? 0) + 1;

    // Prune any day older than 14 days to keep the blob small.
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const d of Object.keys(db)) {
      if (d < cutoff) delete db[d];
    }

    await prisma.systemConfig.upsert({
      where: { clientNumber_key: { clientNumber, key: 'llm_spend' } },
      create: { clientNumber, key: 'llm_spend', value: JSON.stringify(db) },
      update: { value: JSON.stringify(db) },
    });
  } catch (err: any) {
    log.warn('spend record (legacy) failed', { error: err.message });
  }
}

// ─── Cost dashboard aggregations ──────────────────────────────────
//
// All queries scope by clientNumber so multi-tenant isolation is
// preserved. Time windows are inclusive of `since`. Empty result sets
// return [] / { totals: { … } } cleanly.

export interface TimelinePoint {
  day: string;          // YYYY-MM-DD
  calls: number;
  tokens: number;
  usd: number;
}

/** Daily timeseries for the last N days (default 30). Front-end renders
 *  this as a stacked bar / line chart on the dashboard. */
export async function getTimeline(clientNumber: string, days = 30): Promise<TimelinePoint[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(est_usd), 0)::numeric AS usd
       FROM llm_spend
      WHERE client_number = $1
        AND created_at >= NOW() - (INTERVAL '1 day' * $2)
      GROUP BY 1
      ORDER BY 1 ASC`,
    clientNumber, days,
  ).catch(() => [] as any[]);
  return rows.map((r) => ({
    day: r.day,
    calls: Number(r.calls),
    tokens: Number(r.tokens),
    usd: Number(r.usd),
  }));
}

export interface BreakdownRow {
  key: string;        // user/purpose/provider
  label?: string;
  calls: number;
  tokens: number;
  usd: number;
}

/** Top-N users by spend. Joined with user.name for display. */
export async function getByUser(clientNumber: string, days = 30, limit = 10): Promise<BreakdownRow[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT s.user_id::text AS key,
            COALESCE(u.name, '(deleted)') AS label,
            COUNT(*)::int AS calls,
            COALESCE(SUM(s.input_tokens + s.output_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(s.est_usd), 0)::numeric AS usd
       FROM llm_spend s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.client_number = $1
        AND s.created_at >= NOW() - (INTERVAL '1 day' * $2)
        AND s.user_id IS NOT NULL
      GROUP BY s.user_id, u.name
      ORDER BY usd DESC
      LIMIT $3`,
    clientNumber, days, limit,
  ).catch(() => [] as any[]);
  return rows.map((r) => ({
    key: r.key, label: r.label,
    calls: Number(r.calls), tokens: Number(r.tokens), usd: Number(r.usd),
  }));
}

export async function getByPurpose(clientNumber: string, days = 30, limit = 10): Promise<BreakdownRow[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COALESCE(purpose, '(unknown)') AS key,
            COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(est_usd), 0)::numeric AS usd
       FROM llm_spend
      WHERE client_number = $1
        AND created_at >= NOW() - (INTERVAL '1 day' * $2)
      GROUP BY 1
      ORDER BY usd DESC
      LIMIT $3`,
    clientNumber, days, limit,
  ).catch(() => [] as any[]);
  return rows.map((r) => ({
    key: r.key,
    calls: Number(r.calls), tokens: Number(r.tokens), usd: Number(r.usd),
  }));
}

export async function getByProvider(clientNumber: string, days = 30): Promise<BreakdownRow[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT provider AS key,
            COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(est_usd), 0)::numeric AS usd
       FROM llm_spend
      WHERE client_number = $1
        AND created_at >= NOW() - (INTERVAL '1 day' * $2)
      GROUP BY 1
      ORDER BY usd DESC`,
    clientNumber, days,
  ).catch(() => [] as any[]);
  return rows.map((r) => ({
    key: r.key,
    calls: Number(r.calls), tokens: Number(r.tokens), usd: Number(r.usd),
  }));
}

/**
 * Anomaly check: today's spend vs trailing 7-day daily average. Returns
 * { multiple } where 1.0 = normal, 3.0 = today is 3× the trailing avg.
 * Surfaces a red banner on the dashboard when multiple > 2.5.
 */
export async function getAnomaly(clientNumber: string): Promise<{ today: number; trailingAvg: number; multiple: number }> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT
        COALESCE(SUM(CASE WHEN created_at >= date_trunc('day', NOW()) THEN est_usd END), 0)::numeric AS today_usd,
        COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' AND created_at < date_trunc('day', NOW()) THEN est_usd END), 0)::numeric / 7.0 AS trailing_avg
     FROM llm_spend
     WHERE client_number = $1`,
    clientNumber,
  ).catch(() => [{ today_usd: 0, trailing_avg: 0 }] as any[]);
  const today = Number(rows[0]?.today_usd ?? 0);
  const avg = Number(rows[0]?.trailing_avg ?? 0);
  const multiple = avg > 0.001 ? today / avg : 0;
  return { today, trailingAvg: avg, multiple };
}

/** Cross-tenant rollup — SuperAdmin only. Used for billing prep + spotting
 *  which tenant runaway-loops first. */
export async function getPerTenant(days = 30): Promise<Array<{ clientNumber: string; calls: number; tokens: number; usd: number }>> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT client_number,
            COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(est_usd), 0)::numeric AS usd
       FROM llm_spend
      WHERE created_at >= NOW() - (INTERVAL '1 day' * $1)
      GROUP BY client_number
      ORDER BY usd DESC`,
    days,
  ).catch(() => [] as any[]);
  return rows.map((r) => ({
    clientNumber: r.client_number,
    calls: Number(r.calls), tokens: Number(r.tokens), usd: Number(r.usd),
  }));
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return {}; } }

export interface SpendReport {
  clientNumber: string;
  day: string;
  users: Array<{
    userId: number;
    providers: Record<string, { in: number; out: number; calls: number }>;
    totalCalls: number;
    totalTokens: number;
    estimatedCostUsd: number;
    byPurpose: Record<string, number>;
  }>;
  totals: { calls: number; tokens: number; usd: number };
}

export async function getSpendReport(clientNumber: string, day: string = today()): Promise<SpendReport> {
  const cfg = await prisma.systemConfig.findUnique({
    where: { clientNumber_key: { clientNumber, key: 'llm_spend' } },
    select: { value: true },
  }).catch(() => null);
  const db: any = cfg?.value ? safeParse(cfg.value) : {};
  const dayBucket: any = db[day] ?? {};
  const users: SpendReport['users'] = [];
  let totCalls = 0, totTokens = 0, totUsd = 0;

  for (const uid of Object.keys(dayBucket)) {
    const u = dayBucket[uid];
    const providers: SpendReport['users'][number]['providers'] = {};
    let userCalls = 0, userTokens = 0, userUsd = 0;
    for (const provider of ['gemini', 'gemini-flash', 'claude'] as const) {
      const b = u[provider];
      if (!b) continue;
      providers[provider] = { in: b.in, out: b.out, calls: b.calls };
      userCalls += b.calls;
      userTokens += (b.in + b.out);
      userUsd += estimatedCostUsd({ provider, inputTokens: b.in, outputTokens: b.out, purpose: '', userId: 0 });
    }
    users.push({
      userId: Number(uid),
      providers,
      totalCalls: userCalls,
      totalTokens: userTokens,
      estimatedCostUsd: Math.round(userUsd * 10000) / 10000,
      byPurpose: u.byPurpose ?? {},
    });
    totCalls += userCalls; totTokens += userTokens; totUsd += userUsd;
  }

  users.sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
  return {
    clientNumber, day, users,
    totals: { calls: totCalls, tokens: totTokens, usd: Math.round(totUsd * 10000) / 10000 },
  };
}
