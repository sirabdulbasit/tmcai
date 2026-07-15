/**
 * MyOS Gap 5 — Decisions & Patterns Routes
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import * as decisionsLogService from '../services/decisionsLogService';
import * as patternAnalysisService from '../services/patternAnalysisService';
import { record as recordDecision, list as listDecisions } from '../services/decisions/decisionLogService';
import prisma from '../db/prisma';

const router = Router();

// ─── HaseebOS v15: agent-callable decision log writer ──────────────
router.post('/', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const body = req.body ?? {};
  if (!body.userDecision || typeof body.isMatch !== 'boolean') {
    return res.status(400).json({ error: 'userDecision and isMatch (boolean) required' });
  }
  try {
    const result = await recordDecision({
      userId: body.userId ?? user.id,
      clientNumber: body.clientNumber ?? user.clientNumber,
      sessionType: body.sessionType ?? 'intraday',
      itemType: body.itemType ?? 'manual',
      entityId: body.entityId,
      connectorSlug: body.connectorSlug,
      suggestedAction: body.suggestedAction,
      userDecision: body.userDecision,
      actionTaken: body.actionTaken,
      isMatch: body.isMatch,
      overrideReason: body.overrideReason,
      responseTimeMs: body.responseTimeMs,
      outcome: body.outcome,
      openItemId: body.openItemId,
      confidenceScore: body.confidenceScore,
      riskTier: body.riskTier,
      inputSummary: body.inputSummary,
      outputSummary: body.outputSummary,
      durationMs: body.durationMs,
      traceId: body.traceId,
      agentId: body.agentId ?? user.agentId,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const rows = await listDecisions(user.clientNumber, {
    take: parseInt(String(req.query.take ?? '100'), 10),
    riskTier: req.query.riskTier as any,
    userDecision: req.query.userDecision as any,
  });
  res.json({ rows });
});

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
