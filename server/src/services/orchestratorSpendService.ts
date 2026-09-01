/**
 * Build & Heal spend — what the ORCHESTRATOR costs, kept apart from llm_spend.
 *
 * TWO BUDGETS. `llmSpendService` records what the APPLICATION spends on Gemini and Claude
 * through `llmRouter` — triage, criticality, composition — billed by those providers. This
 * service records what the ORCHESTRATOR spends on Claude Code: the Brain Builder seat, the
 * chat analyst, the reviewer. Different provider, different bill. They are never summed.
 *
 * WHY THIS INGESTS RATHER THAN READS. The jsonl logs are the only record of the build seat's
 * $606.18, and they are not durable: every `retired-*` directory from the four orchestrator
 * resets contains zero jsonl, and iteration numbers recycle (92 files carry 39 distinct
 * numbers spanning 0..99). Ingesting into a table rescues the history that survives and stops
 * the next reset from taking it.
 */
import { createHash } from 'crypto';
import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('orchestrator-spend');

/** Where the loop writes its per-run event streams. */
const LOGS_DIR = join(__dirname, '..', '..', 'docs', 'orchestrator', 'logs');

/** File suffix → the seat it belongs to. `chat` is the healing analyst. */
const SEAT_BY_SUFFIX: Record<string, string> = {
  build: 'build',
  chat: 'heal',
  review: 'review',
  score: 'score',
};

/**
 * Which run logs this service reads.
 *
 * TWO SHAPES, ONE PARSER. The loop writes `iter-NN-<seat>.jsonl` per iteration. The chat
 * analyst ALSO runs standalone from the ten-minute cron (`run-chat-analysis.sh`), outside any
 * iteration, and names its stream by timestamp instead — there is no iteration to number it
 * with. Both are `--output-format stream-json`, so both parse identically; only the filename
 * differs, and the second pattern is the only reason the every-ten-minutes cron can be
 * measured at all.
 */
const ITER_LOG = /^iter-\d+-.+\.jsonl$/;
const CHAT_LOG = /^chat-analysis-\d{8}T\d{6}\.jsonl$/;
const isRunLog = (f: string) => ITER_LOG.test(f) || CHAT_LOG.test(f);

/**
 * Tokens the orchestrator adds per 1 percentage point of the SEVEN-DAY subscription window.
 *
 * MEASURED ON THIS BOX, not taken from documentation. Six consecutive `rate_limit_info`
 * readings on 2026-08-17/18 ticked utilisation up a point at a time; the tokens we spent
 * between each pair were 15.9M, 14.4M, 13.9M, 13.5M and 16.1M (a sixth reading jumped two
 * points at once and was dropped as a rounding artefact). Mean ~14.8M, spread under ±10%.
 *
 * IT TRACKS TOTAL TOKENS. Output tokens across the same readings ranged 19.5k to 37.1k — very
 * nearly 2x — so output is not what the limit counts. Cache reads dominate the total and
 * evidently count toward the window.
 *
 * A MARGINAL RATE, NOT A QUOTA, and the deck must never present it as one. This is what WE
 * add; the baseline utilisation (78% at the first reading) belongs to everything else on the
 * same subscription, the owner's own Claude Code sessions included. Anthropic does not publish
 * the window size, so "X of Y tokens remaining" would be invented. A share of the window is
 * the strongest claim the data actually supports.
 *
 * Re-derive it if the plan changes: the readings are in the `iter-*-build.jsonl` streams.
 */
const TOKENS_PER_POINT = 14_800_000;

/**
 * When is a bucket's consumption safe? CALIBRATED FROM THE THREE WEEKS ON RECORD, not chosen.
 *
 *   week of 08-31   ~1.0% of the 7-day window   no warnings at all
 *   week of 08-24   ~9.8%                       peak utilisation 93%, ONE RUN REJECTED
 *   week of 08-17  ~15.4%                       utilisation climbed 78->85%, 12 warnings
 *
 * So ~10% is NOT safe — it is the week that got throttled. The bands are set below that
 * rather than around it. Three weeks is thin evidence and these will want revisiting, which
 * is why they live here as named constants with their derivation attached.
 *
 * A bucket is normalised to a WEEKLY EQUIVALENT before it is judged, so a day, a week and a
 * month are all measured against the same seven-day window the subscription actually uses.
 * Comparing a month's raw total to a week's would flag every month and no day.
 */
const SHARE_SAFE_BELOW = 5;    // % of a 7-day window, weekly-equivalent
const SHARE_WATCH_BELOW = 12;

