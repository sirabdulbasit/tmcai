// ═════════════════════════════════════════════════════════════════════════════
// proposalDigest — DEF-349: the SURFACING half of the Learn loop.
// DEF-350: coverage derived from the LIVE QUEUE, not a cursor.
//
// DEF-349 (D-128) built the digest and it works: the 10-25 nightly enqueued
// `learn_proposal_digest:2:2026-10-25` carrying 5 memoryIds. But its original
// bookkeeping was a per-tenant TIME CURSOR advanced when the tenant pass
// completed — and Codex's review plus the live queue showed two ways the
// cursor and the queue could DISAGREE, both losing proposals forever:
//
//   (1) day-dedup gap (Codex finding #1): a proposal first-fresh in a SECOND
//       same-day run hits the day-keyed dedup ('duplicate'), was never in any
//       digest, yet the cursor advanced past it;
//   (2) expiry loss (Codex directive #4, live-scheduled): queued owner-bound
//       prompts carry a 48h TTL. With both channels dark, the 10-25 digest
//       expires 10-27 02:31 UNDELIVERED — and the cursor had already advanced
//       past all 5 proposals, so nothing would ever announce them again. The
//       stale-prompt-loss class (DEF-063/077 kin) on a new producer.
//
// The fix removes the second source of truth entirely: a proposal is COVERED
// iff a digest row whose metadata.memoryIds contains it still exists in the
// queue in a state that can (or did) reach the owner. No cursor, no
// system_config write, nothing to drift. An expired/cancelled/skipped digest
// drops its proposals back out of coverage and the next nightly re-announces
// them under a fresh day key — Brain follows up on its own undelivered
// announcement until it lands, regenerating from current truth rather than
// resurrecting a stale message.
//
// Delivery still travels the ONE chokepoint (`enqueueBrainPrompt`, the
// inbound-noise-report pattern): day-keyed dedup, quiet hours, model-owned
// wording (provenance-stamped marker; `answerSanitizer` validates and the
// voice pass phrases). HONEST SCOPE unchanged: enqueued ≠ delivered (DEF-081);
// with channels dark the digest queues and flows on re-pair — but now an
// expiry costs at most one day's delay, never the proposals.
//
// Guardrails: tenant/user scope (tenant-scoped reads, per-user digests, the
// queue re-checks both) · target grounding (coverage and titles read from the
// governed rows and the queue's own receipts — the memoryIds metadata) ·
// irreversible-needs-confirmation (announces the human gate, activates
// nothing) · no-claim-without-a-receipt (a proposal is only ever "announced"
// when a live queue row carries its id).
// ═════════════════════════════════════════════════════════════════════════════

import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { renderLearnProposalDigest } from '../notifications/proactiveMessageText';
import { PROMPT_TERMINAL_LOST_STATES } from '../brainPrompts/brainPromptQueueService';

const log = createLogger('proposal-digest');

export const DIGEST_DEDUP_PREFIX = 'learn_proposal_digest:';
export const DIGEST_FLAG_KEY = 'learn.proposal_digest_enabled';
export const MAX_TITLES_PER_DIGEST = 5;
/** Bound on memoryIds per digest row. The overflow stays UNCOVERED and rolls
 *  into the next day's digest — bounded, never lost. */
export const MAX_IDS_PER_DIGEST = 40;
/**
 * Queue states in which a digest can no longer reach the owner — its
 * proposals fall back out of coverage and are re-announced. Everything else
 * covers; an UNKNOWN state defaults to covering, so a vocabulary change can
 * cost at most a delayed re-announce, never a spam loop.
 *
 * DEF-351 (Codex DEF-350-review risk #2): this is an ALIAS of the queue's own
 * canonical classification, not a second definition — the module that writes
 * the states owns the list, and the DEF-351 tripwire test fails the matrix if
 * any state literal in src is left unclassified.
 */
export const DIGEST_LOST_STATES = PROMPT_TERMINAL_LOST_STATES;

interface PendingRow {
  id: string;
  userId: number | null;
  title: string;
  createdAt: Date;
}

export interface ProposalDigestDeps {
  /** Injectable for tests; defaults to brainPromptQueueService.enqueueBrainPrompt. */
  enqueue?: (input: any) => Promise<{ status: string }>;
  /** Injectable for tests; defaults to behaviorConfig.getBehaviorValue. */
  getBehavior?: (key: string, scope: { clientNumber: string }) => Promise<number | string>;
}

export interface ProposalDigestResult {
  tenants: number;
  usersNotified: number;
  duplicates: number;        // today's digest already queued — the day-dedup refused; stays uncovered, tomorrow carries it
  skippedDisabled: number;   // tenant has the flag off
  skippedAllCovered: number; // every pending proposal is carried by a live digest row
  tenantScopeSkipped: number;// userId-null proposals have no single recipient; counted, not sent
  unshowable: number;        // blank-title proposals: excluded, never claimed as announced (Codex finding #2)
  tenantsFailed: number;
}

