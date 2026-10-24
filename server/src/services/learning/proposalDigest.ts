// ═════════════════════════════════════════════════════════════════════════════
// proposalDigest — DEF-349: the SURFACING half of the Learn loop.
//
// DEF-348's nightly distiller generates governed-memory proposals
// (pending_approval, human-gated — live-confirmed 10-24: the first pending
// rows in the system's history). But nothing told the owner they exist: they
// accrue in a Settings tab he never opens, so the human gate is a click that
// never comes and Learn still manifests nothing in practice. Builder, scorer,
// Codex and the analyst all named the same next increment: a digest that
// reaches him. This is it.
//
// It travels the ONE notification chokepoint — `enqueueBrainPrompt`, exactly
// like the inbound-noise report (DEF-217/230) and the withdrawal notice: at
// most ONE digest per user per DAY (the day is in the dedup key, so the
// queue's own dedup refuses a second, never a timer here), quiet-hours and
// channel discipline inherited from the dispatcher, wording owned by the
// model (the question is a provenance-stamped marker; `answerSanitizer`
// validates the payload and the voice pass phrases it). A second delivery
// implementation would be the 11th `protection-with-two-implementations`.
//
// HONEST DELIVERY SCOPE: enqueued ≠ delivered (DEF-081). With both owner
// channels currently dark the digest sits queued like every owner-bound
// message and flows when he re-pairs; the per-tenant cursor only advances
// past proposals whose digest was ACCEPTED by the queue, and new proposals
// re-trigger a fresh digest, so nothing is announced once into the void and
// then forgotten forever.
//
// Guardrails: tenant/user scope (per-tenant cursor, per-user digests, the
// queue re-checks both), target grounding (counts/titles read from the
// governed rows themselves; memoryIds in metadata are the receipt),
// irreversible-needs-confirmation (this ANNOUNCES the gate, it never
// activates anything), no-claim-without-a-receipt (exact counts returned and
// printed by the nightly).
// ═════════════════════════════════════════════════════════════════════════════

import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { renderLearnProposalDigest } from '../notifications/proactiveMessageText';

const log = createLogger('proposal-digest');

export const DIGEST_CURSOR_KEY = 'learn.proposal_digest.cursor';
export const DIGEST_FLAG_KEY = 'learn.proposal_digest_enabled';
export const MAX_TITLES_PER_DIGEST = 5;

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
  /** Injectable for tests; default to configService get/setConfig. */
  getConfig?: (clientNumber: string, key: string) => Promise<string | null>;
  setConfig?: (clientNumber: string, key: string, value: string) => Promise<void>;
}

export interface ProposalDigestResult {
  tenants: number;
  usersNotified: number;
  duplicates: number;      // already digested today — the queue's day-dedup refused
  skippedDisabled: number; // tenant has the flag off
  skippedNoNew: number;    // pending exists but nothing new since the cursor
  tenantScopeSkipped: number; // userId-null proposals have no single recipient; counted, not sent
  tenantsFailed: number;   // cursor held, retried next run
}

/**
 * One digest pass: for every tenant with pending proposals NEWER than its
 * cursor, enqueue one digest per affected user through the normal dispatcher.
 * Fail-closed per tenant, like the distiller: the cursor advances only when
 * the tenant's whole pass succeeds.
 */
export async function runProposalDigest(deps: ProposalDigestDeps = {}): Promise<ProposalDigestResult> {
  const enqueue = deps.enqueue
    ?? (await import('../brainPrompts/brainPromptQueueService')).enqueueBrainPrompt;
  const getBehavior = deps.getBehavior
    ?? (await import('../behaviorConfig')).getBehaviorValue;
  const cfg = deps.getConfig ?? (await import('../configService')).getConfig;
  const setCfg = deps.setConfig ?? (async (c: string, k: string, v: string) => {
    const { setConfig } = await import('../configService');
    await setConfig(c, k, v, false, 'DEF-349 proposal-digest watermark');
  });

  const out: ProposalDigestResult = {
    tenants: 0, usersNotified: 0, duplicates: 0,
    skippedDisabled: 0, skippedNoNew: 0, tenantScopeSkipped: 0, tenantsFailed: 0,
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

      const cursorRaw = await cfg(clientNumber, DIGEST_CURSOR_KEY);
      const cursor = cursorRaw ? new Date(cursorRaw) : new Date(0);

      const pending: PendingRow[] = await prisma.governedBrainMemory.findMany({
        where: { clientNumber, status: 'pending_approval' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, userId: true, title: true, createdAt: true },
      });
      const fresh = pending.filter((p) => p.createdAt > cursor);
      if (fresh.length === 0) { out.skippedNoNew += 1; continue; }

      const freshByUser = new Map<number, PendingRow[]>();
      for (const p of fresh) {
        if (p.userId == null) { out.tenantScopeSkipped += 1; continue; }
        const list = freshByUser.get(p.userId) ?? [];
        list.push(p);
        freshByUser.set(p.userId, list);
      }

      const day = new Date().toISOString().slice(0, 10);
      for (const [userId, newOnes] of freshByUser) {
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
          dedupKey: `learn_proposal_digest:${userId}:${day}`,
          metadata: {
            source: 'learn_proposal_digest',
            pendingTotal: allForUser.length,
            newSinceLast: newOnes.length,
            memoryIds: newOnes.slice(0, 20).map((p) => p.id), // the receipt
          },
        });
        if (res.status === 'duplicate') out.duplicates += 1;
        else out.usersNotified += 1;
      }

      // The whole tenant pass succeeded (every digest accepted or day-deduped)
      // — advance the watermark past what was announced. Any throw above lands
      // in the catch and the same proposals re-trigger next run.
      const maxCreatedAt = fresh[fresh.length - 1].createdAt;
      await setCfg(clientNumber, DIGEST_CURSOR_KEY, maxCreatedAt.toISOString());
    } catch (e: any) {
      out.tenantsFailed += 1;
      log.warn('tenant digest failed — cursor NOT advanced, will retry next run', {
        clientNumber, error: String(e?.message ?? e).slice(0, 200),
      });
    }
  }
  return out;
}
