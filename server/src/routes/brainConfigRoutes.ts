/**
 * MyOS Brain Configuration Routes
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import * as brainConfigService from '../services/brainConfigService';
import * as brainEngineService from '../services/brainEngineService';

const router = Router();

// ─── Get brain config (create defaults if none exists) ────────
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const config = await brainConfigService.getOrCreate(user.id, user.clientNumber);
    res.json({ config });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Update brain config (partial) ────────────────────────────
router.patch('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const config = await brainConfigService.update(user.id, user.clientNumber, req.body);
    res.json({ config });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get specific sections ────────────────────────────────────

router.get('/delegation-rules', requireAuth, async (req: Request, res: Response) => {
  try {
    const rules = await brainConfigService.getDelegationRules(req.user!.id);
    res.json({ rules });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/escalation-rules', requireAuth, async (req: Request, res: Response) => {
  try {
    const rules = await brainConfigService.getEscalationRules(req.user!.id);
    res.json({ rules });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/alert-thresholds', requireAuth, async (req: Request, res: Response) => {
  try {
    const thresholds = await brainConfigService.getAlertThresholds(req.user!.id);
    res.json({ thresholds });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/briefing', requireAuth, async (req: Request, res: Response) => {
  try {
    const config = await brainConfigService.getBriefingConfig(req.user!.id);
    res.json({ config });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/context', requireAuth, async (req: Request, res: Response) => {
  try {
    const context = await brainConfigService.getMasterContext(req.user!.id);
    res.json({ context });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Engine endpoints ─────────────────────────────────────────

router.get('/engine/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const status = await brainEngineService.getEngineStatus(req.user!.id);
    res.json(status);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/engine/run', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await brainEngineService.runForUser(req.user!.id, req.user!.clientNumber);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