/**
 * One digest pass: for every tenant, announce every pending proposal that no
 * LIVE digest row covers. Idempotent against the queue itself — re-running
 * changes nothing unless a digest died or new proposals exist.
 */
export async function runProposalDigest(deps: ProposalDigestDeps = {}): Promise<ProposalDigestResult> {
  const enqueue = deps.enqueue
    ?? (await import('../brainPrompts/brainPromptQueueService')).enqueueBrainPrompt;
  const getBehavior = deps.getBehavior
    ?? (await import('../behaviorConfig')).getBehaviorValue;

  const out: ProposalDigestResult = {
    tenants: 0, usersNotified: 0, duplicates: 0,
    skippedDisabled: 0, skippedAllCovered: 0,
    tenantScopeSkipped: 0, unshowable: 0, tenantsFailed: 0,
  };

  const tenants = await prisma.governedBrainMemory.groupBy({
    by: ['clientNumber'],
    where: { status: 'pending_approval' },
  }).catch(() => [] as Array<{ clientNumber: string }>);

  for (const t of tenants) {
    const clientNumber = t.clientNumber;
    out.tenants += 1;
    try {
      const enabled = Number(await getBehavior(DIGEST_FLAG_KEY, { clientNumber }).catch(() => 1));
      if (enabled !== 1) { out.skippedDisabled += 1; continue; }

      const pending: PendingRow[] = await prisma.governedBrainMemory.findMany({
        where: { clientNumber, status: 'pending_approval' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, userId: true, title: true, createdAt: true },
      });
      if (pending.length === 0) continue;

      // DEF-350 — coverage from the queue's own receipts. A proposal is
      // announced iff a digest row in a non-lost state carries its id.
      const digests = await prisma.brainPromptQueue.findMany({
        where: { clientNumber, dedupKey: { startsWith: DIGEST_DEDUP_PREFIX } },
        select: { state: true, metadata: true },
      });
      const covered = new Set<string>();
      for (const d of digests) {
        if (DIGEST_LOST_STATES.has(d.state)) continue;
        const ids = (d.metadata as Record<string, unknown> | null)?.memoryIds;
        if (Array.isArray(ids)) {
          for (const id of ids) if (typeof id === 'string') covered.add(id);
        }
      }

      const uncovered = pending.filter((p) => !covered.has(p.id));
      // Codex finding #2 — a blank-title proposal cannot render (the marker
      // validator rejects an empty-titles payload), so it is excluded and
      // COUNTED rather than enqueued-then-eaten or claimed as announced.
      const fresh: PendingRow[] = [];
      for (const p of uncovered) {
        if (p.title && p.title.trim().length > 0) fresh.push(p);
        else out.unshowable += 1;
      }
      if (fresh.length === 0) {
        if (uncovered.length === 0) out.skippedAllCovered += 1;
        continue;
      }

      const freshByUser = new Map<number, PendingRow[]>();
      for (const p of fresh) {
        if (p.userId == null) { out.tenantScopeSkipped += 1; continue; }
        const list = freshByUser.get(p.userId) ?? [];
        list.push(p);
        freshByUser.set(p.userId, list);
      }

      const day = new Date().toISOString().slice(0, 10);
      for (const [userId, newOnesAll] of freshByUser) {
        // Bounded per digest; the remainder stays uncovered and tomorrow's
        // digest carries it — bounded delay, never loss.
        const newOnes = newOnesAll.slice(0, MAX_IDS_PER_DIGEST);
        const allForUser = pending.filter((p) => p.userId === userId);
        const titles = [...newOnes]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, MAX_TITLES_PER_DIGEST)
          .map((p) => p.title);
        const res = await enqueue({
          userId,
          clientNumber,
          question: renderLearnProposalDigest({
            pendingTotal: allForUser.length,
            newSinceLast: newOnes.length,
            titles,
          }),
          criticality: 'routine',
          expectsReply: false, // a digest is not a question (DEF-063)
          provenance: 'system_marker',
          dedupKey: `${DIGEST_DEDUP_PREFIX}${userId}:${day}`,
          metadata: {
            source: 'learn_proposal_digest',
            pendingTotal: allForUser.length,
            newSinceLast: newOnes.length,
            // The COMPLETE id list — this metadata IS the coverage record, so
            // it is never truncated below what the digest claims to announce.
            memoryIds: newOnes.map((p) => p.id),
          },
        });
        // 'duplicate' = today's digest already exists and predates these
        // proposals. Nothing marks them covered (there is no cursor), so
        // tomorrow's fresh day key carries them — Codex finding #1 closed by
        // construction: only an actual queue row can cover a proposal.
        if (res.status === 'duplicate') out.duplicates += 1;
        else out.usersNotified += 1;
      }
    } catch (e: any) {
      out.tenantsFailed += 1;
      log.warn('tenant digest failed — coverage unchanged, will retry next run', {
        clientNumber, error: String(e?.message ?? e).slice(0, 200),
      });
    }
  }
  return out;
}
