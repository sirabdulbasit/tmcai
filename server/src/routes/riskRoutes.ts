import { Router, Request, Response } from 'express';
import { approve, reject, listPending } from '../services/risk/approvalWorkflow';
import { assess } from '../services/risk/riskGatingService';
import prisma from '../db/prisma';

const router = Router();

router.get('/config', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const rows = await prisma.systemConfig.findMany({
    where: {
      clientNumber: user.clientNumber,
      key: { in: ['risk_low_threshold_usd', 'risk_medium_threshold_usd', 'risk_vip_emails'] },
    },
  });
  const config = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  res.json(config);
});

router.put('/config', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  if (user.userType !== 'SA' && user.userType !== 'AD') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const allowed = ['risk_low_threshold_usd', 'risk_medium_threshold_usd', 'risk_vip_emails'];
  for (const [key, value] of Object.entries(req.body ?? {})) {
    if (!allowed.includes(key)) continue;
    await prisma.systemConfig.upsert({
      where: { clientNumber_key: { clientNumber: user.clientNumber, key } },
      create: { clientNumber: user.clientNumber, key, value: String(value) },
      update: { value: String(value) },
    });
  }
  res.json({ updated: true });
});

router.get('/pending-approvals', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const rows = await listPending(user.clientNumber);
  res.json(rows);
});

router.post('/approve/:actionId', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.id) return res.status(401).json({ error: 'unauthenticated' });
  const actionId = parseInt(String(req.params.actionId), 10);
  if (!Number.isFinite(actionId)) return res.status(400).json({ error: 'invalid actionId' });
  await approve(actionId, user.id);
  res.json({ approved: true, actionId });
});

router.post('/reject/:actionId', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.id) return res.status(401).json({ error: 'unauthenticated' });
  const actionId = parseInt(String(req.params.actionId), 10);
  if (!Number.isFinite(actionId)) return res.status(400).json({ error: 'invalid actionId' });
  const reason = String(req.body?.reason ?? 'rejected by user');
  await reject(actionId, user.id, reason);
  res.json({ rejected: true, actionId });
});

router.post('/assess', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber || !user?.id) return res.status(401).json({ error: 'unauthenticated' });
  const body = req.body ?? {};
  const result = await assess({
    clientNumber: user.clientNumber,
    userId: user.id,
    actionType: String(body.actionType ?? ''),
    openItemId: body.openItemId,
    entityId: body.entityId,
    payload: body.payload,
    financialValueUsd: body.financialValueUsd,
    targetIsVip: body.targetIsVip,
    targetIsExternal: body.targetIsExternal,
  });
  res.json(result);
});

export default router;
