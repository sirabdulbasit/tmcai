import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import { publish } from '../../../infra/pubsubPublisher';
import { PUBSUB_TOPICS } from '../../../../config/pubsub';
import { addEdge } from '../../dependencyGraphService';
import prisma from '../../../../db/prisma';

interface ChildSpec {
  actionType: string;
  payload: Record<string, unknown>;
  /** Optional pre-existing AgentAction id (if the caller already persisted one) */
  actionId?: number;
}

export class ParallelFanOutHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return {
      name: 'parallel_fan_out',
      category: 'orchestration',
      description: 'Publish N child actions to actions.approved for concurrent execution by the Action Executor agent',
      version: '1.0',
    };
  }
  schema() {
    return {
      type: 'object',
      required: ['children'],
      properties: {
        children: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['actionType'],
            properties: {
              actionType: { type: 'string' },
              payload: { type: 'object' },
            },
          },
        },
      },
    };
  }
  auditFields() { return ['childrenCount', 'publishedMessageIds']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const children = ctx.payload.children as unknown;
    if (!Array.isArray(children) || children.length < 1) errors.push('children must be a non-empty array');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    const children = (ctx.payload.children as ChildSpec[]) ?? [];
    return {
      wouldSucceed: v.valid,
      preview: { willPublish: children.length, actionTypes: children.map((c) => c.actionType) },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const children = (ctx.payload.children as ChildSpec[]) ?? [];
    const publishedMessageIds: string[] = [];
    const childActionIds: number[] = [];

    for (const child of children) {
      // Persist a pending AgentAction for each child so the graph + undo work
      const row = await prisma.agentAction.create({
        data: {
          clientNumber: ctx.clientNumber,
          userId: ctx.userId,
          actionType: child.actionType,
          status: 'pending',
          input: {
            ...child.payload,
            _parentActionId: ctx.rootActionId ?? null,
            _parentDependencyGraphId: ctx.dependencyGraphId ?? null,
          } as any,
          dependencyGraphId: ctx.dependencyGraphId,
          executedByAgent: 'parallel_fan_out',
          requiresApproval: false,
        },
        select: { id: true },
      });
      childActionIds.push(row.id);

      // Register the edge eagerly so cascading undo can traverse even if the
      // consumer never runs executeViaRegistry (e.g. if Pub/Sub fails and we fall back)
      if (ctx.rootActionId) {
        await addEdge({
          clientNumber: ctx.clientNumber,
          parentActionId: ctx.rootActionId,
          childActionId: row.id,
          dependencyType: 'triggers',
        });
      }

      // Publish the child to actions.approved so the Action Executor agent picks it up
      try {
        const messageId = await publish(
          PUBSUB_TOPICS.ACTIONS_APPROVED,
          {
            agentActionId: row.id,
            actionType: child.actionType,
            payload: child.payload,
            userId: ctx.userId,
            openItemId: ctx.openItemId,
          },
          {
            tenantId: ctx.clientNumber,
            traceId: ctx.traceId,
            orderingKey: `actions:${ctx.clientNumber}`,
            attributes: {
              actionType: child.actionType,
              parentActionId: String(ctx.rootActionId ?? ''),
              eventType: 'action_approved',
            },
          },
        );
        publishedMessageIds.push(messageId);
      } catch (err: any) {
        // Mark this child as error — others may still succeed
        await prisma.agentAction.update({
          where: { id: row.id },
          data: { status: 'error', error: `publish failed: ${err.message}` },
        });
      }
    }

    const ok = publishedMessageIds.length === children.length;
    return {
      ok,
      output: {
        childrenCount: children.length,
        publishedCount: publishedMessageIds.length,
        childActionIds,
        publishedMessageIds,
      },
      error: ok ? undefined : `published ${publishedMessageIds.length}/${children.length} — check per-child status`,
    };
  }
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // B2 read-back: the fan-out's own side effect is the set of QUEUED child
    // AgentAction rows — so confirm() verifies every child row exists in this
    // tenant, was created by this handler, and none flipped to 'error'
    // (execute() marks publish failures that way). It deliberately does NOT
    // wait for child completion — executing the children is the Action
    // Executor agent's job, and each child gets its own confirm() when it runs.
    const o = output as { childrenCount?: number; childActionIds?: number[] } | null;
    if (!o || !Array.isArray(o.childActionIds) || o.childActionIds.length === 0) return false;
    if (o.childActionIds.length !== o.childrenCount) return false;
    const found = await prisma.agentAction.count({
      where: {
        id: { in: o.childActionIds },
        clientNumber: ctx.clientNumber,
        executedByAgent: 'parallel_fan_out',
        status: { not: 'error' },
      },
    });
    return found === o.childActionIds.length;
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { childActionIds: number[] };
    return {
      handler: 'parallel_fan_out.cascade_undo',
      payload: { childActionIds: o.childActionIds },
      note: 'walk each child via cascadingUndoService.execute(id, mode=cascade)',
    };
  }
}
