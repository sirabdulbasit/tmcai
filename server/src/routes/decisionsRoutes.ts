/**
 * MyOS Gap 5 — Decisions & Patterns Routes
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import * as decisionsLogService from '../services/decisionsLogService';
import * as patternAnalysisService from '../services/patternAnalysisService';
import prisma from '../db/prisma';

const router = Router();

// ─── Decision log ───────────────────────────────────────────────
router.get('/log', requireAuth, async (req: Request, res: Response) => {
  try {
    const decisions = await decisionsLogService.getLast30Days(req.user!.id, req.user!.clientNumber);
    res.json({ decisions });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Patterns ───────────────────────────────────────────────────
router.get('/patterns', requireAuth, async (req: Request, res: Response) => {
  try {
    const brain = await prisma.brainConfig.findUnique({ where: { userId: req.user!.id } });
    res.json({
      confirmedPatterns: brain?.confirmedPatterns ?? [],
      revokedPatterns: brain?.revokedPatterns ?? [],
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/patterns/confirm', requireAuth, async (req: Request, res: Response) => {
  try {
    await patternAnalysisService.confirmPattern(req.user!.id, req.user!.clientNumber, req.body.pattern);
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/patterns/revoke', requireAuth, async (req: Request, res: Response) => {
  try {
    await patternAnalysisService.revokePattern(req.user!.id, req.user!.clientNumber, req.body.patternIndex);
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
