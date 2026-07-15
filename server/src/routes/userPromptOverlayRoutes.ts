/**
 * /brain/overlay routes — CRUD for the per-user prompt overlay.
 *
 *   GET  /brain/overlay        list all rules (active + inactive)
 *   POST /brain/overlay        create a manual rule
 *   PATCH /brain/overlay/:id   edit text or toggle active
 *   DEL  /brain/overlay/:id    delete one rule
 *   POST /brain/overlay/reset  delete all rules for the user
 *
 * Auth: requireAuth — every route is scoped to the calling user. The
 * service guarantees rows are filtered by userId so a user can't touch
 * another user's overlay.
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import * as svc from '../services/knowledge/userPromptOverlayService';

const router = Router();

router.get('/overlay', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    const rules = await svc.listAll(user.clientNumber, user.id);
    res.json({ rules });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/overlay', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { ruleText, category } = req.body ?? {};
  if (typeof ruleText !== 'string' || !ruleText.trim()) {
    res.status(400).json({ error: 'ruleText required' });
    return;
  }
  try {
    const id = await svc.createManual({
      clientNumber: user.clientNumber,
      userId: user.id,
      ruleText,
      category: typeof category === 'string' ? category : 'custom',
    });
    res.status(201).json({ id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/overlay/:id', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { ruleText, active } = req.body ?? {};
  try {
    await svc.updateRule({
      id: req.params.id as string, userId: user.id,
      ruleText: typeof ruleText === 'string' ? ruleText : undefined,
      active: typeof active === 'boolean' ? active : undefined,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/overlay/:id', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    await svc.deleteRule({ id: req.params.id as string, userId: user.id });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/overlay/reset', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    const count = await svc.resetAll({ clientNumber: user.clientNumber, userId: user.id });
    res.json({ ok: true, deleted: count });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