export type SpendVerdict = 'safe' | 'watch' | 'high';
const verdictFor = (sharePoints: number | null): SpendVerdict | null =>
  sharePoints == null ? null
    : sharePoints < SHARE_SAFE_BELOW ? 'safe'
      : sharePoints < SHARE_WATCH_BELOW ? 'watch' : 'high';

/**
 * Calendar days a bucket covers, counting only days that have HAPPENED.
 *
 * The current day/week/month is incomplete, and dividing a part-week's tokens by seven would
 * report it as comfortably safe right up until the moment it is not. Elapsed days is the
 * honest denominator; a finished bucket uses its full length.
 */
function bucketElapsedDays(bucket: string, groupBy: 'day' | 'week' | 'month', now = new Date()): number {
  const start = new Date(`${bucket}T00:00:00Z`);
  const full = groupBy === 'day' ? 1
    : groupBy === 'week' ? 7
      : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsed = Math.floor((now.getTime() - start.getTime()) / 86400_000) + 1;
  return Math.max(1, Math.min(full, elapsed));
}

/**
 * What launched a run, read from the `.trigger` sidecar the launching script writes.
 *
 * RECORDED, NEVER INFERRED. A `build` row can come from the nightly cron or from someone
 * running nexeo-loop.sh by hand, and those are different budgets for the same seat — so the
 * seat cannot imply the schedule. When no sidecar exists the run predates trigger recording
 * and the answer is `null`, which the deck shows as "unattributed". Defaulting to `manual`
 * here would turn 42 unknown historical runs into a confident wrong answer.
 */
async function readTrigger(dir: string, fileName: string): Promise<string | null> {
  try {
    const raw = await readFile(join(dir, `${fileName.replace(/\.jsonl$/, '')}.trigger`), 'utf-8');
    const t = raw.trim().slice(0, 48);
    return t || null;
  } catch { return null; }
}

export interface OrchestratorRun {
  runUid: string;
  seat: string;
  iteration: number | null;
  sessionId: string | null;
  model: string | null;
  startedAt: Date;
  durationMs: number | null;
  numTurns: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number;
  subtype: string | null;
  sourceFile: string;
  /** What launched the run. `null` = unattributed, never "manual". See `readTrigger`. */
  triggeredBy: string | null;
  /**
   * The subscription-limit state the CLI reported as this run ended.
   *
   * `utilization` is NULL unless the window passed its 0.75 warning threshold — the CLI simply
   * does not send a number below that. So null means "not reported", which on an `allowed` row
   * means "below the threshold" and NEVER means zero. Anything that renders it must say so.
   */
  limitStatus: string | null;
  limitType: string | null;
  limitUtilization: number | null;
  limitResetsAt: Date | null;
}

/**
 * Reduce one jsonl event stream to a single run record.
 *
 * Returns null when the file carries no usage at all. That is the NORMAL case for the healing
 * analyst today: it runs with `--output-format text`, so its `iter-*-chat.jsonl` files hold no
 * usage events and there is nothing to record. A zero row would be a lie — it would read as
 * "healing was free" rather than "healing was never measured" — so nothing is written.
 */
