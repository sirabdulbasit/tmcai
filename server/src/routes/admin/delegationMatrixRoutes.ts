/**
 * Admin — Delegation Matrix.
 *
 * Per-tenant "who owns what" routing knowledge map. Editable only by
 * tenant ADMIN/SA. Read-only for non-admin users (they get the matrix
 * indirectly via the Brain composer when chatting with Brain).
 *
 * Routes (mounted at /api/v1/admin/delegation-matrix):
 *   GET    /            list all matrix entries (active + inactive)
 *   GET    /active      list only active entries
 *   POST   /            upsert one entry (insert or replace by area)
 *   DELETE /:area       deactivate (soft delete)
 *   GET    /history/:area   audit history for an area
 */
import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../../middleware/auth';
import prisma from '../../db/prisma';
import {
  listAllEntries,
  listActiveEntries,
  upsertEntry,
  deactivateEntry,
} from '../../services/knowledge/delegationMatrixService';

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await listAllEntries(req.user!.clientNumber);
    res.json({ entries: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/active', async (req: Request, res: Response) => {
  try {
    const rows = await listActiveEntries(req.user!.clientNumber);
    res.json({ entries: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    if (!body.area || !body.ownerName) {
      res.status(400).json({ error: 'area and ownerName are required' });
      return;
    }
    const entry = await upsertEntry(req.user!.clientNumber, req.user!.id, {
      area: String(body.area),
      ownerUserId: body.ownerUserId ?? null,
      ownerName: String(body.ownerName),
      ownerEmail: body.ownerEmail ?? null,
      ownerRole: body.ownerRole ?? null,
      escalateToName: body.escalateToName ?? null,
      escalateToEmail: body.escalateToEmail ?? null,
      notes: body.notes ?? null,
      effectiveFrom: body.effectiveFrom ?? null,
      isActive: body.isActive ?? true,
    });
    res.json({ entry });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:area', async (req: Request, res: Response) => {
  try {
    const ok = await deactivateEntry(
      req.user!.clientNumber,
      req.params.area as string,
      req.user!.id,
    );
    if (!ok) {
      res.status(404).json({ error: 'area not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history/:area', async (req: Request, res: Response) => {
  try {
    const rows = await prisma.delegationMatrixHistory.findMany({
      where: { clientNumber: req.user!.clientNumber, area: req.params.area as string },
      orderBy: { changedAt: 'desc' },
      take: 100,
    });
    res.json({ history: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
