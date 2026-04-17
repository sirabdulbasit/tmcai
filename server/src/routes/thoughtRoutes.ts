/**
 * MyOS Gap 6 — Thought Pipeline Routes
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import * as thoughtPipelineService from '../services/thoughtPipelineService';
import prisma from '../db/prisma';

const router = Router();

// ─── List all entries ───────────────────────────────────────────
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const entries = await thoughtPipelineService.getAllEntries(req.user!.id, req.user!.clientNumber);
    res.json({ entries });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── List drafts only ───────────────────────────────────────────
router.get('/drafts', requireAuth, async (req: Request, res: Response) => {
  try {
    const entries = await thoughtPipelineService.getDraftEntries(req.user!.id, req.user!.clientNumber);
    res.json({ entries });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Create user note ───────────────────────────────────────────
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { title, content, relatedEntityIds, relatedItemIds } = req.body;
    if (!title || !content) { res.status(400).json({ error: 'title and content are required' }); return; }

    const entry = await thoughtPipelineService.createUserNote({
      userId: req.user!.id,
      clientNumber: req.user!.clientNumber,
      title, content, relatedEntityIds, relatedItemIds,
    });
    res.json({ entry });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Publish entry ──────────────────────────────────────────────
router.post('/:id/publish', requireAuth, async (req: Request, res: Response) => {
  try {
    await thoughtPipelineService.publishEntry(req.params.id as string, req.user!.id, req.user!.clientNumber);
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Update entry ───────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { title, content, status } = req.body;
    await prisma.thoughtEntry.updateMany({
      where: { id: req.params.id as string, userId: req.user!.id, clientNumber: req.user!.clientNumber },
      data: { ...(title && { title }), ...(content && { content }), ...(status && { status }) },
    });
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Dismiss entry ──────────────────────────────────────────────
router.post('/:id/dismiss', requireAuth, async (req: Request, res: Response) => {
  try {
    await prisma.thoughtEntry.updateMany({
      where: { id: req.params.id as string, userId: req.user!.id },
      data: { status: 'dismissed' },
    });
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
