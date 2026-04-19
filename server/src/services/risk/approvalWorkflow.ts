import prisma from '../../db/prisma';
import type { ActionContext, RiskEvaluation } from './riskGatingService';

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
  return row.id;
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