export function parseRunLog(
  text: string,
  fileName: string,
  mtime: Date,
  triggeredBy: string | null = null,
): OrchestratorRun | null {
  // The standalone analyst has no iteration to be numbered by — it is fired by the ten-minute
  // cron between iterations — so it is recognised by name and pinned to the `heal` seat.
  const standalone = CHAT_LOG.test(fileName);
  const suffix = fileName.match(/^iter-\d+-(.+)\.jsonl$/)?.[1] ?? '';
  const seat = standalone ? 'heal' : SEAT_BY_SUFFIX[suffix];
  if (!seat) return null;

  const iterMatch = fileName.match(/^iter-(\d+)-/);
  const iteration = iterMatch ? Number(iterMatch[1]) : null;

  let sessionId: string | null = null;
  let model: string | null = null;
  let durationMs: number | null = null;
  let numTurns: number | null = null;
  let subtype: string | null = null;
  let cost = 0;
  // Two competing accountings, kept apart on purpose — see the choice made below.
  let turnIn = 0; let turnOut = 0; let turnCacheCreate = 0; let turnCacheRead = 0;
  let resultUsage: any = null;
  let sawUsage = false;
  let firstTs: string | null = null;
  // LAST one wins. `rate_limit_info` rides on many events through a run and the window moves
  // while the run is in flight — utilisation climbs, and a five-hour window can reset mid-run.
  // The parting state is the one worth keeping: it is what was true when the run stopped, and
  // it is what predicts whether the NEXT run will be throttled.
  let rateLimit: any = null;

  const usageOf = (ev: any) => {
    const u = ev?.usage ?? ev?.message?.usage;
    return u && typeof u === 'object' ? u : null;
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;

    if (!sessionId && typeof ev.session_id === 'string') sessionId = ev.session_id;
    if (!model && typeof ev.model === 'string') model = ev.model;
    if (!firstTs && typeof ev.timestamp === 'string') firstTs = ev.timestamp;
    if (ev.rate_limit_info && typeof ev.rate_limit_info === 'object') rateLimit = ev.rate_limit_info;

    const usage = usageOf(ev);
    if (usage) {
      sawUsage = true;
      turnIn += Number(usage.input_tokens) || 0;
      turnOut += Number(usage.output_tokens) || 0;
      turnCacheCreate += Number(usage.cache_creation_input_tokens) || 0;
      turnCacheRead += Number(usage.cache_read_input_tokens) || 0;
    }

    // The `result` event is the run's own summary. Cost is taken from it verbatim — it is the
    // CLI's accounting, and recomputing from tokens would let a later rate change rewrite
    // history. A stream can carry more than one result on a retry; the last one wins.
    if (ev.type === 'result') {
      if (typeof ev.total_cost_usd === 'number') cost = ev.total_cost_usd;
      if (typeof ev.num_turns === 'number') numTurns = ev.num_turns;
      if (typeof ev.duration_ms === 'number') durationMs = ev.duration_ms;
      if (typeof ev.subtype === 'string') subtype = ev.subtype;
      if (typeof ev.session_id === 'string') sessionId = ev.session_id;
      if (usage) resultUsage = usage;
    }
  }

  if (!sawUsage && cost === 0) return null;

  // THE RESULT EVENT'S USAGE IS THE RUN TOTAL — do not add the per-turn events to it, and do not
  // use them instead of it. Measured across all 92 logs on this host, 2026-08-28:
  //
  //     summing every usage event   1,284,494,419 tokens
  //     the result events alone       566,360,440 tokens   ← matches `total_cost_usd`
  //
  // A 2.27× overstatement, almost all of it cache reads (1.034B vs 363M), because a streamed
  // assistant message re-reports the context its turn read and the result then restates the run.
  // The cost column comes from this same event, so taking tokens from anywhere else would put a
  // bill next to a token count that could not have produced it.
  //
  // The per-turn sum is the FALLBACK, used only when a run was cut off before it emitted a
  // result (2 of the 92). Partial totals then, but real ones, and better than dropping the run.
  const inTok = resultUsage ? Number(resultUsage.input_tokens) || 0 : turnIn;
  const outTok = resultUsage ? Number(resultUsage.output_tokens) || 0 : turnOut;
  const cacheCreate = resultUsage ? Number(resultUsage.cache_creation_input_tokens) || 0 : turnCacheCreate;
  const cacheRead = resultUsage ? Number(resultUsage.cache_read_input_tokens) || 0 : turnCacheRead;

  // File mtime is the fallback start time. The stream's own timestamps are preferred when
  // present, because a file copied or touched later would otherwise land in the wrong day.
  const startedAt = firstTs ? new Date(firstTs) : mtime;
  const when = Number.isNaN(startedAt.getTime()) ? mtime : startedAt;

  // Identity: session + start + seat + iteration. NOT the filename and NOT the iteration
  // alone — numbering restarts at every orchestrator reset, so both recycle.
  const runUid = createHash('sha256')
    .update(`${sessionId ?? 'no-session'} ${when.toISOString()} ${seat} ${iteration ?? -1}`)
    .digest('hex');

  return {
    runUid, seat, iteration, sessionId, model,
    startedAt: when, durationMs, numTurns,
    inputTokens: inTok, outputTokens: outTok,
    cacheCreationTokens: cacheCreate, cacheReadTokens: cacheRead,
    totalCostUsd: cost, subtype, sourceFile: fileName, triggeredBy,
    limitStatus: typeof rateLimit?.status === 'string' ? rateLimit.status : null,
    limitType: typeof rateLimit?.rateLimitType === 'string' ? rateLimit.rateLimitType : null,
    // Guarded rather than coerced: `Number(undefined)` is NaN and `Number(null)` is 0, and 0
    // here would read as "used none of the subscription" on a run that was never told.
    limitUtilization: typeof rateLimit?.utilization === 'number' && Number.isFinite(rateLimit.utilization)
      ? rateLimit.utilization
      : null,
    limitResetsAt: typeof rateLimit?.resetsAt === 'number' && Number.isFinite(rateLimit.resetsAt)
      ? new Date(rateLimit.resetsAt * 1000)   // the CLI sends UNIX SECONDS, not milliseconds
      : null,
  };
}

