/**
 * MyOS Open Items Routes
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import * as openItemsService from '../services/openItemsService';

const router = Router();

// ─── List open items ──────────────────────────────────────────
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const items = await openItemsService.listItems(user.id, user.clientNumber, {
      status: req.query.status as any,
      priority: req.query.priority as any,
      type: req.query.type as any,
      entityId: req.query.entityId as string | undefined,
      sourceFeed: req.query.sourceFeed as string | undefined,
    });
    res.json({ items });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get item stats ───────────────────────────────────────────
router.get('/stats', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const stats = await openItemsService.getStats(user.id, user.clientNumber);
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get single item ──────────────────────────────────────────
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const item = await openItemsService.getItem(req.params.id as string, user.clientNumber);
    if (!item) { res.status(404).json({ error: 'Item not found' }); return; }
    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Create item ──────────────────────────────────────────────
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { title, description, entityId, type, priority, dueDate, sourceFeed, sourceRef, metadata } = req.body;

    if (!title || !type) {
      res.status(400).json({ error: 'title and type are required' });
      return;
    }

    const item = await openItemsService.createItem(user.id, user.clientNumber, {
      title, description, entityId, type, priority,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      sourceFeed, sourceRef, metadata,
    });
    res.status(201).json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Update item ──────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { title, description, entityId, status, priority, dueDate, metadata } = req.body;

    const item = await openItemsService.updateItem(req.params.id as string, user.clientNumber, {
      title, description, entityId, status, priority,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      metadata,
    });
    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Change status ────────────────────────────────────────────
router.post('/:id/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { status, note } = req.body;
    const item = await openItemsService.changeStatus(req.params.id as string, user.clientNumber, status, note);
    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Delegate item ────────────────────────────────────────────
router.post('/:id/delegate', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { delegateeId, delegateeName, delegateeEmail, note } = req.body;

    if (!delegateeName) {
      res.status(400).json({ error: 'delegateeName is required' });
      return;
    }

    const item = await openItemsService.delegateItem(
      req.params.id as string, user.clientNumber,
      delegateeId || null, delegateeName, delegateeEmail, note,
    );
    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Add note ─────────────────────────────────────────────────
router.post('/:id/note', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { text } = req.body;
    if (!text) { res.status(400).json({ error: 'text is required' }); return; }
    const item = await openItemsService.addNote(req.params.id as string, user.clientNumber, text, user.id);
    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
