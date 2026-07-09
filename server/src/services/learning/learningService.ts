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
 * Propose a new memory. Sensitive / critical memories ALWAYS land in
 * `pending_approval` regardless of what the caller passes, per the
 * governance rule that no sensitive memory becomes active without
 * explicit human approval.
 *
 * Low/normal-sensitivity memories created BY THE USER (not Brain)
 * can be marked active immediately — that's an explicit user action.
 */
export async function proposeMemory(input: ProposeMemoryInput): Promise<{ id: string; status: string }> {
  const sensitivity = input.sensitivityLevel ?? 'normal';
  const createdByBrain = input.createdByBrain ?? true;
  // Status gate: anything sensitive/critical OR proposed by Brain
  // starts as pending_approval. User-explicit low/normal memories
  // can land active.
  const requiresApproval = (
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
      createdByBrain,
    },
    select: { id: true, status: true },
  });
  return row;
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
