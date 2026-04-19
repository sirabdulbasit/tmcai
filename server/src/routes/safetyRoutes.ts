import { Router, Request, Response } from 'express';
import { trigger, release, getState } from '../services/safety/killSwitchService';

const router = Router();

router.get('/kill-switch/status', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  const state = await getState(user.clientNumber);
  res.json(state);
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
