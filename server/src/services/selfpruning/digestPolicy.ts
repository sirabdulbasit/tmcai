/**
 * C-3 increment 2 — one item, one voice.
 *
 * What increment 1 measured, from production: the noise is not floods from
 * strangers (the CL-033 sender was answered 13/13). It is a CROSS-PRODUCER
 * DRIP — one open item accumulating a dozen pushes from three or four
 * subsystems, each reasonable in isolation: `item:cmqauv4xx…` took 13 pushes
 * from three producers at 69% unanswered.
 *
 * So this policy digests per ITEM, across producers, at the ONE chokepoint
 * every producer already calls (`enqueueBrainPrompt`) — which is what makes
 * "one producer cannot bypass the shared per-item decision path" a property of
 * the wiring rather than a promise (Codex iteration-28 directive #3).
 *
 * ── EVERY RULE FAILS TOWARD SENDING ─────────────────────────────────────────
 *
 * Suppression is the dangerous direction: DEF-156 dropped nine of ten real
 * messages by suppressing before persisting, and this campaign exists because
 * pushes are cheap and lost information is not. So:
 *
 *   - master switch `selfpruning.digest_enabled` DEFAULTS TO 0. Nothing is
 *     digested until the owner turns it on — the owner-controlled gate Codex
 *     required before any automatic suppression.
 *   - only an EXACT canonical `item:` subject can digest. Thread/event aliases,
 *     `floods`, and rows with no identity are visible-but-non-actionable in
 *     increment 1's terms, and this policy SENDS them (fail closed for
 *     uncertain identity, Codex iteration-28 directive #2).
 *   - an owner per-item decision of `keep` always sends. Unknown decision
 *     values are treated as `keep`, not as consent.
 *   - `high`/`top` criticality is never digested — muffling an escalation is
 *     how an assistant hides its own alarms.
 *   - a digest is never digested, and the policy's own failure sends.
 *
 * ── WHAT A DIGESTED PUSH IS ─────────────────────────────────────────────────
 *
 * A full `brain_prompt_queue` row, created exactly as it would have been, in
 * `state: 'skipped'` (an EXISTING schema state — the 20260505 CHECK constraint
 * rejects novel values, DEF-060) with `metadata.digest` as the discriminator
 * and audit block saying why and which digest covered it. Nothing is deleted; the
 * owner's "show all" is a query, not a recovery. The single digest message per
 * item per window rides the SAME queue as everything else, so quiet hours and
 * office hours apply to it by the one existing implementation rather than a
 * second one here.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
// DEF-120's accessor — the subject lives in a column for some producers and in
// metadata for others, and any code consulting only one silently ignores the
// other producers. One accessor, both places, everywhere the subject is needed;
// re-implementing it here would be the 12th `protection-with-two-implementations`.
import { promptSubjectItemId } from '../brainPrompts/brainPromptQueueService';
// DEF-173/DEF-174 — the digest's words are not written here, and after Codex's
// iteration-30 CRITICAL they are not written ANYWHERE as prose: the renderer
// emits a provenance-stamped system marker carrying the facts, whose one vetted
// meaning lives in `answerSanitizer` and is spoken through the `markerVoice`
// LLM boundary at delivery — the sanctioned deterministic form (invariant #4).
import { renderItemDigest } from '../notifications/proactiveMessageText';

const log = createLogger('digest-policy');

/** Fallbacks when behaviorConfig is unreachable (infrastructure failure only —
 *  an unknown key rethrows, per DEF-170's lesson). */
const DEFAULT_AFTER_PUSHES = 3;
const DEFAULT_WINDOW_HOURS = 24;

export interface DigestDecision {
  action: 'send' | 'digest';
  /** Why, in words that can be logged and audited. */
  reason: string;
  /** Present when action='digest': everything the caller needs to file the
   *  push and surface the one digest message. */
  digest?: {
    subjectKey: string;
    /** Unanswered pushes about this item already DELIVERED in the window —
     *  what the digest message reports. */
    coveredCount: number;
    /** The one message — a provenance-stamped system marker carrying the
     *  count and the latest push's text, rendered to owner language at the
     *  outbound boundary (DEF-174). */
    question: string;
    /** One digest per item per window: the window-bucketed dedup key. */
    dedupKey: string;
  };
}

/** The owner's standing per-item decision, read from tenant config. Only the
 *  two known values mean anything; everything else is `keep` (fail closed —
 *  an unrecognised value must not become consent to suppress). */
async function ownerDecisionFor(clientNumber: string, itemId: string): Promise<'keep' | 'digest' | null> {
  try {
    const { getConfig } = await import('../configService');
    const v = await getConfig(clientNumber, `selfpruning.decision.item:${itemId}`);
    if (v === 'digest') return 'digest';
    if (v === 'keep') return 'keep';
    return v == null ? null : 'keep';
  } catch { return null; }
}

async function behaviorNumber(key: string, clientNumber: string, fallback: number): Promise<number> {
  try {
    const { getBehaviorValue } = await import('../behaviorConfig');
    return await getBehaviorValue(key, { clientNumber });
  } catch (e: any) {
    if (/unknown behavior key/i.test(e?.message ?? '')) throw e;
    log.warn('behaviorConfig unreachable', { key, error: e?.message });
    return fallback;
  }
}

