import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import { pushThought } from '../../../adapters/notionAdapter';
import prisma from '../../../../db/prisma';

export class SyncThoughtToNotionHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return {
      name: 'sync_thought_to_notion',
      category: 'brain',
      description: 'Push a ThoughtEntry row into the tenant-configured Notion database',
      version: '1.0',
      requiresConnector: 'notion',
    };
  }
  schema() {
    return {
      type: 'object',
      required: ['thoughtEntryId'],
      properties: { thoughtEntryId: { type: 'string' } },
    };
  }
  auditFields() { return ['thoughtEntryId', 'notionPageId', 'createdNew']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    if (!ctx.payload.thoughtEntryId) return { valid: false, errors: ['thoughtEntryId required'] };
    const thought = await prisma.thoughtEntry.findFirst({
      where: { id: String(ctx.payload.thoughtEntryId), clientNumber: ctx.clientNumber },
    });
    if (!thought) return { valid: false, errors: ['thought entry not found in this tenant'] };
    return { valid: true };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const thought = await prisma.thoughtEntry.findFirst({
      where: { id: String(ctx.payload.thoughtEntryId), clientNumber: ctx.clientNumber },
    });
    if (!thought) return { wouldSucceed: false, warnings: ['thought entry not found'] };
    return {
      wouldSucceed: true,
      preview: { title: thought.title, type: thought.type, contentPreview: thought.content.slice(0, 200) },
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const thought = await prisma.thoughtEntry.findFirst({
      where: { id: String(ctx.payload.thoughtEntryId), clientNumber: ctx.clientNumber },
    });
    if (!thought) return { ok: false, error: 'thought entry not found' };
    try {
      const result = await pushThought(ctx.clientNumber, {
        tmcaiId: thought.id,
        title: thought.title,
        content: thought.content,
        type: thought.type,
        status: thought.status,
        createdAt: thought.createdAt,
        tags: [],
      });
      // Mirror linkage back onto the ThoughtEntry
      await prisma.thoughtEntry.update({
        where: { id: thought.id },
        data: { publishedTo: 'notion', publishedAt: new Date() },
      });
      return {
        ok: true,
        output: { thoughtEntryId: thought.id, notionPageId: result.pageId, createdNew: result.createdNew, url: result.url },
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { notionPageId: string; createdNew: boolean };
    return {
      handler: 'notion.archive_page',
      payload: { pageId: o.notionPageId, wasCreated: o.createdNew },
      note: 'archive the Notion page — cannot fully delete via API, only archive',
    };
  }
}
