import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import type { ActionContext, RiskEvaluation } from './riskGatingService';

const log = createLogger('approval-workflow');

interface PendingApprovalInput {
  ctx: ActionContext;
  evaluation: RiskEvaluation;
  draft?: unknown;
}

export async function createPendingApproval(input: PendingApprovalInput): Promise<number> {
  const row = await prisma.agentAction.create({
    data: {
      clientNumber: input.ctx.clientNumber,
      userId: input.ctx.userId,
      actionType: input.ctx.actionType,
      status: 'pending',
      input: (input.ctx.payload ?? {}) as any,
      output: input.draft !== undefined ? (input.draft as any) : null,
      requiresApproval: true,
      riskTier: input.evaluation.tier,
    },
  });

  // Fire-and-forget push notification with one-tap approve/reject buttons.
  // We don't block the approval creation on a push failure — the action is
  // already persisted and the user can also approve via the in-app inbox.
  void firePushForApproval(row.id, input.ctx, input.evaluation).catch((err) => {
    log.warn('approval push failed (action still queued)', {
      actionId: row.id, error: err.message,
    });
  });

  return row.id;
}

async function firePushForApproval(
  actionId: number,
  ctx: ActionContext,
  evaluation: RiskEvaluation,
): Promise<void> {
  // Lazy-load to avoid pulling the web-push module into hot paths that
  // never need it (e.g. unit tests on the workflow itself).
  const { issueTokens } = await import('../notifications/approvalTokenService');
  const { sendToUser } = await import('../notifications/pushService');
  const tokens = await issueTokens({
    clientNumber: ctx.clientNumber,
    userId: ctx.userId,
    actionId,
  });
  const baseUrl = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  const severity =
    evaluation.tier === 'HIGH' ? 'critical' :
    evaluation.tier === 'MEDIUM' ? 'high' : 'medium';
  const title = `Approval needed: ${ctx.actionType}`;
  const body = previewForAction(ctx);
  await sendToUser(ctx.clientNumber, ctx.userId, {
    event: 'approval_request',
    title, body,
    severity: severity as 'critical' | 'high' | 'medium',
    url: `${baseUrl}/api/v1/push/approval/${tokens.viewToken}/view`,
    tag: `approval-${actionId}`,
    actions: [
      { action: 'approve', title: 'Approve', url: `${baseUrl}/api/v1/push/approval/${tokens.approveToken}/approve` },
      { action: 'reject', title: 'Reject', url: `${baseUrl}/api/v1/push/approval/${tokens.rejectToken}/reject` },
    ],
    data: {
      actionId,
      riskTier: evaluation.tier,
      approveToken: tokens.approveToken,
      rejectToken: tokens.rejectToken,
      viewToken: tokens.viewToken,
      expiresAt: tokens.expiresAt.toISOString(),
    },
  });
}

function previewForAction(ctx: ActionContext): string {
  const p = (ctx.payload ?? {}) as Record<string, unknown>;
  // Best-effort preview: prefer a 'subject' or 'title', fallback to first
  // string field, then to the action type. Keep ≤200 chars for mobile.
  const subject = p.subject ?? p.title ?? p.text ?? p.body;
  if (typeof subject === 'string' && subject.trim()) return subject.slice(0, 200);
  const firstStr = Object.values(p).find((v) => typeof v === 'string' && v.length > 4);
  if (typeof firstStr === 'string') return firstStr.slice(0, 200);
  return `Tap to review and decide.`;
}

export async function approve(actionId: number, approvedBy: number): Promise<void> {
  await prisma.agentAction.update({
    where: { id: actionId },
    data: {
      status: 'approved',
      approvedBy,
      approvedAt: new Date(),
    },
  });
}

export async function reject(actionId: number, rejectedBy: number, reason: string): Promise<void> {
  await prisma.agentAction.update({
    where: { id: actionId },
    data: {
      status: 'rejected',
      approvedBy: rejectedBy,
      approvedAt: new Date(),
      error: reason,
    },
  });
}

export async function listPending(clientNumber: string): Promise<
  Array<{ id: number; actionType: string; riskTier: string | null; createdAt: Date; userId: number }>
> {
  const rows = await prisma.agentAction.findMany({
    where: { clientNumber, status: 'pending', requiresApproval: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { id: true, actionType: true, riskTier: true, createdAt: true, userId: true },
  });
  return rows;
}
