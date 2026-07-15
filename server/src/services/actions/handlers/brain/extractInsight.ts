import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import prisma from '../../../../db/prisma';

export class ExtractInsightHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'extract_insight', category: 'brain', description: 'Save a durable insight to knowledge base or thought pipeline', version: '1.0' };
  }
  schema() {
    return {
      type: 'object',
      required: ['title', 'content'],
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        target: { type: 'string', enum: ['knowledge_item', 'thought_entry'], default: 'thought_entry' },
        category: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    };
  }
  auditFields() { return ['target', 'insightId', 'title']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.title) errors.push('title required');
    if (!ctx.payload.content) errors.push('content required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: { target: ctx.payload.target ?? 'thought_entry', title: ctx.payload.title, contentPreview: String(ctx.payload.content ?? '').slice(0, 200) },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const target = (ctx.payload.target as string) ?? 'thought_entry';
    if (target === 'knowledge_item') {
      const row = await prisma.knowledgeItem.create({
        data: {
          userId: ctx.userId,
          clientNumber: ctx.clientNumber,
          category: (ctx.payload.category as string) ?? 'lesson_learned',
          title: ctx.payload.title as string,
          content: ctx.payload.content as string,
          tags: (ctx.payload.tags as string[]) ?? [],
        } as any,
      });
      return { ok: true, output: { target: 'knowledge_item', insightId: row.id } };
    }
    const row = await prisma.thoughtEntry.create({
      data: {
        userId: ctx.userId,
        clientNumber: ctx.clientNumber,
        type: 'pattern_insight',
        title: ctx.payload.title as string,
        content: ctx.payload.content as string,
        triggerSource: 'user_request',
        status: 'published',
      },
    });
    return { ok: true, output: { target: 'thought_entry', insightId: row.id } };
  }
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // B2 read-back: the insight only counts if the row execute() created is
    // findable in this tenant. The two targets use different id types
    // (KnowledgeItem = Int autoincrement, ThoughtEntry = String cuid), so we
    // branch on the target recorded in the output. Unknown target → fail closed.
    const o = output as { target?: string; insightId?: unknown } | null;
    if (o?.insightId === undefined || o?.insightId === null) return false;
    if (o.target === 'knowledge_item') {
      const id = Number(o.insightId);
      if (!Number.isInteger(id)) return false;
      const row = await prisma.knowledgeItem.findFirst({
        where: { id, clientNumber: ctx.clientNumber },
        select: { id: true },
      });
      return row !== null;
    }
    if (o.target === 'thought_entry') {
      const row = await prisma.thoughtEntry.findFirst({
        where: { id: String(o.insightId), clientNumber: ctx.clientNumber, userId: ctx.userId },
        select: { id: true },
      });
      return row !== null;
    }
    return false;
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { target: string; insightId: string };
    return { handler: 'extract_insight.revert', payload: { target: o.target, insightId: o.insightId }, note: 'soft-delete or archive' };
  }
}
