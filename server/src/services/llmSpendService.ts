/**
 * Nexeo — LLM spend tracker. What the APPLICATION spends on Gemini and Claude through
 * `llmRouter`: triage, criticality, composition. Kept entirely apart from
 * `orchestratorSpendService`, which records what Claude Code bills for BUILDING the product.
 * Two providers, two bills, never summed.
 *
 * WRITE PATH — one row per call, into `llm_spend`, with `est_usd` priced at call time so a later
 * edit to the price table cannot silently rewrite history.
 *
 * READ PATH — every reader goes through the `llm_spend_unified` VIEW, never the table. Two rules
 * come with it and both are load-bearing:
 *
 *   1. `SUM(calls)`, never `COUNT(*)`. A view row over an archived day stands for many calls
 *      (2110 of them on average), so COUNT(*) would count dimension tuples and under-report by
 *      three orders of magnitude — green, plausible, and wrong.
 *   2. The grain is a DAY (`day`, a date), not a timestamp. Fixed calendar ranges are unaffected;
 *      rolling `days = N` windows now cover N WHOLE days rather than cutting the oldest one at
 *      the current clock time.
 *
 * WHY A VIEW AT ALL. `llm_spend` was 2,614,564 rows / 561 MB of an 811 MB database, 91% of it
 * older than 30 days (OPT-001). Raw rows beyond the retention window are collapsed into
 * `llm_spend_daily` — 2,382,156 rows became 1,129, because the dimensions barely vary — and the
 * view serves the rollup for archived days and the table for recent ones.
 *
 * Nothing is DELETED from the record, only collapsed, and that distinction is the whole point.
 * This page's predecessor was a `system_config` JSON blob that pruned to 62 days; when the owner
 * asked for Jan-to-Aug grouped by month he got ONE row, and the blob disagreed with the table by
 * half on the month they both covered ($289.98 vs $587.19). Retention that loses history is how
 * that happened. See `prisma/migrations/20260831_llm_spend_retention/migration.sql`.
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
  /** Source event this call was about, when there is one. See CallLlmOpts. */
  feedEventId?: string | null;
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
        feedEventId: p.feedEventId ?? null,
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
  //
  // DEF-112 — skipped when the call carries no tenant.
  //
  // `clientNumber` above falls back to the string 'SYSTEM', and
  // system_config.client_number has a foreign key to tenants, which holds
  // exactly one row: TMC-0001. So every tenant-less LLM call tried to write a
  // rollup under a tenant that does not exist and failed:
  //
  //   llm-spend: "spend record (legacy) failed"
  //     -> Invalid prisma.systemConfig.upsert()
  //     -> Foreign key constraint violated: system_config_client_number_fkey
  //
  // Observed firing FOUR TIMES in a single owner turn on 2026-08-10
  // (11:39:01, :03, :05, :07 — once per LLM call), all day, every day. It was
  // also the noise that made the FK look like a feature-flag problem when I
  // first met it.
  //
  // Nothing is lost by skipping: write (1) above is the real record and it
  // succeeds. The rollup is a per-TENANT view, and a call with no tenant has
  // no rollup to belong to — writing it under a placeholder was always
  // meaningless, which is why the constraint rejected it.
  // ...and it is GONE as of 2026-08-31, which retires the DEF-112 warning above with it.
  //
  // It was a SECOND COPY OF THE DATA, read-modify-written on every LLM call: load a ~21 KB JSON
  // blob, mutate one counter, write the whole row back, hundreds of times a day. A grep for the
  // `llm_spend` system_config key found exactly one reader — this function, reading what it had
  // just written. Write-only state, paid for per call.
  //
  // It was also the store that UNDER-REPORTED. It pruned to 62 days, so the owner's Jan-to-Aug
  // monthly query returned ONE row, and it disagreed with the table by half on the month they
  // both covered ($289.98 vs $587.19). Its comment said it was "kept until the dashboard cuts
  // over fully" — the dashboard has cut over. Deleting the writer removes the last path by which
  // that halved number can reappear.
  //
  // `llm_spend` (recent, exact) plus `llm_spend_daily` (archived, collapsed) is now the whole
  // record, read through `llm_spend_unified`.
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
    // READS THE VIEW, NOT THE TABLE — see the note above `recordLlmSpend`. SUM(calls), never
    // COUNT(*): one view row stands for many calls on an archived day.
    `SELECT to_char(day, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(calls), 0)::int AS calls,
            COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(est_usd), 0)::numeric AS usd
       FROM llm_spend_unified
      WHERE client_number = $1
        AND day >= (CURRENT_DATE - (INTERVAL '1 day' * $2))::date
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
            COALESCE(SUM(s.calls), 0)::int AS calls,
            COALESCE(SUM(s.input_tokens + s.output_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(s.est_usd), 0)::numeric AS usd
       FROM llm_spend_unified s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.client_number = $1
        AND s.day >= (CURRENT_DATE - (INTERVAL '1 day' * $2))::date
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
            COALESCE(SUM(calls), 0)::int AS calls,
            COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(est_usd), 0)::numeric AS usd
       FROM llm_spend_unified
      WHERE client_number = $1
        AND day >= (CURRENT_DATE - (INTERVAL '1 day' * $2))::date
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
            COALESCE(SUM(calls), 0)::int AS calls,
            COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(est_usd), 0)::numeric AS usd
       FROM llm_spend_unified
      WHERE client_number = $1
        AND day >= (CURRENT_DATE - (INTERVAL '1 day' * $2))::date
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
    // Today is always inside the retention window, so this half is never served by the rollup.
    // The trailing week is whole days by construction now, which is what "daily average"
    // always meant anyway.
    `SELECT
        COALESCE(SUM(CASE WHEN day >= CURRENT_DATE THEN est_usd END), 0)::numeric AS today_usd,
        COALESCE(SUM(CASE WHEN day >= CURRENT_DATE - 7 AND day < CURRENT_DATE THEN est_usd END), 0)::numeric / 7.0 AS trailing_avg
     FROM llm_spend_unified
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
            COALESCE(SUM(calls), 0)::int AS calls,
            COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(est_usd), 0)::numeric AS usd
       FROM llm_spend_unified
      WHERE day >= (CURRENT_DATE - (INTERVAL '1 day' * $1))::date
      GROUP BY client_number
      ORDER BY usd DESC`,
    days,
  ).catch(() => [] as any[]);
  return rows.map((r) => ({
    clientNumber: r.client_number,
    calls: Number(r.calls), tokens: Number(r.tokens), usd: Number(r.usd),
  }));
}

// `safeParse` lived here to decode the legacy system_config JSON blob. The blob's last writer
// and only reader are both gone, so it went with them.

export interface SpendReport {
  clientNumber: string;
  day: string;
  from?: string;
  to?: string;
  days?: number;
  groupBy?: 'day' | 'week' | 'month';
  series?: Array<{ bucket: string; label: string; calls: number;
                   inTokens: number; outTokens: number; tokens: number; usd: number;
                   byUser: Array<{ userId: number; calls: number; tokens: number; usd: number }> }>;
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

/**
 * A report over ONE day or a RANGE of days.
 *
 * `from`/`to` are inclusive `YYYY-MM-DD`. Omitted, both default to today, which is exactly the
 * previous single-day behaviour — every existing caller keeps working unchanged.
 *
 * Days are aggregated per user, per provider and per purpose, and a per-day series is returned
 * alongside so a range can be drawn rather than only totalled. Days with no activity are omitted
 * from the series rather than emitted as zeros: a quiet Sunday and a day before the connector
 * existed are different facts, and only the caller knows which it is looking at.
 */
export async function getSpendReport(
  clientNumber: string,
  from: string = today(),
  to: string = from,
  groupBy: 'day' | 'week' | 'month' = 'day',
): Promise<SpendReport> {
  // READS `llm_spend`, THE REAL TABLE — not the system_config JSON blob this used to read.
  //
  // Owner, 2026-08-27, on a Jan-to-Aug range grouped by month, seeing ONE row: "i am expecting to
  // see for each month like Jan-26 Feb-26 Mar-26 Apr-26 etc". The months were never missing from
  // the grouping — the blob prunes to 62 days, so everything older had already been deleted.
  //
  // `llm_spend` holds 2,608,934 rows back to 2026-05-03, one per call, with est_usd computed at
  // call time. The two stores also DISAGREED about the month they both covered — blob 54,099
  // calls / $289.98 against table 233,928 / $587.19 — so this page had been under-reporting spend
  // by roughly half. A row per call with a stored cost is the trustworthy one.
  //
  // Cost is SUM(est_usd), not recomputed from tokens: it was priced when the call was made, so a
  // later edit to the price table cannot silently rewrite history.
  const lo = from <= to ? from : to;
  const hi = from <= to ? to : from;
  // `lo`/`hi` are passed as dates now. They used to be widened to
  // `${lo} 00:00:00` / `${hi} 23:59:59.999` for a timestamp comparison against `created_at`;
  // the view is day-grain, so the date bounds cover the identical span with no fencepost to get
  // wrong. The old millisecond-precision upper bound was itself a latent gap — a call landing in
  // the final half-millisecond of the range was excluded.

  // date_trunc('week') is ISO — it starts MONDAY, which is what the route's period boundaries
  // use. The two must agree, or a Week row and the Week button cover different days.
  const trunc = groupBy === 'month' ? 'month' : groupBy === 'week' ? 'week' : 'day';

  const rows: any[] = await prisma.$queryRawUnsafe<any[]>(
    // EXACTLY equivalent to the old raw-table query, and that matters more here than anywhere
    // else in this file. `loTs`/`hiTs` already spanned whole days (00:00:00 → 23:59:59.999), so
    // `day BETWEEN lo AND hi` covers the identical set of calls — no boundary shifts on the page
    // OPT-001 is named after. Verified against a pre-refactor snapshot across seven windows,
    // including three that straddle the retention cutoff.
    `SELECT to_char(date_trunc('${trunc}', day), 'YYYY-MM-DD') AS bucket,
            user_id,
            COALESCE(SUM(calls), 0)::int            AS calls,
            COALESCE(SUM(input_tokens), 0)::bigint  AS in_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint AS out_tokens,
            COALESCE(SUM(est_usd), 0)::float8       AS usd
       FROM llm_spend_unified
      WHERE client_number = $1 AND day >= $2::date AND day <= $3::date
      GROUP BY 1, 2
      ORDER BY 1`,
    clientNumber, lo, hi,
  ).catch(() => [] as any[]);

  const providerRows: any[] = await prisma.$queryRawUnsafe<any[]>(
    `SELECT user_id, provider,
            COALESCE(SUM(calls), 0)::int AS calls,
            COALESCE(SUM(input_tokens), 0)::bigint  AS in_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint AS out_tokens
       FROM llm_spend_unified
      WHERE client_number = $1 AND day >= $2::date AND day <= $3::date
      GROUP BY 1, 2`,
    clientNumber, lo, hi,
  ).catch(() => [] as any[]);

  const purposeRows: any[] = await prisma.$queryRawUnsafe<any[]>(
    `SELECT user_id, COALESCE(purpose, 'unknown') AS purpose, COALESCE(SUM(calls), 0)::int AS calls
       FROM llm_spend_unified
      WHERE client_number = $1 AND day >= $2::date AND day <= $3::date
      GROUP BY 1, 2`,
    clientNumber, lo, hi,
  ).catch(() => [] as any[]);

  const labelFor = (bucket: string) => {
    if (groupBy === 'month') return bucket.slice(0, 7);
    if (groupBy === 'week') {
      const endD = new Date(`${bucket}T00:00:00Z`);
      endD.setUTCDate(endD.getUTCDate() + 6);
      return `${bucket} → ${endD.toISOString().slice(0, 10)}`;
    }
    return bucket;
  };

  const buckets = new Map<string, NonNullable<SpendReport['series']>[number]>();
  const perUser = new Map<number, { calls: number; tokens: number; usd: number }>();
  let totCalls = 0, totTokens = 0, totUsd = 0;

  for (const r of rows) {
    const uid = Number(r.user_id ?? 0);
    const inT = Number(r.in_tokens);
    const outT = Number(r.out_tokens);
    const usd = Number(r.usd);
    const acc = buckets.get(r.bucket) ?? {
      bucket: r.bucket, label: labelFor(r.bucket),
      calls: 0, inTokens: 0, outTokens: 0, tokens: 0, usd: 0,
      byUser: [] as NonNullable<SpendReport['series']>[number]['byUser'],
    };
    acc.calls += r.calls;
    acc.inTokens += inT;
    acc.outTokens += outT;
    acc.tokens += inT + outT;
    acc.usd += usd;
    acc.byUser.push({ userId: uid, calls: r.calls, tokens: inT + outT, usd: Math.round(usd * 10000) / 10000 });
    buckets.set(r.bucket, acc);

    const u = perUser.get(uid) ?? { calls: 0, tokens: 0, usd: 0 };
    u.calls += r.calls; u.tokens += inT + outT; u.usd += usd;
    perUser.set(uid, u);

    totCalls += r.calls; totTokens += inT + outT; totUsd += usd;
  }

  const series = [...buckets.values()]
    .sort((a, b) => (a.bucket < b.bucket ? -1 : 1))
    .map((b) => ({ ...b, usd: Math.round(b.usd * 10000) / 10000, byUser: b.byUser.sort((x, y) => y.usd - x.usd) }));

  const users: SpendReport['users'] = [...perUser.entries()].map(([userId, u]) => {
    const providers: SpendReport['users'][number]['providers'] = {};
    for (const pr of providerRows.filter((x) => Number(x.user_id ?? 0) === userId)) {
      providers[pr.provider] = { in: Number(pr.in_tokens), out: Number(pr.out_tokens), calls: pr.calls };
    }
    const byPurpose: Record<string, number> = {};
    for (const pu of purposeRows.filter((x) => Number(x.user_id ?? 0) === userId)) {
      byPurpose[pu.purpose] = pu.calls;
    }
    return {
      userId,
      providers,
      totalCalls: u.calls,
      totalTokens: u.tokens,
      estimatedCostUsd: Math.round(u.usd * 10000) / 10000,
      byPurpose,
    };
  }).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);

  return {
    clientNumber,
    day: lo === hi ? lo : `${lo} → ${hi}`,
    from: lo, to: hi, days: series.length, groupBy, series,
    users,
    totals: { calls: totCalls, tokens: totTokens, usd: Math.round(totUsd * 10000) / 10000 },
  };
}

/**
 * Retention sweep — collapse raw calls older than `retainDays` into `llm_spend_daily`, then
 * delete them. OPT-001.
 *
 * ROLL UP FIRST, DELETE SECOND, ONE TRANSACTION. If the delete could ever run without the
 * insert, that day's spend would be gone from the record — which is the defect this whole design
 * exists to avoid, not a smaller version of it. The two statements share a transaction so a
 * failure between them rolls the delete back.
 *
 * The transaction is belt to the view's braces rather than the only guard: `llm_spend_unified`
 * serves a day from the rollup once it exists there, whether or not the raw rows are gone. So a
 * crash after the insert leaves totals correct and merely leaves rows to delete next time, and
 * re-running is always safe.
 *
 * SPACE IS NOT RETURNED TO THE OS BY THIS. A DELETE marks tuples dead and autovacuum makes the
 * space reusable by future inserts, which is what stops the table growing without bound — the
 * actual goal here. Shrinking the file on disk needs VACUUM FULL, which takes an ACCESS
 * EXCLUSIVE lock and is therefore deliberately NOT run from a recurring job. It was run once by
 * hand for the initial 561 MB reclaim.
 */
export async function sweepLlmSpendRetention(
  retainDays = Number(process.env.LLM_SPEND_RETAIN_DAYS ?? 30),
): Promise<{ rolledRows: number; deletedRows: number; cutoff: string }> {
  // A day is the unit, so the cutoff is a DATE. Using a timestamp would let half of the boundary
  // day be rolled up while the other half stayed raw, and the view — which resolves a whole day
  // to the rollup the moment it appears there — would then hide the raw half. Whole days only.
  const days = Number.isFinite(retainDays) && retainDays >= 1 ? Math.floor(retainDays) : 30;

  try {
    const [rolled, deleted] = await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `INSERT INTO llm_spend_daily
               (day, client_number, user_id, provider, model, purpose,
                calls, input_tokens, output_tokens, est_usd)
         SELECT date_trunc('day', created_at)::date,
                client_number, user_id, provider, model, purpose,
                COUNT(*)::int,
                COALESCE(SUM(input_tokens), 0)::bigint,
                COALESCE(SUM(output_tokens), 0)::bigint,
                COALESCE(SUM(est_usd), 0)::numeric(14,6)
           FROM llm_spend
          WHERE created_at < (CURRENT_DATE - (INTERVAL '1 day' * ${days}))
          GROUP BY 1, 2, 3, 4, 5, 6
             ON CONFLICT (day, client_number, user_id, provider, model, purpose) DO UPDATE
            SET calls         = EXCLUDED.calls,
                input_tokens  = EXCLUDED.input_tokens,
                output_tokens = EXCLUDED.output_tokens,
                est_usd       = EXCLUDED.est_usd,
                rolled_at     = now()`,
      ),
      prisma.$executeRawUnsafe(
        `DELETE FROM llm_spend WHERE created_at < (CURRENT_DATE - (INTERVAL '1 day' * ${days}))`,
      ),
    ]);

    const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    if (rolled > 0 || deleted > 0) {
      log.info('llm_spend retention swept', { rolledRows: rolled, deletedRows: deleted, cutoff, retainDays: days });
    }
    return { rolledRows: rolled, deletedRows: deleted, cutoff };
  } catch (err: any) {
    // Never throw into the caller's job loop: a failed sweep must leave the data untouched and
    // be visible, not take down the pass it runs on.
    log.warn('llm_spend retention sweep failed — nothing rolled or deleted', { error: err?.message });
    return { rolledRows: 0, deletedRows: 0, cutoff: '' };
  }
}
