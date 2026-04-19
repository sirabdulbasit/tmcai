/**
 * MyOS Entity Routes
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import * as entityService from '../services/entityService';

const router = Router();

// ─── List entities ────────────────────────────────────────────
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const entities = await entityService.listEntities(user.clientNumber, {
      entityType: req.query.entityType as string | undefined as any,
      search: req.query.search as string | undefined,
    });
    res.json({ entities });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get entity with links ────────────────────────────────────
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const entity = await entityService.getEntity(req.params.id as string, user.clientNumber);
    if (!entity) { res.status(404).json({ error: 'Entity not found' }); return; }
    res.json({ entity });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Create entity ────────────────────────────────────────────
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { entityType, name, email, phone, company, role, metadata } = req.body;

    if (!entityType || !name) {
      res.status(400).json({ error: 'entityType and name are required' });
      return;
    }

    const entity = await entityService.createEntity(user.clientNumber, user.id, {
      entityType, name, email, phone, company, role, metadata,
    });
    res.status(201).json({ entity });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Update entity ────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const entity = await entityService.updateEntity(req.params.id as string, user.clientNumber, req.body);
    res.json({ entity });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Link entities ────────────────────────────────────────────
router.post('/link', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { entityId, linkedEntityId, linkType } = req.body;

    if (!entityId || !linkedEntityId || !linkType) {
      res.status(400).json({ error: 'entityId, linkedEntityId, and linkType are required' });
      return;
    }

    const link = await entityService.linkEntities(user.clientNumber, entityId, linkedEntityId, linkType);
    res.json({ link });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── L5.7 — Entity graph traversal (N-hop BFS) ───────────────────
router.get('/:id/graph', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const depth = Math.min(parseInt(String(req.query.depth ?? '2'), 10) || 2, 4);
    const { traverse } = await import('../services/entity/graphService');
    const result = await traverse(user.clientNumber, String(req.params.id), depth);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
