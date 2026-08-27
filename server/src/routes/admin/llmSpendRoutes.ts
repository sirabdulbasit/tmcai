/**
 * Admin — LLM spend per user per day.
 *
 *   GET /admin/llm-spend                              → today
 *   GET /admin/llm-spend?day=YYYY-MM-DD               → one day
 *   GET /admin/llm-spend?from=YYYY-MM-DD&to=YYYY-MM-DD → an inclusive range
 *   GET /admin/llm-spend?period=day|week|month&day=…   → the period containing `day`
 *   &groupBy=day|week|month                            → how the series is bucketed
 *
 * Retention is 62 days (llmSpendService). A month-to-date query near the start of a month will
 * therefore always resolve; "last month" resolves for most of the current one and then starts
 * losing its earliest days. The endpoint reports `days` — how many days actually carried data —
 * so a caller can tell a quiet window from a truncated one.
 */
import { Router, Request, Response } from 'express';
import { requireAdmin } from '../../middleware/auth';
import { getSpendReport } from '../../services/llmSpendService';

const router = Router();

router.get('/llm-spend', requireAdmin, async (req: Request, res: Response) => {
  try {
    const clientNumber = String(req.query.cn || req.user?.clientNumber);
    // Accepts a single day (unchanged) or an inclusive range. `period` is a convenience the UI
    // uses so the client does not have to compute week/month boundaries and disagree with the
    // server about where a week starts.
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const todayStr = iso(new Date());
    const period = String(req.query.period || '');
    let from = String(req.query.from || req.query.day || todayStr);
    let to = String(req.query.to || req.query.day || from);

    if (period) {
      const anchor = new Date(`${String(req.query.day || todayStr)}T00:00:00Z`);
      if (period === 'day') { from = to = iso(anchor); }
      if (period === 'week') {
        // Week starts MONDAY. Stated rather than assumed: getUTCDay() is 0 for Sunday, and a
        // Sunday-start week would put his Monday-to-Friday work across two buckets.
        const dow = (anchor.getUTCDay() + 6) % 7;
        const start = new Date(anchor); start.setUTCDate(anchor.getUTCDate() - dow);
        const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
        from = iso(start); to = iso(end);
      }
      if (period === 'month') {
        const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
        const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
        from = iso(start); to = iso(end);
      }
    }

    // `groupBy` is the BUCKET; `period`/`from`/`to` are the WINDOW. They are independent: a
    // quarter grouped by month is three rows, the same quarter by day is ninety.
    const gb = String(req.query.groupBy || 'day');
    const groupBy = (['day', 'week', 'month'].includes(gb) ? gb : 'day') as 'day' | 'week' | 'month';
    const report = await getSpendReport(clientNumber, from, to, groupBy);
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
