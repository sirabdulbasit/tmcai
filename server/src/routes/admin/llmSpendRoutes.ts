/**
 * Admin — LLM spend per user per day.
 *
 *   GET /admin/llm-spend?day=YYYY-MM-DD  → report for one day
 *   GET /admin/llm-spend                 → today
 */
import { Router, Request, Response } from 'express';
import { requireAdmin } from '../../middleware/auth';
import { getSpendReport } from '../../services/llmSpendService';

const router = Router();

router.get('/llm-spend', requireAdmin, async (req: Request, res: Response) => {
  try {
    const clientNumber = String(req.query.cn || req.user?.clientNumber);
    const day = String(req.query.day || new Date().toISOString().slice(0, 10));
    const report = await getSpendReport(clientNumber, day);
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
