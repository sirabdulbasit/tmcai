/**
 * Risk Radar — per-user routes.
 *
 * GET    /latest        most recent RiskFlagDoc for current user
 * GET    /history       last 30 days of RiskFlagDocs
 * GET    /config        the user's risk_radar_config (with defaults filled in)
 * PATCH  /config        update partial config; reschedules cron if needed
 * POST   /run-now       run the radar synchronously and return the doc
 *
 * All routes are user-scoped — a user only sees and edits their own
 * radar. Tenant isolation is enforced at every read by clientNumber.
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import prisma from '../db/prisma';
import {
  runForUser,
  loadConfig,
  saveConfig,
  getLatestForUser,
  DEFAULT_RADAR_CONFIG,
} from '../services/brain/riskRadarService';
import { registerUserRiskRadarCron, stopUserRiskRadarCron } from '../services/schedulerService';

const router = Router();
router.use(requireAuth);

router.get('/latest', async (req: Request, res: Response) => {
  try {
    const doc = await getLatestForUser(req.user!.clientNumber, req.user!.id);
    res.json({ doc, defaults: doc ? null : { message: 'No radar runs yet — POST /run-now to generate the first one.' } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history', async (req: Request, res: Response) => {
  try {
    const docs = await prisma.riskFlagDoc.findMany({
      where: { clientNumber: req.user!.clientNumber, userId: req.user!.id, status: 'active' },
      orderBy: { runDate: 'desc' },
      take: 30,
      select: {
        id: true, runDate: true, generatedAt: true,
        flagCount: true, highSeverityCount: true, summary: true,
      },
    });
    res.json({ docs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/config', async (req: Request, res: Response) => {
  try {
    const config = await loadConfig(req.user!.clientNumber, req.user!.id);
    res.json({ config, defaults: DEFAULT_RADAR_CONFIG });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/config', async (req: Request, res: Response) => {
  try {
    const patch = req.body ?? {};
    const updated = await saveConfig(req.user!.clientNumber, req.user!.id, patch);
    // Rebind the cron with the new schedule if it changed (or was just enabled).
    if (updated.enabled) {
      registerUserRiskRadarCron(req.user!.id, req.user!.clientNumber, updated.schedule, updated.timezone);
    } else {
      stopUserRiskRadarCron(req.user!.id, req.user!.clientNumber);
    }
    res.json({ config: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/run-now', async (req: Request, res: Response) => {
  try {
    const result = await runForUser(req.user!.clientNumber, req.user!.id, { force: true });
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:docId', async (req: Request, res: Response) => {
  try {
    const doc = await prisma.riskFlagDoc.findUnique({ where: { id: req.params.docId as string } });
    if (!doc || doc.clientNumber !== req.user!.clientNumber || doc.userId !== req.user!.id) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ doc });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
