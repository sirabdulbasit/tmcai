/**
 * briefPartitionService — single source of truth for the My Attention
 * vs. Brief partition (2026-05-14).
 *
 * Background: My Attention and Brief used to be two independent API
 * endpoints, each running their own buildAttentionList / buildHandledList
 * pass. Both passes called the suggester per feed event, which under the
 * hood asks a non-deterministic LLM "what's the suggested action?".
 * Even with a per-event cache, the two endpoints could disagree:
 *
 *   - same feed event, different cached suggestion at the moment each
 *     endpoint fetched (cache miss timing, eviction, TTL expiry between
 *     the two reads)
 *   - autonomousExecutor running in parallel populating agent_action
 *     with a different verdict than the live suggester returns
 *
 * Result: the user saw HAIDER's "Thank you Sir" appearing in BOTH
 * My Attention (sa='draft_reply', 95%) and Brief (sa='ignore', 90%)
 * at the same refresh. The partition contract was broken.
 *
 * Brain-shape fix (per user 2026-05-14 "work smarter not harder, like
 * a brain not a programmer"): ONE pass per (clientNumber, userId)
 * within a short window. Both endpoints derive their views from the
 * same computed partition. The two surfaces CAN'T disagree because
 * they're reading the same in-memory result.
 *
 * Cache invalidation:
 *   - 30-second TTL — long enough that My Attention + Brief on the
 *     same page-load share one pass, short enough that the user sees
 *     a fresh partition after taking an action
 *   - explicit invalidatePartition() on /brief/decide writes, on
 *     autonomousExecutor terminal actions, and on pattern-hide writes
 */
import { buildAttentionList, buildHandledList, type AttentionItem, type HandledItem } from './triageSuggester';

export interface BriefPartition {
  /** Items where Brain needs the user's attention/decision. */
  myAttention: AttentionItem[];
  /** Items Brain has already handled (auto-decided, user-decided,
   *  noise-suppressed, etc.) — surfaces in Brief as audit. */
  brief: HandledItem[];
  /** Per-bucket counts for Brief's section headers. */
  byBucket: Record<string, number>;
}

interface CacheEntry {
  promise: Promise<BriefPartition>;
  expiresAt: number;
}

const partitionCache = new Map<string, CacheEntry>();
const PARTITION_TTL_MS = 30 * 1000;

function key(clientNumber: string, userId: number): string {
  return `${clientNumber}::${userId}`;
}

/**
 * Compute the brief partition for a user. Memoised for ~30s so the
 * parallel My Attention + Brief endpoint reads on a single page-load
 * share the same in-memory result.
 *
 * The two underlying builders (buildAttentionList, buildHandledList)
 * still run independently inside this function, but the suggester's
 * per-event cache means the LLM call for any given feed event happens
 * at most once per partition computation. Combined with the partition
 * memo, that means: one page-load fires two endpoint calls, but the
 * suggester runs at most once per event, and BOTH endpoints read the
 * same suggestion → the autonomy gate fires consistently in both
 * builders → partition contract holds.
 *
 * @param attentionLimit  hard cap on My Attention items returned
 * @param briefLimit      hard cap on Brief items returned
 */
export async function computeBriefPartition(
  clientNumber: string,
  userId: number,
  attentionLimit = 200,
  briefLimit = 100,
): Promise<BriefPartition> {
  const k = key(clientNumber, userId);
  const cached = partitionCache.get(k);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }
  // Coalesce concurrent partition requests to the same user behind one
  // promise so two endpoints don't both race the builders.
  const promise = (async (): Promise<BriefPartition> => {
    // SEQUENTIAL not parallel — buildAttentionList mutates shared
    // AttentionItem objects in the suggester cache (e.g. it.critical
    // gets demoted by loop extraction). If buildHandledList runs
    // concurrently it reads inconsistent state. Running them in
    // sequence guarantees buildHandledList sees the post-mutation
    // values that My Attention's autonomy gate also evaluated.
    const myAttention = await buildAttentionList(clientNumber, userId, attentionLimit);
    const briefItems = await buildHandledList(clientNumber, userId, briefLimit);

    // CONTRACT ENFORCEMENT — partition must be disjoint by feed_event
    // id. If any item appears in both lists, drop it from Brief (the
    // user-attention surface wins — never silently hide a card
    // requiring action). Log the overlap so the next pipeline change
    // sees it instead of papering over.
    const attentionIds = new Set<string>();
    for (const it of myAttention) {
      if (it.feedEventId) attentionIds.add(it.feedEventId);
      // Conversation collapse: My Attention groups feed_events by
      // chat/thread into one card. The other members of that group
      // are tracked in conversationFeedEventIds / threadFeedEventIds
      // on the representative item. All of them belong to My Attention.
      const conv = (it as any).conversationFeedEventIds;
      if (Array.isArray(conv)) for (const fid of conv) if (fid) attentionIds.add(String(fid));
      const tids = (it as any).threadFeedEventIds;
      if (Array.isArray(tids)) for (const fid of tids) if (fid) attentionIds.add(String(fid));
    }
    const overlap: string[] = [];
    const filteredBrief = briefItems.filter((it) => {
      if (it.feedEventId && attentionIds.has(it.feedEventId)) {
        overlap.push(it.feedEventId);
        return false;
      }
      return true;
    });
    if (overlap.length > 0) {
      console.warn(
        `[brief-partition] LEAK detected — ${overlap.length} feed_events were in BOTH My Attention and Brief; removed from Brief. `
        + `Sample ids: ${overlap.slice(0, 3).join(', ')}. `
        + `Underlying race: builders disagreed on autonomy gate for the same feed_event. `
        + `This enforcement is a band-aid; the real fix is making suggester output deterministic per partition.`,
      );
    }

    const byBucket: Record<string, number> = {};
    for (const it of filteredBrief) byBucket[it.bucket] = (byBucket[it.bucket] ?? 0) + 1;
    return { myAttention, brief: filteredBrief, byBucket };
  })();
  partitionCache.set(k, { promise, expiresAt: Date.now() + PARTITION_TTL_MS });
  // If the partition computation throws, drop the cache entry so the
  // next call retries instead of returning the failed promise.
  promise.catch(() => {
    const current = partitionCache.get(k);
    if (current?.promise === promise) partitionCache.delete(k);
  });
  return promise;
}

/**
 * Drop the cached partition for a user. Call after any action that
 * changes what should appear in either surface:
 *  - user makes a decision via /brief/decide
 *  - autonomousExecutor commits a terminal action (acknowledge / ignore
 *    / delegate / add_open_item)
 *  - user hides a pattern
 *  - sender mute / unmute
 *  - contact scope flip (Make Private / Public / Normal)
 */
export function invalidatePartition(clientNumber: string, userId: number): void {
  partitionCache.delete(key(clientNumber, userId));
}

/** Clear the entire partition cache (test / boot hook). */
export function clearPartitionCache(): void {
  partitionCache.clear();
}
