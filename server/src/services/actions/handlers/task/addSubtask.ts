import {ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata, ConfirmationCapability } from '../../handlerBase';
import { findTaskById, createSubtask, getTask } from '../../../googleTasksService';

export class AddSubtaskHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'add_subtask', category: 'task', description: 'Add a subtask under an existing task', version: '1.1', requiresConnector: 'google_tasks' };
  }
  schema() {
    return { type: 'object', required: ['parentTaskId', 'title'], properties: { parentTaskId: { type: 'string' }, title: { type: 'string' }, notes: { type: 'string' } } };
  }
  auditFields() { return ['parentTaskId', 'subtaskId', 'taskListId']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.parentTaskId) errors.push('parentTaskId required');
    if (!ctx.payload.title) errors.push('title required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { parentTaskId: ctx.payload.parentTaskId, title: ctx.payload.title }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    // Real Google Tasks write (was a stub until 2026-07-09 backlog gap-fill).
    // Google Tasks puts subtasks on the same list as the parent by
    // setting the `parent` field on insert. Locate the parent first so
    // we write to the correct list — no blind writes.
    try {
      const parentTaskId = String(ctx.payload.parentTaskId ?? '').trim();
      const title = String(ctx.payload.title ?? '').trim();
      const notes = ctx.payload.notes != null ? String(ctx.payload.notes) : undefined;
      if (!parentTaskId || !title) return { ok: false, error: 'parentTaskId and title required' };
      const located = await findTaskById(ctx.userId, parentTaskId);
      if (!located) {
        return { ok: false, error: `parent task not found in any of your Google Tasks lists (id ${parentTaskId})` };
      }
      const created = await createSubtask(ctx.userId, located.taskListId, parentTaskId, title, notes);
      if (!created || !created.id) {
        return { ok: false, error: 'Google Tasks did not return a subtask id' };
      }
      return {
        ok: true,
        output: {
          subtaskId: created.id,
          taskListId: located.taskListId,
          parentTaskId,
          title: created.title ?? title,
          createdAt: new Date().toISOString(),
        },
      };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'add_subtask failed' };
    }
  }
  confirmationCapability(): ConfirmationCapability {
    return 'provider_confirmed'; // confirm() reads back from the provider (Odoo/Google Tasks)
  }

  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Provider read-back: fetch the subtask, verify parent linkage. A
    // matching id with the WRONG parent means the parent field didn't
    // stick (rare but observed on API-side races) — treat as unconfirmed.
    const o = output as { subtaskId?: string; taskListId?: string; parentTaskId?: string } | null | undefined;
    if (!o || typeof o.subtaskId !== 'string' || !o.subtaskId || typeof o.taskListId !== 'string' || !o.taskListId) {
      return false;
    }
    try {
      const t = await getTask(ctx.userId, o.taskListId, o.subtaskId) as any;
      if (!t || t.id !== o.subtaskId) return false;
      if (typeof o.parentTaskId === 'string' && o.parentTaskId && t.parent !== o.parentTaskId) return false;
      return true;
    } catch {
      return false;
    }
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { subtaskId: string };
    return { handler: 'delete_task', payload: { taskId: o.subtaskId } };
  }
}
