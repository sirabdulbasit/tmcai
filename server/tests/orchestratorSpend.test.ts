/**
 * Build & Heal spend — the orchestrator's own token consumption.
 *
 * A second spend deck, kept apart from `llm_spend`: that one is what the APPLICATION spends on
 * Gemini/Claude per user, this is what Claude Code bills for building and healing the product.
 * Two providers, two bills, never summed.
 *
 * THE DEFECT THESE TESTS EXIST FOR. The first cut of `parseRunLog` added up every usage event in
 * the stream. Measured over all 92 run logs on this host, 2026-08-28:
 *
 *     summing every usage event   1,284,494,419 tokens
 *     the result events alone       566,360,440 tokens   ← the figure `total_cost_usd` was priced from
 *
 * a 2.27× overstatement, almost entirely cache reads (1.034B vs 363M). A streamed assistant
 * message re-reports the context its turn read, and the `result` event then restates the run.
 * Since cost is taken verbatim from that same result event, summing would have printed a bill
 * beside a token count that could not have produced it — on a page whose whole purpose is that
 * the two can be checked against each other.
 *
 * The report assertions mock at the SQL boundary. They pin the shaping the deck depends on —
 * bucket labels, cache reads counted in the total, the per-seat split, unmeasured seats named —
 * without asserting SQL text, which would only restate the implementation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const raw = vi.fn();
const upsert = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: { $queryRawUnsafe: (...a: any[]) => raw(...a), orchestratorSpend: { upsert: (...a: any[]) => upsert(...a) } },
}));

import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseRunLog, getOrchestratorSpendReport, ingestOrchestratorSpend } from '../src/services/orchestratorSpendService';

const MTIME = new Date('2026-08-28T09:00:00.000Z');

/** One assistant turn, carrying the usage a streamed message re-reports. */
const turn = (inTok: number, outTok: number, cacheRead: number, cacheCreate: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-27T14:05:00.000Z',
    message: { usage: { input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate } },
  });

/** The run's own summary — the authoritative accounting, and where cost comes from. */
const result = (over: Record<string, any> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: '0ed604d3-e827-4fbf-8579-c5a07ccbb7ae',
    num_turns: 28,
    duration_ms: 1_814_000,
    total_cost_usd: 22.827876,
    usage: { input_tokens: 36, output_tokens: 27809, cache_read_input_tokens: 10_304_886, cache_creation_input_tokens: 556_609 },
    ...over,
  });

const init = JSON.stringify({
  type: 'system', subtype: 'init',
  session_id: '0ed604d3-e827-4fbf-8579-c5a07ccbb7ae',
  model: 'claude-fable-5',
  timestamp: '2026-08-27T14:00:00.000Z',
});

