import { Router, Request, Response } from 'express';
import { preview, execute, graphSummary } from '../services/actions/cascadingUndoService';
import { executeViaRegistry } from '../services/actions/executeViaRegistry';
import { listAll as listAllHandlers } from '../services/actions/handlerRegistry';

const router = Router();

/**
 * HaseebOS v15 — Agent-callable action dispatch.
 *
 * Called by the Action Executor agent after it has validated risk via /risk/assess
 * and wants to execute a specific action handler. Returns {ok, actionId, output}.
 */
router.post('/execute', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const body = req.body ?? {};
  const actionType = String(body.actionType ?? '');
  if (!actionType) return res.status(400).json({ error: 'actionType required' });

  try {
    const result = await executeViaRegistry({
      actionType,
      clientNumber: body.clientNumber ?? user.clientNumber,
      userId: body.userId ?? user.id,
      openItemId: body.openItemId,
      entityId: body.entityId,
      payload: body.payload ?? {},
      traceId: body.traceId,
      executedByAgent: body.executedByAgent ?? user.agentId,
      existingActionId: body.existingActionId,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:actionId/preview', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const actionId = parseInt(String(req.params.actionId), 10);
  if (!Number.isFinite(actionId)) return res.status(400).json({ error: 'invalid actionId' });
  const p = await preview(actionId, user.clientNumber);
  res.json(p);
});

router.post('/:actionId/undo', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber || !user?.id) return res.status(401).json({ error: 'unauthenticated' });
  const actionId = parseInt(String(req.params.actionId), 10);
  if (!Number.isFinite(actionId)) return res.status(400).json({ error: 'invalid actionId' });
  try {
    const r = await execute(actionId, user.clientNumber, user.id, 'single');
    res.json(r);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:actionId/cascade-undo', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber || !user?.id) return res.status(401).json({ error: 'unauthenticated' });
  const actionId = parseInt(String(req.params.actionId), 10);
  if (!Number.isFinite(actionId)) return res.status(400).json({ error: 'invalid actionId' });
  try {
    const r = await execute(actionId, user.clientNumber, user.id, 'cascade');
    res.json(r);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * L3.3 — GET /api/v1/actions/tools
 * Returns the full registry: all 36 handlers + 6 control tools (propose_action,
 * risk_assess, execute, undo, cascade_undo, halt) for a total of 42 action tools.
 * Used by the Action Executor agent to discover what it can dispatch and by the
 * Steering Wheel UI to render action-type dropdowns.
 */
router.get('/tools', async (_req: Request, res: Response) => {
  const handlers = listAllHandlers().map((h) => {
    const m = h.metadata();
    return {
      kind: 'handler' as const,
      name: m.name,
      category: m.category,
      riskTier: (m as any).riskTier ?? 'LOW',
      description: (m as any).description ?? '',
      requiresApproval: (m as any).requiresApproval ?? false,
    };
  });

  const controlTools = [
    { kind: 'control' as const, name: 'propose_action', category: 'orchestration', riskTier: 'LOW', description: 'Propose an action for risk evaluation before execution', requiresApproval: false },
    { kind: 'control' as const, name: 'risk_assess', category: 'orchestration', riskTier: 'LOW', description: 'Pre-flight risk check: returns {tier, reasons, policy}', requiresApproval: false },
    { kind: 'control' as const, name: 'execute', category: 'orchestration', riskTier: 'LOW', description: 'Dispatch an approved action to the handler registry', requiresApproval: false },
    { kind: 'control' as const, name: 'undo', category: 'orchestration', riskTier: 'LOW', description: 'Undo a single action by id', requiresApproval: false },
    { kind: 'control' as const, name: 'cascade_undo', category: 'orchestration', riskTier: 'MED', description: 'Topological-sort undo over action_dependencies graph', requiresApproval: false },
    { kind: 'control' as const, name: 'halt', category: 'governance', riskTier: 'HIGH', description: 'Trip the kill switch for the tenant — 30-sec halt SLA', requiresApproval: true },
  ];

  const tools = [...handlers, ...controlTools];
  const byCategory: Record<string, number> = {};
  for (const t of tools) byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;

  res.json({
    totalTools: tools.length,
    handlerCount: handlers.length,
    controlToolCount: controlTools.length,
    byCategory,
    tools,
  });
});

router.get('/graph/:graphId', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const graphId = String(req.params.graphId);
  const summary = await graphSummary(graphId, user.clientNumber);
  res.json(summary);
});

export default router;