/**
 * Decide whether this about-to-be-enqueued push should ride as its own message
 * or be filed under the item's single digest for the window.
 *
 * Read-only: the CALLER files the row and enqueues the digest, so the policy
 * can be tested as a function and no write happens twice.
 */
export async function decideDigest(input: {
  clientNumber: string;
  userId: number;
  question: string;
  criticality: 'routine' | 'high' | 'top';
  openItemId?: string | null;
  metadata?: Record<string, unknown> | null;
  now?: Date;
}): Promise<DigestDecision> {
  const now = input.now ?? new Date();

  // A digest must never be digested — the recursion would eat its own summary.
  if ((input.metadata as any)?.source === 'selfpruning_digest') {
    return { action: 'send', reason: 'is itself a digest' };
  }

  // Escalations are never muffled.
  if (input.criticality !== 'routine') {
    return { action: 'send', reason: `criticality ${input.criticality} is never digested` };
  }

  // ── THE PER-DAY ROLLUP MOVED TO THE OUTBOUND CHOKEPOINT (DEF-327) ─────────
  //
  // DEF-325 built the one-message-per-day rollup HERE, but this function is
  // reached only from `enqueueBrainPrompt`. The loudest producer,
  // `openItemDraftAskJob`, calls `brainContactsUser` directly and never passed
  // through here (289 draft-asks/day vs 2 brain prompts, measured), so the
  // rollup the owner asked for held nothing. A per-DAY-per-USER decision needs
  // no item identity, so it belongs at `brainOutboundService.brainContactsUser`
  // — the one gate (DEF-108) every producer passes, queue and direct alike.
  // Removed from here rather than duplicated there, so the two sides cannot
  // become the 12th `protection-with-two-implementations`. The per-ITEM digest
  // below, which genuinely needs item identity, stays.

  // Master switch — and the DECIDED consent semantics (Codex iteration-29
  // MEDIUM #4): turning this on IS blanket consent for per-item digesting.
  // Per-item pre-consent was rejected deliberately, because the drip is only
  // visible after it has happened — a consent-per-item design would be inert
  // for every new item, which is the CL-033 failure restated. The per-item
  // escape is `keep`, which always wins; unknown values are keep, not consent.
  const enabled = await behaviorNumber('selfpruning.digest_enabled', input.clientNumber, 0);
  if (enabled !== 1) return { action: 'send', reason: 'digest disabled (owner has not opted in)' };

  // Only an exact canonical item identity may digest. Increment 1's
  // `unresolvedSubjects` and `floods` are non-actionable by construction, and
  // this is the constructive half of that promise.
  const itemId = promptSubjectItemId({ openItemId: input.openItemId, metadata: input.metadata });
  if (!itemId) return { action: 'send', reason: 'no exact item identity — uncertain subjects are never digested' };

  const decision = await ownerDecisionFor(input.clientNumber, itemId);
  if (decision === 'keep') return { action: 'send', reason: 'owner decision: keep' };

  const afterPushes = await behaviorNumber('selfpruning.digest_after_pushes', input.clientNumber, DEFAULT_AFTER_PUSHES);
  const windowHours = await behaviorNumber('selfpruning.digest_window_hours', input.clientNumber, DEFAULT_WINDOW_HOURS);
  const windowMs = windowHours * 60 * 60 * 1000;
  const since = new Date(now.getTime() - windowMs);

  // What has already reached him about this item and gone unanswered, in the
  // window — increment 1's definitions exactly. A read failure sends: losing a
  // push to a broken count is the DEF-156 shape.
  let delivered: number;
  try {
    delivered = await prisma.brainPromptQueue.count({
      where: {
        clientNumber: input.clientNumber,
        userId: input.userId,
        sentAt: { gte: since, lte: now },
        answeredAt: null,
        OR: [
          { openItemId: itemId },
          { metadata: { path: ['openItemId'], equals: itemId } as any },
        ],
      },
    });
  } catch (e: any) {
    log.warn('digest count failed; sending rather than risking a lost push', { error: e?.message });
    return { action: 'send', reason: 'count unavailable — fail open to sending' };
  }

  if (delivered < afterPushes) {
    return { action: 'send', reason: `${delivered} delivered unanswered in window; threshold ${afterPushes}` };
  }

  // The digest window bucket, so exactly one digest message exists per item
  // per window (enforced by the queue's own dedup on this key).
  const bucket = Math.floor(now.getTime() / windowMs);
  const item = await prisma.openItem.findFirst({
    where: { id: itemId, clientNumber: input.clientNumber },
    select: { title: true },
  }).catch(() => null);
  const label = item?.title ? `"${item.title}"` : 'one of your items';

  return {
    action: 'digest',
    reason: `${delivered} delivered unanswered pushes about item ${itemId} within ${windowHours}h`,
    digest: {
      subjectKey: `item:${itemId}`,
      coveredCount: delivered,
      question: renderItemDigest({
        label,
        totalCount: delivered + 1,
        unansweredCount: delivered,
        windowHours,
        latest: input.question,
      }),
      dedupKey: `selfpruning_digest:item:${itemId}:${bucket}`,
    },
  };
}
