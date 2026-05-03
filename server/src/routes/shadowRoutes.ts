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

/**
 * GET /api/v1/shadow/rules/promotion-ready — rules eligible for Day Brief's
 * "Ready to handle on my own" section. Returns up to 5 rules with agreement
 * ≥ 0.95 and evidence ≥ 10 whose next-prompt timer has elapsed.
 */
router.get('/rules/promotion-ready', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const prisma = (await import('../db/prisma')).default;
    const rules = await prisma.shadowRule.findMany({
      where: {
        clientNumber: user.clientNumber,
        mode: 'SHADOW',
        agreement: { gte: 0.95 },
        evidence: { gte: 10 },
        OR: [
          { nextPromotionPromptAt: null },
          { nextPromotionPromptAt: { lte: new Date() } },
        ],
      } as any,
      select: { id: true, name: true, description: true, evidence: true, agreement: true },
      orderBy: [{ agreement: 'desc' }, { evidence: 'desc' }],
      take: 5,
    });
    res.json({ rules });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/v1/shadow/rules/:id/keep-shadow — MD dismisses a promotion prompt.
 * Rule stays in SHADOW; defers next prompt so it doesn't nag on tomorrow's Day Brief.
 */
router.post('/rules/:id/keep-shadow', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const prisma = (await import('../db/prisma')).default;
    await prisma.$executeRawUnsafe(
      `UPDATE shadow_rules
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('next_promotion_prompt_at', (NOW() + INTERVAL '7 days')::text)
       WHERE id = $1 AND client_number = $2`,
      String(req.params.id), user.clientNumber,
    ).catch(() => {});
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