describe('parseRunLog — one run, one honest total', () => {
  it('takes tokens from the RESULT event, not the sum of every turn', () => {
    // The real iter-31-build shape: turns that re-report a cache read the result also states.
    const text = [init, turn(50, 900, 12_500_000, 800_000), turn(39, 8000, 12_900_000, 700_000), result()].join('\n');
    const run = parseRunLog(text, 'iter-31-build.jsonl', MTIME)!;

    expect(run.cacheReadTokens).toBe(10_304_886);   // not 25,400,000 + 10,304,886
    expect(run.cacheCreationTokens).toBe(556_609);
    expect(run.inputTokens).toBe(36);
    expect(run.outputTokens).toBe(27_809);
  });

  it('keeps tokens and cost from the SAME event, so the bill can be checked against them', () => {
    const text = [init, turn(50, 900, 12_500_000, 800_000), result()].join('\n');
    const run = parseRunLog(text, 'iter-31-build.jsonl', MTIME)!;
    expect(run.totalCostUsd).toBe(22.827876);
    expect(run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheCreationTokens)
      .toBe(36 + 27_809 + 10_304_886 + 556_609);
  });

  it('falls back to the per-turn sum when a run was cut off before its result', () => {
    // 2 of the 92 logs end this way. Partial, but real — better than dropping the run.
    const text = [init, turn(10, 200, 1_000_000, 50_000), turn(5, 300, 2_000_000, 25_000)].join('\n');
    const run = parseRunLog(text, 'iter-31-build.jsonl', MTIME)!;
    expect(run.cacheReadTokens).toBe(3_000_000);
    expect(run.outputTokens).toBe(500);
    expect(run.totalCostUsd).toBe(0);
  });

  it('records nothing at all for a run that emitted no usage — a zero row would read as "free"', () => {
    // The healing analyst runs with `--output-format text`; its logs carry no usage events.
    const text = [init, JSON.stringify({ type: 'assistant', message: 'plain text, no usage' })].join('\n');
    expect(parseRunLog(text, 'iter-31-chat.jsonl', MTIME)).toBeNull();
  });

  it('maps the file suffix to a seat and ignores a file that is not a run log', () => {
    expect(parseRunLog([init, result()].join('\n'), 'iter-31-build.jsonl', MTIME)!.seat).toBe('build');
    expect(parseRunLog([init, result()].join('\n'), 'iter-31-review.jsonl', MTIME)!.seat).toBe('review');
    expect(parseRunLog([init, result()].join('\n'), 'iter-31-chat.jsonl', MTIME)!.seat).toBe('heal');
    expect(parseRunLog([init, result()].join('\n'), 'iter-31-notes.jsonl', MTIME)).toBeNull();
  });

  it('keys identity on session + start + seat, because iteration numbers recycle across resets', () => {
    // `iter-01-build.jsonl` has existed several times over: 92 files carry 39 distinct numbers.
    // Two DIFFERENT runs that reused the number must not collapse onto one row.
    const a = parseRunLog([init, result()].join('\n'), 'iter-01-build.jsonl', MTIME)!;
    const b = parseRunLog(
      [JSON.stringify({ ...JSON.parse(init), session_id: 'a-later-reset', timestamp: '2026-08-28T09:00:00.000Z' }),
        result({ session_id: 'a-later-reset' })].join('\n'),
      'iter-01-build.jsonl', MTIME,
    )!;
    expect(a.iteration).toBe(1);
    expect(b.iteration).toBe(1);
    expect(a.runUid).not.toBe(b.runUid);

    // And the SAME run re-ingested keeps its id, or the hourly sweep would double the history.
    const again = parseRunLog([init, result()].join('\n'), 'iter-01-build.jsonl', new Date('2027-01-01T00:00:00Z'))!;
    expect(again.runUid).toBe(a.runUid);
  });

  it('prefers the stream timestamp over file mtime, so a copied file lands on the right day', () => {
    const run = parseRunLog([init, result()].join('\n'), 'iter-31-build.jsonl', MTIME)!;
    expect(run.startedAt.toISOString()).toBe('2026-08-27T14:00:00.000Z');

    const noTs = JSON.stringify({ type: 'system', session_id: 's1' });
    const fallback = parseRunLog([noTs, result()].join('\n'), 'iter-31-build.jsonl', MTIME)!;
    expect(fallback.startedAt.toISOString()).toBe(MTIME.toISOString());
  });

  it('survives a malformed line rather than losing the whole run', () => {
    const text = [init, '{not json', '', 'null', turn(1, 2, 3, 4), result()].join('\n');
    expect(parseRunLog(text, 'iter-31-build.jsonl', MTIME)!.totalCostUsd).toBe(22.827876);
  });
});

// SUM() over a bigint column comes back as bigint; the service must not print "[object BigInt]".
const row = (bucket: string, seat: string, over: Record<string, any> = {}) => ({
  bucket, seat, runs: 1, turns: BigInt(28),
  in_tokens: BigInt(36), out_tokens: BigInt(27_809),
  cache_read: BigInt(10_304_886), cache_create: BigInt(556_609),
  usd: 22.827876, ...over,
});