/**
 * Read the log directory and upsert every run it can parse.
 *
 * Idempotent by `runUid`, so re-running costs a handful of no-op upserts and never doubles a
 * figure. Safe to call from a request handler and from the hourly sweep.
 */
export async function ingestOrchestratorSpend(dir: string = LOGS_DIR): Promise<{ scanned: number; ingested: number; skipped: number }> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter(isRunLog);
  } catch (err: any) {
    log.warn('orchestrator logs unreadable — nothing ingested', { dir, error: err?.message });
    return { scanned: 0, ingested: 0, skipped: 0 };
  }

  let ingested = 0; let skipped = 0;
  for (const f of files) {
    try {
      const full = join(dir, f);
      const [text, st, trigger] = await Promise.all([
        readFile(full, 'utf-8'), stat(full), readTrigger(dir, f),
      ]);
      const run = parseRunLog(text, f, st.mtime, trigger);
      if (!run) { skipped++; continue; }
      await prisma.orchestratorSpend.upsert({
        where: { runUid: run.runUid },
        create: {
          runUid: run.runUid, seat: run.seat, iteration: run.iteration,
          sessionId: run.sessionId, model: run.model, startedAt: run.startedAt,
          durationMs: run.durationMs, numTurns: run.numTurns,
          inputTokens: BigInt(run.inputTokens), outputTokens: BigInt(run.outputTokens),
          cacheCreationTokens: BigInt(run.cacheCreationTokens),
          cacheReadTokens: BigInt(run.cacheReadTokens),
          totalCostUsd: run.totalCostUsd, subtype: run.subtype, sourceFile: run.sourceFile,
          triggeredBy: run.triggeredBy,
          limitStatus: run.limitStatus, limitType: run.limitType,
          limitUtilization: run.limitUtilization, limitResetsAt: run.limitResetsAt,
        },
        // A run still in flight grows between ingests, so the newer read wins.
        //
        // `triggeredBy` is the ONE field a re-read must not clobber with null. The sidecar is
        // written when the run is launched and could be pruned later; re-ingesting the same
        // log after that would otherwise erase a recorded attribution and silently turn a
        // known cron back into "unattributed". Only ever set it, never unset it.
        update: {
          numTurns: run.numTurns, durationMs: run.durationMs, subtype: run.subtype,
          inputTokens: BigInt(run.inputTokens), outputTokens: BigInt(run.outputTokens),
          cacheCreationTokens: BigInt(run.cacheCreationTokens),
          cacheReadTokens: BigInt(run.cacheReadTokens),
          totalCostUsd: run.totalCostUsd, sourceFile: run.sourceFile,
          ...(run.triggeredBy ? { triggeredBy: run.triggeredBy } : {}),
          // A run still in flight gains limit events, so the newer read is the better one —
          // but only when it actually carries a state. Same rule as `triggeredBy`: never
          // overwrite something recorded with a null.
          ...(run.limitStatus ? {
            limitStatus: run.limitStatus, limitType: run.limitType,
            limitUtilization: run.limitUtilization, limitResetsAt: run.limitResetsAt,
          } : {}),
        },
      });
      ingested++;
    } catch (err: any) {
      skipped++;
      log.warn('run log skipped', { file: f, error: err?.message });
    }
  }
  return { scanned: files.length, ingested, skipped };
}

