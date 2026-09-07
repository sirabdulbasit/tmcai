/**
 * Nexeo Self-Learning — Core Learning Service (Phase 1)
 *
 * The data-write surface for everything Brain "remembers" about
 * interactions. Phase 2 agents (gap detection, product proposals)
 * read FROM the rows this service writes; without this running for
 * several days first, Phase 2 has nothing to learn from.
 *
 * Three responsibilities:
 *   1. logInteraction  — every Brain ↔ user turn (web chat,
 *      WhatsApp, Day Brief, etc.) appends one row
 *   2. recordFeedback  — user explicit feedback on a logged
 *      interaction (helpful / incorrect / hallucinated / etc.)
 *   3. memory CRUD     — propose, approve, reject, archive
 *      governed memories with tenant + user isolation enforced
 *
 * Hard rules (enforced here, not at route level — defense in depth):
 *   - Every write carries client_number; nothing crosses tenants
 *   - Memory user_id MUST equal the authenticated user OR be NULL
 *     for tenant-scope (admin-only)
 *   - Sensitive memories cannot be created with status='active' on
 *     the first write — they enter pending_approval regardless of
 *     what the caller passes
 */
import prisma from '../../db/prisma';
import { scoreRisk, type RiskInput } from './riskScoringService';
import createLogger from '../../utils/logger';

const log = createLogger('learning');

// ─── Interaction logging ────────────────────────────────────────

export interface LogInteractionInput {
  clientNumber: string;
  userId: number;
  surface: string;
  interactionType: string;
  userPrompt?: string;
  brainResponse?: string;
  contextSnapshot?: Record<string, unknown>;
  dataBlocksUsed?: Record<string, unknown>;
  modelProvider?: string;
  modelName?: string;
  tokensUsed?: number;
  /** Caller passes risk hints; risk-scoring service classifies. */
  riskInput?: RiskInput;
  /** Explicit override only when the caller has independent reason
   *  to mark this differently from what scoreRisk would produce. */
  riskLevelOverride?: 'low' | 'medium' | 'high' | 'critical';
  status?: 'success' | 'failed' | 'blocked' | 'escalated' | 'pending_approval';
  userOutcome?: string;
}

/** Append one row to brain_interaction_learning_logs. Fire-and-forget
 *  safe — caller can ignore the returned id unless they intend to
 *  link feedback later. */