describe('the report the deck reads', () => {
  beforeEach(() => raw.mockReset());

  // THREE queries now, in order: the seat/bucket grid, the distinct models, and the cron cut.
  // The third is not optional padding — an exhausted mock returns `undefined`, and the service
  // calls `.catch()` on what it gets back, so a missing stub fails as a TypeError inside the
  // service rather than as a readable assertion.
  const mock = (rows: any[], models: any[] = [], triggers: any[] = []) => {
    raw.mockReset();
    raw.mockResolvedValueOnce(rows).mockResolvedValueOnce(models).mockResolvedValueOnce(triggers);
  };

  /** A row from the cron cut — same bigint-from-SUM() hazard as the seat rows. */
  const trig = (trigger: string | null, over: Record<string, any> = {}) => ({
    trigger, runs: 1,
    in_tokens: BigInt(36), out_tokens: BigInt(27_809),
    cache_read: BigInt(10_304_886), cache_create: BigInt(556_609),
    usd: 22.827876, seats: ['build'], ...over,
  });

  it('counts cache reads in the total — they are 96% of this workload and they are billed', async () => {
    mock([row('2026-08-27', 'build')]);
    const r = await getOrchestratorSpendReport('2026-08-27', '2026-08-27');
    expect(r.totals.tokens).toBe(36 + 27_809 + 10_304_886 + 556_609);
    expect(r.totals.cacheReadTokens).toBe(10_304_886);
    expect(r.series[0].cacheReadTokens).toBe(10_304_886);
  });

  it('splits a bucket by seat and keeps the seats ranked by cost', async () => {
    mock([
      row('2026-08-27', 'review', { usd: 1.5 }),
      row('2026-08-27', 'build', { usd: 22.827876 }),
    ]);
    const r = await getOrchestratorSpendReport('2026-08-27', '2026-08-27');
    expect(r.series).toHaveLength(1);
    expect(r.series[0].runs).toBe(2);
    expect(r.series[0].bySeat.map((s) => s.seat)).toEqual(['build', 'review']);
    expect(r.seats.map((s) => s.seat)).toEqual(['build', 'review']);
  });

  it('NAMES the seats that recorded nothing instead of showing them at $0.00', async () => {
    // "healing was never measured" and "healing was free" are opposite claims.
    mock([row('2026-08-27', 'build')]);
    const r = await getOrchestratorSpendReport('2026-08-27', '2026-08-27');
    expect(r.unmeasured).toContain('heal');
    expect(r.unmeasured).toContain('score');
    expect(r.unmeasured).not.toContain('build');
  });

  it('labels a week as its Monday-to-Sunday span, matching the Week button', async () => {
    mock([row('2026-08-24', 'build')]);
    const r = await getOrchestratorSpendReport('2026-08-24', '2026-08-30', 'week');
    expect(r.series[0].label).toBe('2026-08-24 → 2026-08-30');
  });

  it('returns one row per month over a long window', async () => {
    mock([row('2026-07-01', 'build'), row('2026-08-01', 'build')]);
    const r = await getOrchestratorSpendReport('2026-07-01', '2026-08-28', 'month');
    expect(r.series.map((s) => s.label)).toEqual(['2026-07', '2026-08']);
  });

  it('swaps an inverted range rather than returning nothing', async () => {
    mock([row('2026-08-27', 'build')]);
    const r = await getOrchestratorSpendReport('2026-08-28', '2026-08-01');
    expect([r.from, r.to]).toEqual(['2026-08-01', '2026-08-28']);
  });

  it('reports an empty window as empty, not as an error', async () => {
    mock([]);
    const r = await getOrchestratorSpendReport('2026-01-01', '2026-01-02');
    expect(r.totals).toEqual({ runs: 0, tokens: 0, usd: 0, cacheReadTokens: 0 });
    expect(r.series).toEqual([]);
    expect(r.triggers).toEqual([]);
    expect(r.unmeasured).toEqual(['build', 'heal', 'review', 'score']);
  });
});

/**
 * The cron cut — the owner's *"daily, weekly, monthly and cron wise"*.
 *
 * A seat is NOT a schedule, which is the whole reason this is a separate dimension: the nightly
 * cron opens build AND review AND score seats, and `heal` is opened by both the ten-minute cron
 * and the nightly loop's own chat stage. Deriving one from the other would have to nominate a
 * parent and would be wrong in both directions.
 */
describe('cron attribution', () => {
  beforeEach(() => raw.mockReset());

  const mock = (rows: any[], models: any[] = [], triggers: any[] = []) => {
    raw.mockReset();
    raw.mockResolvedValueOnce(rows).mockResolvedValueOnce(models).mockResolvedValueOnce(triggers);
  };
  const trig = (trigger: string | null, over: Record<string, any> = {}) => ({
    trigger, runs: 1,
    in_tokens: BigInt(36), out_tokens: BigInt(27_809),
    cache_read: BigInt(10_304_886), cache_create: BigInt(556_609),
    usd: 22.827876, seats: ['build'], ...over,
  });

  it('reports spend per cron, counting cache in the total like the seat cut does', async () => {
    mock([row('2026-08-27', 'build')], [], [
      trig('cron:nightly-iteration', { usd: 22.827876, runs: 3 }),
      trig('cron:watch-conversations', { usd: 4.5, runs: 40, seats: ['heal'] }),
    ]);
    const r = await getOrchestratorSpendReport('2026-08-27', '2026-08-27');
    expect(r.triggers.map((t) => t.trigger))
      .toEqual(['cron:nightly-iteration', 'cron:watch-conversations']);
    expect(r.triggers[0].runs).toBe(3);
    expect(r.triggers[0].tokens).toBe(36 + 27_809 + 10_304_886 + 556_609);
    expect(r.triggers[1].seats).toEqual(['heal']);
  });

  it('keeps an unattributed run as NULL and never launders it into "manual"', async () => {
    // The 42 rows ingested before trigger recording existed have no schedule on file. Calling
    // them manual would invent an answer for most of the August campaign, which was hand-run.
    mock([row('2026-08-27', 'build')], [], [trig(null, { runs: 42 })]);
    const r = await getOrchestratorSpendReport('2026-08-27', '2026-08-27');
    expect(r.triggers[0].trigger).toBeNull();
    expect(r.triggers.map((t) => t.trigger)).not.toContain('manual');
  });

  it('converts bigint sums to numbers, so the deck never prints "[object BigInt]"', async () => {
    mock([row('2026-08-27', 'build')], [], [trig('cron:nightly-iteration')]);
    const r = await getOrchestratorSpendReport('2026-08-27', '2026-08-27');
    expect(typeof r.triggers[0].tokens).toBe('number');
    expect(typeof r.triggers[0].inTokens).toBe('number');
    expect(Number.isFinite(r.triggers[0].usd)).toBe(true);
  });
});

