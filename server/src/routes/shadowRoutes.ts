import { Router, Request, Response } from 'express';
import * as lifecycle from '../services/shadow/ruleLifecycleService';
import * as evaluator from '../services/shadow/shadowEvaluator';

const router = Router();

router.get('/rules', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const state = String(req.query.state ?? 'SHADOW') as lifecycle.RuleState;
  const rows = await lifecycle.listByState(user.clientNumber, state);
  res.json({ rows });
});

router.post('/rules', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber || !user?.id) return res.status(401).json({ error: 'unauthenticated' });
  if (user.userType !== 'SA' && user.userType !== 'AD') return res.status(403).json({ error: 'forbidden' });
  const body = req.body ?? {};
  if (!body.ruleName || !body.ruleSpec || !body.riskTier) {
    return res.status(400).json({ error: 'ruleName, ruleSpec, riskTier required' });
  }
  const rule = await lifecycle.createDraft({
    clientNumber: user.clientNumber,
    ruleName: body.ruleName,
    ruleSpec: body.ruleSpec,
    riskTier: body.riskTier,
    authorId: user.id,
  });
  res.status(201).json(rule);
});

router.post('/rules/:id/advance', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  if (user.userType !== 'SA' && user.userType !== 'AD') return res.status(403).json({ error: 'forbidden' });
  const ruleId = String(req.params.id);
  const newState = String(req.body?.newState) as lifecycle.RuleState;
  const reason = String(req.body?.reason ?? '');
  try {
    await lifecycle.advance(ruleId, user.clientNumber, newState, reason);
    res.json({ ruleId, newState });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/rules/:id/promote', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  if (user.userType !== 'SA' && user.userType !== 'AD') return res.status(403).json({ error: 'forbidden' });
  try {
    const gate = await lifecycle.promote(String(req.params.id), user.clientNumber);
    res.json({ promoted: true, gate });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/rules/:id/gate', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const gate = await lifecycle.promotionGate(String(req.params.id), user.clientNumber);
  res.json(gate);
});

router.post('/rules/:id/evaluate', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  if (user.userType !== 'SA' && user.userType !== 'AD') return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await evaluator.evaluate({ ruleId: String(req.params.id), clientNumber: user.clientNumber });
    res.json(r);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/evaluate-all', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  if (user.userType !== 'SA' && user.userType !== 'AD') return res.status(403).json({ error: 'forbidden' });
  const results = await evaluator.evaluateAllShadow(user.clientNumber);
  res.json({ count: results.length, results });
});

export default router;