export interface OrchestratorSpendReport {
  from: string;
  to: string;
  days: number;
  groupBy: 'day' | 'week' | 'month';
  series: Array<{
    bucket: string; label: string; runs: number;
    inTokens: number; outTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
    tokens: number; usd: number;
    bySeat: Array<{ seat: string; runs: number; tokens: number; usd: number }>;
    /** Weekly-equivalent share of the 7-day subscription window, and its verdict. */
    sharePoints: number | null;
    verdict: SpendVerdict | null;
    /** Tokens the CLI vouched for — the basis of `sharePoints`. May be below `tokens`. */
    tokensAuthoritative: number;
    /** Runs in this bucket whose tokens are per-turn fallbacks and are excluded from the share. */
    approxRunsExcluded: number;
  }>;
  seats: Array<{
    seat: string; runs: number; turns: number;
    inTokens: number; outTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
    tokens: number; usd: number; models: string[];
  }>;
  /**
   * The same spend cut by WHAT LAUNCHED IT rather than by seat — the owner's "cron wise".
   *
   * A separate query, not a regroup of `series`: a run has one seat and one trigger, but the
   * two do not nest. The nightly cron produces build AND review AND score rows, and `heal`
   * rows come from both the ten-minute cron and the nightly loop's own chat stage. Deriving
   * this from the seat rows would have to pick one as the parent and would be wrong either
   * way. `trigger: null` is carried through as "unattributed" and never folded into manual.
   */
  triggers: Array<{
    trigger: string | null; runs: number; tokens: number; usd: number;
    inTokens: number; outTokens: number; seats: string[];
  }>;
  totals: { runs: number; tokens: number; usd: number; cacheReadTokens: number };
  /**
   * Where the SUBSCRIPTION stands — owner, 2026-08-31: show "token consumption as per available
   * limit of subscription".
   *
   * One entry per limit window the CLI has reported (`five_hour`, `seven_day`,
   * `seven_day_overage_included`), carrying the NEWEST state seen and whether anything was
   * rejected in this report's range.
   *
   * `utilization` is `null` whenever the CLI declined to say, which it does below the 0.75
   * warning threshold. That is reported as "under 75%", NEVER as 0% — the number is unknown,
   * not small, and this deck already has one lesson about zeros that meant "never measured".
   */
  limits: Array<{
    type: string;
    status: string | null;
    utilization: number | null;
    resetsAt: string | null;
    rejectedRuns: number;
    observedAt: string | null;
  }>;
  /**
   * WHERE WE STAND AGAINST THE SUBSCRIPTION — the owner's actual question, 2026-09-01:
   * *"my concern is to review either we are over consuming tokens then my claude subscription
   * limit?"*. Tokens first; cost is the secondary reading.
   *
   * These windows are ROLLING FROM NOW, deliberately independent of the report's date range.
   * "Am I about to be throttled" is a question about this moment, not about whichever month is
   * selected above, and tying it to the range would answer a different question silently.
   */
  subscription: {
    /**
     * Tokens we add per 1 percentage point of the seven-day window.
     *
     * MEASURED, NOT ASSUMED — from six consecutive `rate_limit_info` readings on 2026-08-17/18
     * where utilisation ticked up one point at a time. Samples: 15.9M, 14.4M, 13.5M, 13.9M,
     * 16.1M per point (one 2-point reading dropped as a rounding artefact). It tracks TOTAL
     * tokens: output tokens over the same readings varied about 2x, so they are not the driver.
     *
     * THIS IS A MARGINAL RATE, NOT A QUOTA. It is what the orchestrator adds; the baseline
     * utilisation belongs to whatever else uses the same subscription, including the owner's
     * own sessions. Anthropic does not publish the window size, so a "X of Y tokens" reading
     * would be invented. A share of the window is the strongest honest claim available.
     */
    tokensPerPoint: number;
    windows: Array<{
      type: 'five_hour' | 'seven_day';
      label: string;
      since: string;
      runs: number;
      tokens: number;
      /** Our estimated share of that window, in percentage points. Null for the 5h window. */
      sharePoints: number | null;
      /** Runs left out because their tokens came from the per-turn fallback, not a result event. */
      approxRunsExcluded: number;
    }>;
  };
  /** Seats that exist in the loop but recorded nothing — stated, never shown as zero cost. */
  unmeasured: string[];
}

const num = (v: any) => Number(v ?? 0);

/**
 * Day / week / month / range report. No user dimension — the orchestrator runs on one seat
 * per role, not on behalf of a person.
 */
