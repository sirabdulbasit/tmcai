/**
 * How "Suggest the mapping" spends its time.
 * ===========================================
 *
 * The proposal is a handful of AI calls, and the time is in the calls, not in
 * the code around them. Nothing here changes what any call is asked, what model
 * answers it, how long it may think, or what is done with its answer. It
 * changes only WHEN a call runs, and whether an answer to a question asked
 * before, word for word, is used again:
 *
 *  • Goal-title recognition is asked in batches of 60 titles, as before, and
 *    the batches run side by side (at most four at once). Each batch is the
 *    same prompt it always was; the answers are merged in batch order, so the
 *    result is the one a one-by-one loop would produce. A batch that fails is
 *    reported, never lost.
 *  • An AI answer is kept with the version it built, keyed by a hash of
 *    everything that produced it (model, system prompt, the whole message,
 *    output room, thinking room, temperature). The next proposal whose call is
 *    identical in every byte uses that answer instead of asking again, and says
 *    so. Any change at all — a word of the brief, one sample record, a goal
 *    switched to Integration — is a different hash and a fresh call.
 *  • Records and goal recipes can be started before the field mapping returns,
 *    using the previous version's reading of the source. They are used only when
 *    the field mapping then settles on the same reading; otherwise they are
 *    stopped and redone with the real one (see proposeMapping).
 */
import { createHash } from 'crypto';
import type { ChatOptions, ChatResponse, LlmProvider } from './llmProvider';

/** Titles per recognition call — the size every recognition prompt has always had. */
export const RECOGNITION_BATCH = 60;
/**
 * Recognition calls in flight at once, for one proposal. Each still takes one
 * of the shared LLM slots (llmGate), so the assistant and nightly feeds keep
 * theirs.
 */
export const RECOGNITION_CONCURRENCY = 4;

/** Split a list into consecutive batches, order kept. */
export const batchesOf = <T>(items: readonly T[], size: number): T[][] => {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
};

/**
 * Run `fn` over every item with at most `limit` in flight. The outcomes come
 * back in INPUT order, whatever order the calls finished in.
 */
export const settleInPool = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> => {
  const out: Array<PromiseSettledResult<R>> = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i]!, i) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  const width = Math.min(Math.max(1, Math.floor(limit)), items.length);
  await Promise.all(Array.from({ length: width }, worker));
  return out;
};

export interface BatchFailure { index: number; size: number; error: string }

/**
 * Ask every batch, side by side, and merge the answers in batch order. A
 * failed batch is returned as a failure with its size — the caller reports it
 * exactly as the one-by-one loop did.
 */
export const askInBatches = async <C, D>(input: {
  items: readonly C[];
  batchSize?: number;
  concurrency?: number;
  ask: (batch: C[], index: number) => Promise<D[]>;
  /** After each batch settles: how many have, of how many, and how many failed. */
  onSettled?: (done: number, total: number, failed: number) => void;
}): Promise<{ decisions: D[]; failed: BatchFailure[]; batches: number }> => {
  const batches = batchesOf(input.items, input.batchSize ?? RECOGNITION_BATCH);
  let done = 0;
  let failedSoFar = 0;
  const settled = await settleInPool(batches, input.concurrency ?? RECOGNITION_CONCURRENCY, async (b, i) => {
    try {
      return await input.ask(b, i);
    } catch (err) {
      failedSoFar++;
      throw err;
    } finally {
      done++;
      input.onSettled?.(done, batches.length, failedSoFar);
    }
  });
  const decisions: D[] = [];
  const failed: BatchFailure[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') decisions.push(...s.value);
    else failed.push({ index: i, size: batches[i]!.length, error: s.reason instanceof Error ? s.reason.message : 'no answer' });
  });
  return { decisions, failed, batches: batches.length };
};

/* ── answers used again only for an identical question ─────────────────── */

export interface StoredReply {
  /** Which part of the proposal asked — 'field mapping', 'goal recipes', 'goal recognition'. */
  stage: string;
  text: string;
  finishReason: string;
}

export interface AiReplyMemo {
  /** Answers the previous version used, by call key. */
  prior: Record<string, StoredReply>;
  priorVersion: number | null;
  /** Answers this proposal used, fresh or reused — saved with its version. */
  used: Record<string, StoredReply>;
  /** Stages that took at least one answer from `prior`. */
  reused: Set<string>;
}

export const newAiReplyMemo = (
  previous: { version: number; replies: Record<string, StoredReply> | null } | null,
): AiReplyMemo => ({
  prior: previous?.replies ?? {},
  priorVersion: previous?.version ?? null,
  used: {},
  reused: new Set(),
});

