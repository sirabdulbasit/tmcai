import { Router, Request, Response } from 'express';
import { trigger, release, getState, getHistory } from '../services/safety/killSwitchService';
import prisma from '../db/prisma';

const router = Router();

router.get('/kill-switch/status', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  const state = await getState(user.clientNumber);
  res.json(state);
});

/**
 * Recent kill-switch history (engages + releases, with reason + actor).
 * Anyone in the tenant can read so users can see "Brain is paused
 * because Asad triggered it 12m ago — reason: deploy regression."
 */
router.get('/kill-switch/history', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  const limit = Math.min(parseInt(String(req.query.limit ?? '50')) || 50, 200);
  const history = await getHistory(user.clientNumber, limit);
  res.json({ history });
});

/**
 * Withheld actions list — every action the kill switch held. Admin uses
 * this to see "what would have happened" once they're ready to release.
 */
router.get('/kill-switch/withheld', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  if (user.userType !== 'SA' && user.userType !== 'AD') {
    return res.status(403).json({ error: 'forbidden', message: 'SA or AD role required' });
  }
  const limit = Math.min(parseInt(String(req.query.limit ?? '100')) || 100, 500);
  const rows = await prisma.agentAction.findMany({
    where: {
      clientNumber: user.clientNumber,
      status: 'blocked_by_kill_switch',
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, userId: true, actionType: true, riskTier: true,
      input: true, output: true, executedByAgent: true, createdAt: true,
    },
  });
  res.json({ withheld: rows });
});

router.post('/kill-switch', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber || !user?.id) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  if (user.userType !== 'SA' && user.userType !== 'AD') {
    return res.status(403).json({ error: 'forbidden', message: 'SA or AD role required' });
  }
  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) {
    return res.status(400).json({ error: 'reason required' });
  }
  const state = await trigger({
    tenantId: user.clientNumber,
    triggeredBy: user.id,
    reason,
  });
  res.status(201).json(state);
});

router.delete('/kill-switch', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber || !user?.id) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  if (user.userType !== 'SA' && user.userType !== 'AD') {
    return res.status(403).json({ error: 'forbidden', message: 'SA or AD role required' });
  }
  const reason = String(req.body?.reason ?? 'manual release').trim();
  const state = await release(user.clientNumber, user.id, reason);
  res.json(state);
});

export default router;
