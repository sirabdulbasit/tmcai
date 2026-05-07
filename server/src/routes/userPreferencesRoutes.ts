/**
 * /api/user/preferences — per-user UI prefs.
 *   GET   → returns the resolved preferences (per-user merged with defaults)
 *   PATCH → updates one or more keys; returns the new effective values
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { getUserPreferences, updateUserPreferences } from '../services/userPreferencesService';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    const prefs = await getUserPreferences(user.id);
    res.json(prefs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const body = req.body ?? {};
  const patch: any = {};
  if (body.attentionWindowDays !== undefined) {
    const n = Number(body.attentionWindowDays);
    if (!Number.isFinite(n)) return res.status(400).json({ error: 'attentionWindowDays must be a number' });
    patch.attentionWindowDays = n;
  }
  if (body.briefWindowDays !== undefined) {
    const n = Number(body.briefWindowDays);
    if (!Number.isFinite(n)) return res.status(400).json({ error: 'briefWindowDays must be a number' });
    patch.briefWindowDays = n;
  }
  try {
    const prefs = await updateUserPreferences(user.id, patch);
    res.json(prefs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