/**
 * Reading the standalone analyst — the run the ten-minute cron actually produces.
 *
 * It has no iteration to be numbered by, so it is named by timestamp instead. Before this the
 * ingest filter only accepted `iter-NN-*.jsonl`, so the highest-frequency spender on the box
 * could not have been recorded even once it started emitting usage.
 */
describe('the standalone chat analyst', () => {
  it('reads chat-analysis-<stamp>.jsonl and books it to the heal seat', () => {
    const run = parseRunLog([init, result()].join('\n'), 'chat-analysis-20260831T120000.jsonl', MTIME)!;
    expect(run.seat).toBe('heal');
    expect(run.iteration).toBeNull();
    expect(run.totalCostUsd).toBe(22.827876);
  });

  it('still ignores the analyst LOG, so the prose is never mistaken for an event stream', () => {
    // .log is the extracted answer and .err is stderr; only the .jsonl carries usage.
    expect(parseRunLog([init, result()].join('\n'), 'chat-analysis-20260831T120000.log', MTIME)).toBeNull();
    expect(parseRunLog([init, result()].join('\n'), 'chat-analysis-notastamp.jsonl', MTIME)).toBeNull();
  });

  it('carries the trigger through from the sidecar, defaulting to null and not to manual', () => {
    const withTrigger = parseRunLog(
      [init, result()].join('\n'), 'chat-analysis-20260831T120000.jsonl', MTIME, 'cron:watch-conversations',
    )!;
    expect(withTrigger.triggeredBy).toBe('cron:watch-conversations');

    const without = parseRunLog([init, result()].join('\n'), 'iter-31-build.jsonl', MTIME)!;
    expect(without.triggeredBy).toBeNull();
  });

  it('picks up the .trigger sidecar written beside the run log', async () => {
    upsert.mockReset();
    const dir = await mkdtemp(join(tmpdir(), 'orchspend-'));
    await writeFile(join(dir, 'chat-analysis-20260831T120000.jsonl'), [init, result()].join('\n'));
    await writeFile(join(dir, 'chat-analysis-20260831T120000.trigger'), 'cron:watch-conversations');

    const out = await ingestOrchestratorSpend(dir);
    expect(out).toEqual({ scanned: 1, ingested: 1, skipped: 0 });
    expect(upsert.mock.calls[0][0].create.triggeredBy).toBe('cron:watch-conversations');
    expect(upsert.mock.calls[0][0].create.seat).toBe('heal');
  });

  it('never UNSETS a recorded trigger when the same log is re-ingested without its sidecar', async () => {
    // The sidecar is a small file next to a log the pruning backlog wants to delete. If a
    // re-read could write null over a known cron, a tidy-up would silently turn attributed
    // history back into "unattributed" — losing the answer this whole feature exists to give.
    upsert.mockReset();
    const dir = await mkdtemp(join(tmpdir(), 'orchspend-'));
    await writeFile(join(dir, 'iter-31-build.jsonl'), [init, result()].join('\n'));

    await ingestOrchestratorSpend(dir);
    const args = upsert.mock.calls[0][0];
    expect(args.create.triggeredBy).toBeNull();
    expect(args.update).not.toHaveProperty('triggeredBy');
  });

  it('gives two analyst runs distinct ids even though neither has an iteration number', () => {
    // Both land on iteration `null`; only session and start time separate them.
    const a = parseRunLog([init, result()].join('\n'), 'chat-analysis-20260831T120000.jsonl', MTIME)!;
    const b = parseRunLog(
      [JSON.stringify({ ...JSON.parse(init), session_id: 'later', timestamp: '2026-08-31T12:10:00.000Z' }),
        result({ session_id: 'later' })].join('\n'),
      'chat-analysis-20260831T121000.jsonl', MTIME,
    )!;
    expect(a.runUid).not.toBe(b.runUid);
  });
});
