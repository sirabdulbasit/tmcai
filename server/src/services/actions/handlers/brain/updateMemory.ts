import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import prisma from '../../../../db/prisma';

export class UpdateMemoryHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'update_memory', category: 'brain', description: 'Write to the agent cross-session memory bank', version: '1.0' };
  }
  schema() {
    return {
      type: 'object',
      required: ['agentId', 'memoryKey', 'memoryValue'],
      properties: {
        agentId: { type: 'string' },
        memoryKey: { type: 'string' },
        memoryValue: {},
        ttlHours: { type: 'number' },
      },
    };
  }
  auditFields() { return ['agentId', 'memoryKey']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.agentId) errors.push('agentId required');
    if (!ctx.payload.memoryKey) errors.push('memoryKey required');
    if (ctx.payload.memoryValue === undefined) errors.push('memoryValue required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: { agentId: ctx.payload.agentId, memoryKey: ctx.payload.memoryKey, ttlHours: ctx.payload.ttlHours ?? null },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const expiresAt = ctx.payload.ttlHours ? new Date(Date.now() + Number(ctx.payload.ttlHours) * 3600 * 1000) : null;
    const existing = await prisma.agentMemory.findUnique({
      where: {
        clientNumber_agentId_memoryKey: {
          clientNumber: ctx.clientNumber,
          agentId: ctx.payload.agentId as string,
          memoryKey: ctx.payload.memoryKey as string,
        },
      },
    });
    const row = await prisma.agentMemory.upsert({
      where: {
        clientNumber_agentId_memoryKey: {
          clientNumber: ctx.clientNumber,
          agentId: ctx.payload.agentId as string,
          memoryKey: ctx.payload.memoryKey as string,
        },
      },
      create: {
        clientNumber: ctx.clientNumber,
        agentId: ctx.payload.agentId as string,
        memoryKey: ctx.payload.memoryKey as string,
        memoryValue: ctx.payload.memoryValue as any,
        expiresAt,
      },
      update: {
        memoryValue: ctx.payload.memoryValue as any,
        expiresAt,
      },
    });
    return { ok: true, output: { id: row.id, previousValue: existing?.memoryValue ?? null } };
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { previousValue: unknown };
    return {
      handler: 'update_memory',
      payload: {
        agentId: ctx.payload.agentId,
        memoryKey: ctx.payload.memoryKey,
        memoryValue: o.previousValue,
      },
      note: 'restore previous memory value (or null if first write)',
    };
  }
}
