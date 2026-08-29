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
vi.mock('../src/db/prisma', () => ({
  default: { $queryRawUnsafe: (...a: any[]) => raw(...a), orchestratorSpend: { upsert: vi.fn() } },
}));

import { parseRunLog, getOrchestratorSpendReport } from '../src/services/orchestratorSpendService';

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

  const mock = (rows: any[], models: any[] = []) => {
    raw.mockReset();
    raw.mockResolvedValueOnce(rows).mockResolvedValueOnce(models);
  };

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
    expect(r.unmeasured).toEqual(['build', 'heal', 'review', 'score']);
  });
});