export async function logInteraction(input: LogInteractionInput): Promise<string | null> {
  try {
    const risk = input.riskLevelOverride
      ? { level: input.riskLevelOverride, reasons: ['caller override'] }
      : scoreRisk(input.riskInput ?? {});
    const row = await prisma.brainInteractionLearningLog.create({
      data: {
        clientNumber: input.clientNumber,
        userId: input.userId,
        surface: input.surface,
        interactionType: input.interactionType,
        userPrompt: input.userPrompt ?? null,
        brainResponse: input.brainResponse ?? null,
        contextSnapshot: (input.contextSnapshot ?? null) as any,
        dataBlocksUsed: (input.dataBlocksUsed ?? null) as any,
        modelProvider: input.modelProvider ?? null,
        modelName: input.modelName ?? null,
        tokensUsed: input.tokensUsed ?? null,
        riskLevel: risk.level,
        status: input.status ?? 'success',
        userOutcome: input.userOutcome ?? null,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err: any) {
    // NEVER let a logging failure cascade. Brain's reply path must
    // continue even if the learning log is down.
    log.warn('logInteraction failed (non-blocking)', {
      userId: input.userId, surface: input.surface, error: err.message,
    });
    return null;
  }
}

/** Update an existing interaction's user_outcome — e.g. user accepted /
 *  edited / rejected the response, after the fact. */
export async function recordUserOutcome(
  interactionId: string,
  userId: number,
  outcome: string,
): Promise<boolean> {
  try {
    // Verify ownership before update — caller MUST be the user
    // whose interaction this is.
    const owns = await prisma.brainInteractionLearningLog.findFirst({
      where: { id: interactionId, userId },
      select: { id: true },
    });
    if (!owns) return false;
    await prisma.brainInteractionLearningLog.update({
      where: { id: interactionId },
      data: { userOutcome: outcome },
    });
    return true;
  } catch (err: any) {
    log.warn('recordUserOutcome failed', { interactionId, error: err.message });
    return false;
  }
}

// ─── Feedback ───────────────────────────────────────────────────

export interface RecordFeedbackInput {
  clientNumber: string;
  userId: number;
  interactionId?: string;
  feedbackType: string;
  feedbackComment?: string;
  correctedOutput?: string;
}

export async function recordFeedback(input: RecordFeedbackInput): Promise<{ id: string }> {
  // If interactionId provided, verify it belongs to this user before
  // linking. Otherwise the feedback is "general" (still tenant-scoped).
  let safeInteractionId: string | null = null;
  if (input.interactionId) {
    const owns = await prisma.brainInteractionLearningLog.findFirst({
      where: { id: input.interactionId, userId: input.userId },
      select: { id: true },
    });
    safeInteractionId = owns?.id ?? null;
  }
  const row = await prisma.brainFeedback.create({
    data: {
      clientNumber: input.clientNumber,
      userId: input.userId,
      interactionId: safeInteractionId,
      feedbackType: input.feedbackType,
      feedbackComment: input.feedbackComment ?? null,
      correctedOutput: input.correctedOutput ?? null,
    },
    select: { id: true },
  });

  // C3 (2026-07-08): correctedOutput was written and never read. A user
  // rewriting Brain's output is the strongest correction signal there is —
  // distill it into a governed-memory PROPOSAL (pending_approval; injected
  // on approval via the C1 read path). Fire-and-forget: learning never
  // blocks or breaks the feedback write.
  if (input.correctedOutput?.trim()) {
    void (async () => {
      try {
        const { distillCorrection } = await import('./correctionDistiller');
        await distillCorrection({
          clientNumber: input.clientNumber,
          userId: input.userId,
          feedbackId: row.id,
          correctedOutput: input.correctedOutput!,
          feedbackComment: input.feedbackComment ?? null,
          interactionId: safeInteractionId,
        });
      } catch { /* best effort */ }
    })();
  }
  return row;
}

// ─── Governed memories ──────────────────────────────────────────

export interface ProposeMemoryInput {
  clientNumber: string;
  /** NULL = tenant-scope (admin-only). Otherwise user-scope. */
  userId?: number | null;
  memoryScope: string;
  scopeReferenceId?: string;
  memoryType: string;
  title: string;
  content: string;
  sourceType?: string;
  sourceReferenceId?: string;
  confidenceScore?: number;
  sensitivityLevel?: 'low' | 'normal' | 'sensitive' | 'critical';
  createdByBrain?: boolean;
}

/**
 * Sources whose content is the USER'S OWN WORDS, not Brain's inference.
 *
 * `chat_standing_preference` earns this because `standingPreferenceCapture` already
 * spends three filters before it ever calls here: a durability-marker pre-filter
 * (always / never / from now on / hamesha …), a deliberately conservative LLM distill
 * that is told to reject one-off requests, questions and single-value corrections, and
 * a 0.6 confidence floor below which the candidate is dropped silently. What survives
 * is a rule the owner stated out loud and meant to apply in future.
 *
 * DEF-149 is the reason this list is a list and not a boolean. "Chase her again" was
 * once filed as a preference when it was an imperative to act — but that message carries
 * no durability marker, so it exits at the pre-filter for free and never reaches this
 * function. Sources WITHOUT that filtering in front of them, the correction distiller
 * included, are deliberately absent.
 */
export const AUTO_ACTIVATE_SOURCES = new Set(['chat_standing_preference']);

/**
 * Higher than the 0.6 needed to PROPOSE, because activating without a human is a
 * stronger act than queueing for one. The two memories that sat pending for eight and
 * four weeks were both scored 1.00.
 */
export const AUTO_ACTIVATE_MIN_CONFIDENCE = 0.9;

/**
 * Propose a new memory. Sensitive / critical memories ALWAYS land in
 * `pending_approval` regardless of what the caller passes, per the
 * governance rule that no sensitive memory becomes active without
 * explicit human approval.
 *
 * LESS HUMAN INTERVENTION (owner decision, 2026-09-07: "then make it human
 * intervention less").
 *
 * The gate above this change was `createdByBrain`, which DEFAULTS TO TRUE — so every
 * memory required a click and the "user-explicit memories can land active" path this
 * comment used to promise could never fire for anything. Two governed memories sat in
 * `pending_approval` from 2026-07-14 and 2026-08-07, `Active Memories (0)`, and `Learn`
 * scored 42 as the only capability with no movement all campaign. The score was
 * measuring two unclicked buttons.
 *
 * So a narrow class now activates itself: a high-confidence standing preference the
 * owner stated in his own words, at normal or lower sensitivity. Everything else keeps
 * the click, and the rule that matters is untouched — SENSITIVE AND CRITICAL ARE STILL
 * ALWAYS GATED, by his hand and no other.
 *
 * What makes this reversible rather than merely convenient: an auto-activated row is
 * distinguishable in the database, because `approvedAt` is set while `approvedBy` stays
 * NULL — activated, by nobody. It shows in Active Memories and the audit feed, and one
 * click archives it.
 */
export async function proposeMemory(input: ProposeMemoryInput): Promise<{ id: string; status: string }> {
  const sensitivity = input.sensitivityLevel ?? 'normal';
  const createdByBrain = input.createdByBrain ?? true;
  const autoActivates = (
    sensitivity !== 'sensitive' &&
    sensitivity !== 'critical' &&
    AUTO_ACTIVATE_SOURCES.has(input.sourceType ?? '') &&
    Number(input.confidenceScore ?? 0) >= AUTO_ACTIVATE_MIN_CONFIDENCE
  );
  // Status gate: anything sensitive/critical OR proposed by Brain
  // starts as pending_approval, UNLESS it is in the self-activating
  // class above.
  const requiresApproval = !autoActivates && (
    sensitivity === 'sensitive' ||
    sensitivity === 'critical' ||
    createdByBrain
  );
  const row = await prisma.governedBrainMemory.create({
    data: {
      clientNumber: input.clientNumber,
      userId: input.userId ?? null,
      memoryScope: input.memoryScope,
      scopeReferenceId: input.scopeReferenceId ?? null,
      memoryType: input.memoryType,
      title: input.title,
      content: input.content,
      sourceType: input.sourceType ?? null,
      sourceReferenceId: input.sourceReferenceId ?? null,
      confidenceScore: input.confidenceScore ?? 0,
      sensitivityLevel: sensitivity,
      status: requiresApproval ? 'pending_approval' : 'active',
      // approvedAt WITHOUT approvedBy is the signature of a self-activation: active,
      // and no human put it there. A human approval sets both (see approveMemory).
      approvedAt: autoActivates ? new Date() : null,
      createdByBrain,
    },
    select: { id: true, status: true },
  });
  return row;
}

/**
 * THE LEARN SWEEP — Brain activates its own qualifying memories, unasked.
 *
 * Owner, 2026-09-07: *"since learning and improvement is already part of brain's
 * capability that's why i am expecting to make it part of brain's capability (nightly
 * cron) and also update score of brain's capability."*
 *
 * `proposeMemory`'s self-activation only applies at CREATION, so anything captured
 * before that rule existed stays pending forever and still needs a hand. That is the
 * shape of the original complaint, one layer down: a capability whose progress depends
 * on the owner opening a tab. This closes it — the nightly runs this, and the residue
 * drains itself.
 *
 * IT APPLIES EXACTLY THE CREATION-TIME BAR, from the same two constants, because a
 * sweep with its own copy of the rule is how a gate ends up wider in the background than
 * it is in the foreground. Sensitive and critical are never touched, at any confidence,
 * by this or anything else.
 *
 * Idempotent by construction: it only reads `pending_approval`, so a second run in the
 * same night finds nothing. `approvedBy` stays NULL — active, and no human put it there.
 */
export async function sweepQualifyingMemories(opts: { dryRun?: boolean } = {}): Promise<{
  scanned: number; activated: number; held: number; titles: string[];
}> {
  const pending = await prisma.governedBrainMemory.findMany({
    where: { status: 'pending_approval' },
    select: {
      id: true, title: true, sourceType: true,
      confidenceScore: true, sensitivityLevel: true,
    },
  });
  const qualifies = (m: (typeof pending)[number]) => (
    m.sensitivityLevel !== 'sensitive' &&
    m.sensitivityLevel !== 'critical' &&
    AUTO_ACTIVATE_SOURCES.has(m.sourceType ?? '') &&
    Number(m.confidenceScore ?? 0) >= AUTO_ACTIVATE_MIN_CONFIDENCE
  );
  const winners = pending.filter(qualifies);
  if (!opts.dryRun) {
    for (const m of winners) {
      await prisma.governedBrainMemory.update({
        where: { id: m.id },
        data: { status: 'active', approvedAt: new Date(), approvedBy: null },
      });
    }
  }
  return {
    scanned: pending.length,
    activated: winners.length,
    held: pending.length - winners.length,
    titles: winners.map((m) => m.title),
  };
}

/** Approve a pending memory — flips to 'active'. Approver MUST be in
 *  the same tenant. User-scope memories can be approved by the owner
 *  OR a tenant admin; tenant-scope memories require admin. The
 *  caller (route layer) MUST have already verified role permissions. */
export async function approveMemory(
  memoryId: string,
  approverUserId: number,
  approverClientNumber: string,
): Promise<{ ok: boolean; error?: string }> {
  const memory = await prisma.governedBrainMemory.findUnique({
    where: { id: memoryId },
    select: { id: true, clientNumber: true, userId: true, status: true },
  });
  if (!memory) return { ok: false, error: 'memory not found' };
  if (memory.clientNumber !== approverClientNumber) {
    return { ok: false, error: 'cross-tenant approval refused' };
  }
  if (memory.status !== 'pending_approval') {
    return { ok: false, error: `memory is in status ${memory.status}; only pending_approval can be approved` };
  }
  await prisma.governedBrainMemory.update({
    where: { id: memoryId },
    data: { status: 'active', approvedBy: approverUserId, approvedAt: new Date() },
  });
  return { ok: true };
}

export async function rejectMemory(
  memoryId: string,
  rejecterUserId: number,
  rejecterClientNumber: string,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  const memory = await prisma.governedBrainMemory.findUnique({
    where: { id: memoryId },
    select: { id: true, clientNumber: true, status: true },
  });
  if (!memory) return { ok: false, error: 'memory not found' };
  if (memory.clientNumber !== rejecterClientNumber) {
    return { ok: false, error: 'cross-tenant rejection refused' };
  }
  await prisma.governedBrainMemory.update({
    where: { id: memoryId },
    data: {
      status: 'rejected',
      rejectedBy: rejecterUserId,
      rejectedAt: new Date(),
      rejectionReason: reason ?? null,
    },
  });
  return { ok: true };
}

export async function archiveMemory(
  memoryId: string,
  clientNumber: string,
): Promise<{ ok: boolean; error?: string }> {
  const memory = await prisma.governedBrainMemory.findUnique({
    where: { id: memoryId },
    select: { id: true, clientNumber: true },
  });
  if (!memory) return { ok: false, error: 'memory not found' };
  if (memory.clientNumber !== clientNumber) {
    return { ok: false, error: 'cross-tenant archive refused' };
  }
  await prisma.governedBrainMemory.update({
    where: { id: memoryId },
    data: { status: 'archived' },
  });
  return { ok: true };
}

/** List memories for a user — defaults to active only. Caller
 *  determines whether they're listing their own memories or, when
 *  acting as admin, the tenant's. */
export async function listMemories(args: {
  clientNumber: string;
  userId?: number;
  status?: 'pending_approval' | 'active' | 'archived' | 'rejected' | 'all';
  scope?: string;
  limit?: number;
}) {
  const where: any = { clientNumber: args.clientNumber };
  if (args.userId !== undefined) where.userId = args.userId;
  if (args.status && args.status !== 'all') where.status = args.status;
  if (args.scope) where.memoryScope = args.scope;
  return prisma.governedBrainMemory.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(args.limit ?? 100, 500),
  });
}

/** Recent interactions for a user — drives the Brain Learning Center
 *  history view + feeds Phase 2 gap detection. */
export async function listInteractions(args: {
  clientNumber: string;
  userId: number;
  surface?: string;
  limit?: number;
}) {
  const where: any = { clientNumber: args.clientNumber, userId: args.userId };
  if (args.surface) where.surface = args.surface;
  return prisma.brainInteractionLearningLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(args.limit ?? 50, 200),
    include: { feedback: true },
  });
}