/**
 * A memo for work that may be thrown away: reads the same prior answers, keeps
 * its own record of what it used, merged into the parent only when its result
 * is adopted (adoptMemo).
 */
export const childMemo = (parent: AiReplyMemo): AiReplyMemo => ({
  prior: parent.prior, priorVersion: parent.priorVersion, used: {}, reused: new Set(),
});

export const adoptMemo = (parent: AiReplyMemo, child: AiReplyMemo): void => {
  Object.assign(parent.used, child.used);
  for (const s of child.reused) parent.reused.add(s);
};

/** Everything that decides an answer. Any difference is a different key. */
export const aiCallKey = (model: string, opts: Pick<ChatOptions, 'systemPrompt' | 'messages' | 'maxOutputTokens' | 'thinkingBudget' | 'temperature'>): string =>
  createHash('sha256').update(JSON.stringify([
    model,
    opts.systemPrompt,
    opts.messages.map((m) => [m.role, m.content]),
    opts.maxOutputTokens ?? null,
    opts.thinkingBudget ?? null,
    opts.temperature ?? null,
  ])).digest('hex');

/** Only an answer the model finished normally is ever kept: not one cut off, filtered, stopped or cancelled. */
export const finishedNormally = (finishReason: string | null | undefined): boolean =>
  String(finishReason ?? '').toUpperCase() === 'STOP';

/**
 * provider.chat, unless this exact call was answered for the previous version.
 * `reused` tells the caller not to record spend: nothing was asked.
 *
 * Nothing is stored for reuse until the caller says the answer was usable:
 * `keep()` is called only after the caller has parsed the answer into what its
 * stage needs. An answer that finished abnormally (cut off, SAFETY, OTHER,
 * cancelled) is never kept even then, and an answer that did not parse is
 * never kept at all — so a retry with identical inputs asks the model again,
 * exactly as it did before answers were reused.
 */
export const memoChat = async (
  provider: LlmProvider,
  memo: AiReplyMemo | null | undefined,
  stage: string,
  opts: ChatOptions,
): Promise<{ res: ChatResponse; reused: boolean; keep: () => void }> => {
  if (!memo) return { res: await provider.chat(opts), reused: false, keep: () => undefined };
  const key = aiCallKey(provider.model, opts);
  const prior = memo.prior[key];
  if (prior && prior.text && finishedNormally(prior.finishReason)) {
    memo.reused.add(stage);
    return {
      reused: true,
      keep: () => { memo.used[key] = prior; },
      res: {
        text: prior.text, toolCalls: [], finishReason: prior.finishReason, modelUsed: provider.model,
        usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
      },
    };
  }
  const res = await provider.chat(opts);
  return {
    res,
    reused: false,
    keep: () => {
      if (res.text && finishedNormally(res.finishReason)) {
        memo.used[key] = { stage, text: res.text, finishReason: res.finishReason };
      }
    },
  };
};

/* ── reading the source before the field mapping returns ───────────────── */

/** The reader's page cap for a spec — the same arithmetic fetchRecordsWithMeta applies. */
export const effectiveMaxPages = (spec: { maxPages?: number | string | null }): number => {
  const raw = spec.maxPages == null || spec.maxPages === '' ? 20 : Number(spec.maxPages);
  return Math.min(Math.max(Number.isFinite(raw) ? raw : 20, 1), 200);
};

/**
 * What a read depends on apart from its page cap: the route, its query, the
 * watermark, and — for a spreadsheet — the columns it checks are present.
 */
export const readSpecKey = (spec: Record<string, unknown>, fileSource: boolean): string => JSON.stringify([
  spec.path ?? null, spec.method ?? null, spec.headers ?? null, spec.body ?? null, spec.recordsPath ?? null,
  spec.nextPagePath ?? null, spec.pageParam ?? null, spec.pageSizeParam ?? null, spec.pageSize ?? null,
  spec.startPage ?? null, spec.query ?? null, spec.watermarkField ?? null,
  ...(fileSource ? [spec.identityField ?? null, spec.valueField ?? null, spec.periodField ?? null, spec.labelField ?? null] : []),
]);

/**
 * Are the records an early read returned exactly the records the real spec
 * would read? Yes only when the read itself is the same, the early read reached
 * the source's end, and the real cap would not have stopped before it did.
 */
export const earlyReadMatches = (input: {
  early: { key: string; pages: number; truncated: boolean };
  real: Record<string, unknown>;
  fileSource: boolean;
}): boolean =>
  input.early.key === readSpecKey(input.real, input.fileSource)
  && !input.early.truncated
  && effectiveMaxPages(input.real as { maxPages?: number | null }) >= input.early.pages;