export async function getOrchestratorSpendReport(
  from: string,
  to: string = from,
  groupBy: 'day' | 'week' | 'month' = 'day',
): Promise<OrchestratorSpendReport> {
  const lo = from <= to ? from : to;
  const hi = from <= to ? to : from;
  const loTs = `${lo} 00:00:00`;
  const hiTs = `${hi} 23:59:59.999`;

  // date_trunc('week') is ISO and starts MONDAY — the same boundary the route computes, or a
  // Week row and the Week button would cover different days.
  const trunc = groupBy === 'month' ? 'month' : groupBy === 'week' ? 'week' : 'day';

  const rows: any[] = await prisma.$queryRawUnsafe<any[]>(
    `SELECT to_char(date_trunc('${trunc}', started_at), 'YYYY-MM-DD') AS bucket,
            seat,
            COUNT(*)::int                                       AS runs,
            COALESCE(SUM(num_turns), 0)::bigint                 AS turns,
            COALESCE(SUM(input_tokens), 0)::bigint              AS in_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint             AS out_tokens,
            COALESCE(SUM(cache_read_tokens), 0)::bigint         AS cache_read,
            COALESCE(SUM(cache_creation_tokens), 0)::bigint     AS cache_create,
            COALESCE(SUM(total_cost_usd), 0)::float8            AS usd,
            -- Authoritative half, for the SHARE. See the note on the window query: a run with
            -- no result event carries per-turn sums that overstate ~2.3x, and one page must not
            -- print two different percentages for the same week.
            COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens)
                     FILTER (WHERE num_turns IS NOT NULL), 0)::bigint AS tokens_ok,
            COUNT(*) FILTER (WHERE num_turns IS NULL)::int            AS approx_runs
       FROM orchestrator_spend
      WHERE started_at >= $1::timestamp AND started_at <= $2::timestamp
      GROUP BY 1, 2
      ORDER BY 1`,
    loTs, hiTs,
  ).catch(() => [] as any[]);

  const modelRows: any[] = await prisma.$queryRawUnsafe<any[]>(
    `SELECT DISTINCT seat, COALESCE(model, 'unknown') AS model
       FROM orchestrator_spend
      WHERE started_at >= $1::timestamp AND started_at <= $2::timestamp`,
    loTs, hiTs,
  ).catch(() => [] as any[]);

  // The cron cut. Grouped in SQL rather than folded out of `rows`, because `rows` is already
  // grouped by seat and a run's seat and trigger are independent dimensions — see `triggers`
  // on the report interface. `triggered_by` stays NULL here; it is NOT coalesced to a string,
  // so the caller can render "unattributed" without it colliding with a real trigger name.
  const triggerRows: any[] = await prisma.$queryRawUnsafe<any[]>(
    `SELECT triggered_by                                       AS trigger,
            COUNT(*)::int                                      AS runs,
            COALESCE(SUM(input_tokens), 0)::bigint             AS in_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint            AS out_tokens,
            COALESCE(SUM(cache_read_tokens), 0)::bigint        AS cache_read,
            COALESCE(SUM(cache_creation_tokens), 0)::bigint    AS cache_create,
            COALESCE(SUM(total_cost_usd), 0)::float8           AS usd,
            ARRAY_AGG(DISTINCT seat ORDER BY seat)             AS seats
       FROM orchestrator_spend
      WHERE started_at >= $1::timestamp AND started_at <= $2::timestamp
      GROUP BY 1
      ORDER BY 7 DESC`,
    loTs, hiTs,
  ).catch(() => [] as any[]);

  const labelFor = (bucket: string) => {
    if (groupBy === 'month') return bucket.slice(0, 7);
    if (groupBy === 'week') {
      const end = new Date(`${bucket}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 6);
      return `${bucket} → ${end.toISOString().slice(0, 10)}`;
    }
    return bucket;
  };

  // The ACCUMULATOR, not the finished row. `sharePoints` and `verdict` are derived once per
  // bucket after the totals are in, so typing this as the report row would demand two fields
  // that cannot be known yet and would have to be seeded with placeholder nulls — placeholders
  // that could then survive to the screen if the derivation were ever skipped.
  type BucketAcc = Omit<OrchestratorSpendReport['series'][number], 'sharePoints' | 'verdict'>;
  const buckets = new Map<string, BucketAcc>();
  const perSeat = new Map<string, OrchestratorSpendReport['seats'][number]>();
  let totRuns = 0; let totTokens = 0; let totUsd = 0; let totCacheRead = 0;

  for (const r of rows) {
    const inT = num(r.in_tokens); const outT = num(r.out_tokens);
    const cr = num(r.cache_read); const cc = num(r.cache_create);
    const usd = num(r.usd);
    // TOTAL TOKENS INCLUDES CACHE. 96% of this workload is cache reads; a "total" that counted
    // only input and output would report a fraction of what was actually processed and billed.
    const tokens = inT + outT + cr + cc;

    // Annotated, not inferred: without the annotation the `??` literal's
    // `bySeat: []` infers `never[]`, the union's `.push` parameter collapses
    // to `never`, and tsc goes red — which is exactly how this file sat
    // uncommitted and blocked the release gate.
    const b: BucketAcc = buckets.get(r.bucket) ?? {
      bucket: r.bucket, label: labelFor(r.bucket), runs: 0,
      inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      tokens: 0, usd: 0, bySeat: [], tokensAuthoritative: 0, approxRunsExcluded: 0,
    };
    b.runs += r.runs; b.inTokens += inT; b.outTokens += outT;
    b.cacheReadTokens += cr; b.cacheCreationTokens += cc;
    b.tokens += tokens; b.usd += usd;
    b.tokensAuthoritative += num(r.tokens_ok); b.approxRunsExcluded += num(r.approx_runs);
    b.bySeat.push({ seat: r.seat, runs: r.runs, tokens, usd: Math.round(usd * 10000) / 10000 });
    buckets.set(r.bucket, b);

    const s: OrchestratorSpendReport['seats'][number] = perSeat.get(r.seat) ?? {
      seat: r.seat, runs: 0, turns: 0,
      inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      tokens: 0, usd: 0, models: [],
    };
    s.runs += r.runs; s.turns += num(r.turns);
    s.inTokens += inT; s.outTokens += outT;
    s.cacheReadTokens += cr; s.cacheCreationTokens += cc;
    s.tokens += tokens; s.usd += usd;
    perSeat.set(r.seat, s);

    totRuns += r.runs; totTokens += tokens; totUsd += usd; totCacheRead += cr;
  }

  for (const m of modelRows) {
    const s = perSeat.get(m.seat);
    if (s && !s.models.includes(m.model)) s.models.push(m.model);
  }

  const series = [...buckets.values()]
    .sort((a, b) => (a.bucket < b.bucket ? -1 : 1))
    .map((b) => {
      // Normalise to a weekly equivalent so a day, a week and a month are all judged against
      // the same seven-day window the subscription meters on.
      const days = bucketElapsedDays(b.bucket, groupBy);
      // AUTHORITATIVE tokens only, matching the subscription panel exactly. `tokens` above stays
      // the full recorded figure because that is what the seat table reports; the SHARE is the
      // claim about the subscription, and it must rest on figures the CLI actually vouched for.
      const sharePoints = Math.round(((b.tokensAuthoritative * (7 / days)) / TOKENS_PER_POINT) * 10) / 10;
      return {
        ...b,
        usd: Math.round(b.usd * 10000) / 10000,
        bySeat: b.bySeat.sort((x, y) => y.usd - x.usd),
        sharePoints,
        verdict: verdictFor(sharePoints),
      };
    });

  const seats = [...perSeat.values()]
    .map((s) => ({ ...s, usd: Math.round(s.usd * 10000) / 10000 }))
    .sort((a, b) => b.usd - a.usd);

  // NAME WHAT IS NOT MEASURED. Reporting a seat that emitted no usage as $0.00 would read as
  // "it was free"; listing it here says "it was never measured", which is the truth.
  //
  // `heal` was the standing example: both analyst call sites ran with `--output-format text`,
  // which emits no usage at all, so the ten-minute cron — the highest-frequency spender on the
  // box — could not be billed even in principle. Both now run `--output-format stream-json`,
  // so heal rows appear once each has run again. `score` is still genuinely unmeasured: the
  // scorer writes only `iter-NN-score.log`, with no event stream to read.
  const measured = new Set(seats.map((s) => s.seat));
  const unmeasured = Object.values(SEAT_BY_SUFFIX).filter((s) => !measured.has(s));

  // WHAT CLAUDE LAST TOLD US, and how often it actually blocked a run.
  //
  // NOT bounded by the report's date range, unlike everything above it, and that asymmetry is
  // deliberate: this pairs with the rolling subscription windows, and "what is the limit state"
  // is a question about now. Range-scoping it meant a September range showed no seven-day
  // reading at all — the row went blank precisely when the reader wanted it most.
  //
  // The rejection count IS windowed, each type against its own window (5h against five hours,
  // the seven-day variants against seven days), because "runs blocked" only means something
  // inside the window that blocked them.
  const limitRows: any[] = await prisma.$queryRawUnsafe<any[]>(
    `WITH latest AS (
       SELECT DISTINCT ON (limit_type)
              limit_type, limit_status, limit_utilization, limit_resets_at, started_at
         FROM orchestrator_spend
        WHERE limit_type IS NOT NULL
        ORDER BY limit_type, started_at DESC
     ), rejected AS (
       SELECT limit_type, COUNT(*)::int AS n
         FROM orchestrator_spend
        WHERE limit_status = 'rejected'
          AND started_at >= NOW() - (CASE WHEN limit_type = 'five_hour'
                                          THEN INTERVAL '5 hours' ELSE INTERVAL '7 days' END)
        GROUP BY limit_type
     )
     SELECT l.limit_type, l.limit_status, l.limit_utilization, l.limit_resets_at, l.started_at,
            COALESCE(r.n, 0) AS rejected_runs
       FROM latest l LEFT JOIN rejected r ON r.limit_type = l.limit_type
      ORDER BY l.limit_type`,
  ).catch(() => [] as any[]);

  const limits = limitRows.map((l) => ({
    type: l.limit_type,
    status: l.limit_status ?? null,
    // Number() would turn a Prisma Decimal into a number but a NULL into 0, and 0 here reads as
    // "none of the subscription used". Kept null so the UI can say "under 75%" instead.
    utilization: l.limit_utilization == null ? null : Number(l.limit_utilization),
    resetsAt: l.limit_resets_at ? new Date(l.limit_resets_at).toISOString() : null,
    rejectedRuns: num(l.rejected_runs),
    observedAt: l.started_at ? new Date(l.started_at).toISOString() : null,
  }));

  // ── SUBSCRIPTION WINDOWS, rolling from NOW ──────────────────────────────────────────────
  // Deliberately NOT bounded by the report's date range: "am I about to be throttled" is a
  // question about this moment. A month-scoped answer to it would be quietly wrong.
  const windowRows: any[] = await prisma.$queryRawUnsafe<any[]>(
    // `num_turns IS NOT NULL` is the test for an AUTHORITATIVE token count: num_turns is only
    // ever set from the run's own `result` event, which is also where the trustworthy usage
    // figures live. A run cut off before its result falls back to SUMMING every per-turn usage
    // event, and that overstates by ~2.27x because each streamed message re-reports the context
    // its turn read. Two such runs (review iterations 1 and 2) carry 186,083,460 tokens — 32.5%
    // of everything on record — at $0.00, and left in they inflated the week of 08-17 from a
    // real ~15.4% to a reported ~28%. A fallback number is defensible for "what did this run
    // roughly do"; it is not defensible for "how much of the subscription have we used", so it
    // is excluded here and COUNTED so the exclusion is visible rather than silent.
    `SELECT 'five_hour' AS win,
            COUNT(*) FILTER (WHERE num_turns IS NOT NULL)::int AS runs,
            COUNT(*) FILTER (WHERE num_turns IS NULL)::int AS approx_runs,
            COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens)
                     FILTER (WHERE num_turns IS NOT NULL), 0)::bigint AS tokens
       FROM orchestrator_spend WHERE started_at >= NOW() - INTERVAL '5 hours'
      UNION ALL
     SELECT 'seven_day',
            COUNT(*) FILTER (WHERE num_turns IS NOT NULL)::int,
            COUNT(*) FILTER (WHERE num_turns IS NULL)::int,
            COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens)
                     FILTER (WHERE num_turns IS NOT NULL), 0)::bigint
       FROM orchestrator_spend WHERE started_at >= NOW() - INTERVAL '7 days'`,
  ).catch(() => [] as any[]);

  const byWin = new Map(windowRows.map((w) => [w.win, w]));
  const mk = (type: 'five_hour' | 'seven_day', label: string, since: string) => {
    const r = byWin.get(type);
    const tokens = num(r?.tokens);
    return {
      type, label, since, runs: num(r?.runs), tokens,
      approxRunsExcluded: num(r?.approx_runs),
      // Only the seven-day rate was measured, so only it gets a share. Reusing that rate for
      // the five-hour window would be arithmetic dressed up as measurement — the two windows
      // are different sizes and the burst limit binds first, which is why the one REJECTION on
      // this box was a five_hour one.
      sharePoints: type === 'seven_day' && tokens > 0
        ? Math.round((tokens / TOKENS_PER_POINT) * 10) / 10
        : null,
    };
  };
  const subscription = {
    tokensPerPoint: TOKENS_PER_POINT,
    windows: [
      mk('five_hour', 'Last 5 hours', new Date(Date.now() - 5 * 3600_000).toISOString()),
      mk('seven_day', 'Last 7 days', new Date(Date.now() - 7 * 86400_000).toISOString()),
    ],
  };

  const triggers = triggerRows.map((t) => ({
    trigger: t.trigger ?? null,
    runs: num(t.runs),
    inTokens: num(t.in_tokens),
    outTokens: num(t.out_tokens),
    // Same rule as the seat cut: cache counts toward the total, because most of this
    // workload IS cache reads and a total without them is a fraction of the real bill.
    tokens: num(t.in_tokens) + num(t.out_tokens) + num(t.cache_read) + num(t.cache_create),
    usd: Math.round(num(t.usd) * 10000) / 10000,
    seats: Array.isArray(t.seats) ? t.seats : [],
  }));

  return {
    from: lo, to: hi, days: series.length, groupBy, series, seats, triggers, limits, subscription,
    totals: {
      runs: totRuns, tokens: totTokens,
      usd: Math.round(totUsd * 10000) / 10000,
      cacheReadTokens: totCacheRead,
    },
    unmeasured,
  };
}
