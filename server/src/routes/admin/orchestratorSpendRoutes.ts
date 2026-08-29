/**
 * Admin — Build & Heal spend. What the ORCHESTRATOR costs, not what the application costs.
 *
 *   GET /admin/orchestrator-spend                               → today
 *   GET /admin/orchestrator-spend?day=YYYY-MM-DD                → one day
 *   GET /admin/orchestrator-spend?from=…&to=…                   → an inclusive range
 *   GET /admin/orchestrator-spend?period=day|week|month&day=…   → the period containing `day`
 *   &groupBy=day|week|month                                     → how the series is bucketed
 *   &ingest=0                                                   → report without re-reading logs
 *
 * Deliberately a SEPARATE endpoint from /admin/llm-spend. That one reports Gemini/Claude spend
 * billed to the application; this reports Claude Code spend billed to the subscription. Two
 * providers, two bills — a shared endpoint would invite a combined total that means nothing.
 *
 * There is no `cn` / client filter: the orchestrator builds the product, not a tenant's work.
 */
import { Router, Request, Response } from 'express';
import { requireAdmin } from '../../middleware/auth';
import { getOrchestratorSpendReport, ingestOrchestratorSpend } from '../../services/orchestratorSpendService';

const router = Router();

router.get('/orchestrator-spend', requireAdmin, async (req: Request, res: Response) => {
  try {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const todayStr = iso(new Date());
    const period = String(req.query.period || '');
    let from = String(req.query.from || req.query.day || todayStr);
    let to = String(req.query.to || req.query.day || from);

    if (period) {
      const anchor = new Date(`${String(req.query.day || todayStr)}T00:00:00Z`);
      if (period === 'day') { from = to = iso(anchor); }
      if (period === 'week') {
        // MONDAY start, matching date_trunc('week') in the service. If these disagree, a Week
        // row and the Week button cover different days.
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

    const gb = String(req.query.groupBy || 'day');
    const groupBy = (['day', 'week', 'month'].includes(gb) ? gb : 'day') as 'day' | 'week' | 'month';

    // Ingest before reporting so a page load never shows a run that finished five minutes ago
    // as missing. It is an idempotent upsert keyed on run_uid, so the cost is a handful of
    // no-ops. `?ingest=0` skips it for a caller that only wants the stored view.
    let ingest: Awaited<ReturnType<typeof ingestOrchestratorSpend>> | null = null;
    if (String(req.query.ingest ?? '1') !== '0') {
      ingest = await ingestOrchestratorSpend();
    }

    const report = await getOrchestratorSpendReport(from, to, groupBy);
    res.json({ ...report, ingest });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
