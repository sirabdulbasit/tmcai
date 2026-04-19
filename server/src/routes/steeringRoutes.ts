import { Router, Request, Response } from 'express';
import * as steering from '../services/steering/steeringWheelService';
import { publish } from '../services/infra/pubsubPublisher';
import { PUBSUB_TOPICS } from '../config/pubsub';

const router = Router();

router.get('/dashboard', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const rows = await steering.dashboard(user.clientNumber);
  res.json({ rows });
});

router.get('/trends/:metric', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const metric = String(req.params.metric) as steering.KpiMetricType;
  const days = parseInt(String(req.query.days ?? '30'), 10);
  const rows = await steering.trend(user.clientNumber, metric, days);
  res.json({ metric, rows });
});

router.get('/alerts', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const rows = await steering.alerts(user.clientNumber);
  res.json({ rows });
});

router.post('/snapshot', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  if (user.userType !== 'SA' && user.userType !== 'AD') return res.status(403).json({ error: 'forbidden' });
  const forDate = req.body?.date ? new Date(String(req.body.date)) : undefined;
  const records = await steering.computeDailySnapshot(user.clientNumber, forDate);
  res.json({ count: records.length, records });
});

/**
 * L4.4 — on-demand Morning Brief (outside the 06:00 PKT cron).
 */
router.post('/brief', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const userId = req.body?.userId ?? user.id;
  try {
    const { composeBriefFor } = await import('../services/steering/morningBriefService');
    const brief = await composeBriefFor(user.clientNumber, Number(userId));
    res.json({ ok: true, brief });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * L4.6 — UI event firehose. Every Steering Wheel interaction that matters
 * for Brain observability / Reflection training posts here. Body:
 *   { event: 'brain_query_submitted', details?: {...} }
 */
router.post('/event', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const event = String(req.body?.event ?? '');
  if (!event) return res.status(400).json({ error: 'event required' });
  try {
    await publish(
      PUBSUB_TOPICS.STEERING_WHEEL_EVENTS,
      {
        event,
        clientNumber: user.clientNumber,
        actor: `user:${user.id}`,
        details: req.body?.details ?? {},
        occurredAt: new Date().toISOString(),
      },
      {
        tenantId: user.clientNumber,
        orderingKey: `${user.clientNumber}:steering:${user.id}`,
        attributes: { event, actor: `user:${user.id}` },
      },
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * L5.9 Brain tool support — snapshot-state endpoint aggregates tenant counts.
 */
router.get('/snapshot-state', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const rows = await steering.dashboard(user.clientNumber);
    res.json({ tenantId: user.clientNumber, snapshot: rows, generatedAt: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
