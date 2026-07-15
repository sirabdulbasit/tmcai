/**
 * Canonical view: My Attention surface.
 *
 * The ONE function for "what needs the user's attention right now". Web
 * UI's Action Center (`GET /api/brief/attention`), Brain Chat composer's
 * attention block, WhatsApp Brain Day Brief — all read through this.
 *
 * Routes through briefPartitionService.computeBriefPartition so the
 * My-Attention vs Brief partition is computed once per user per
 * partition TTL window, and every surface sees the same ranking. The
 * UI's REST endpoint already uses this function — wrapping it here gives
 * Brain a typed entry point that's structurally identical.
 *
 * Per Basit 2026-05-20: three Day Brief surfaces (UI, web chat, WA)
 * showed the same 15 emails but picked different top-3 because each
 * applied its own re-ranking. Unifying the entry point eliminates the
 * accidental divergence; the Day Brief format rule now says "render in
 * source order — do not re-rank" so the LLM doesn't redo what this
 * function already settled.
 */
import { computeBriefPartition } from '../triage/briefPartitionService';
import type { AttentionItem } from '../triage/triageSuggester';

export type AttentionRow = AttentionItem;

export interface GetAttentionSurfaceOpts {
  /** Cap on items returned. Default 200 — matches the UI's max. */
  limit?: number;
  /** Brief-side cap (for the auto-handled partition). Default 100. */
  briefLimit?: number;
}

/**
 * Returns the user's current My Attention surface — the ordered list
 * that the web UI Day Brief renders as cards and the Brain composer
 * injects as the attention block.
 *
 * Channels (email / whatsapp / calendar / tasks / risks) are mixed in
 * one list with the partition service's canonical ranking. Callers that
 * need to bucket by channel can filter on `it.itemType`.
 */
export async function getAttentionSurface(args: {
  clientNumber: string;
  userId: number;
  opts?: GetAttentionSurfaceOpts;
}): Promise<AttentionRow[]> {
  const { clientNumber, userId, opts } = args;
  const attentionLimit = Math.min(Math.max(opts?.limit ?? 200, 1), 300);
  const briefLimit = Math.min(Math.max(opts?.briefLimit ?? 100, 1), 200);
  const partition = await computeBriefPartition(clientNumber, userId, attentionLimit, briefLimit);
  return partition.myAttention;
}

/** Convenience: just the count, without paying for full list construction.
 *  Still goes through the partition cache so the count won't disagree
 *  with what the UI eventually renders. */
export async function countAttentionSurface(args: {
  clientNumber: string;
  userId: number;
}): Promise<number> {
  const items = await getAttentionSurface(args);
  return items.length;
}
