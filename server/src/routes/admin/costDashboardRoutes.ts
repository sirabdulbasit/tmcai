/**
 * Admin — Cost Dashboard.
 *
 * Per-tenant LLM spend dashboard. Inspired by HaseebOS v16's Looker
 * board, but rendered server-side from Postgres so multi-tenant
 * isolation is enforced at every read and admins see only their own
 * tenant's spend.
 *
 * Routes (all admin-gated):
 *   GET /cost/timeline?days=30
 *   GET /cost/by-user?days=30&limit=10
 *   GET /cost/by-purpose?days=30&limit=10
 *   GET /cost/by-provider?days=30
 *   GET /cost/anomaly
 *   GET /cost/per-tenant?days=30   (SA only — cross-tenant billing rollup)
 *   GET /cost/dashboard            self-contained HTML view (Chart.js)
 *
 * The HTML at `/cost/dashboard` is the single visual surface — admins
 * open it directly; the JSON endpoints power the charts on that page
 * and are also useful for client-side dashboards or ad-hoc API use.
 */
import { Router, Request, Response } from 'express';
import { requireAdmin, requireSuperAdmin } from '../../middleware/auth';
import {
  getTimeline, getByUser, getByPurpose, getByProvider,
  getAnomaly, getPerTenant,
} from '../../services/llmSpendService';
import { renderCostDashboardHtml } from './costDashboardHtml';

const router = Router();

router.get('/cost/timeline', requireAdmin, async (req: Request, res: Response) => {
  try {
    const days = clampDays(req.query.days);
    const data = await getTimeline(req.user!.clientNumber, days);
    res.json({ days, points: data });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/cost/by-user', requireAdmin, async (req: Request, res: Response) => {
  try {
    const days = clampDays(req.query.days);
    const limit = clampLimit(req.query.limit, 10, 50);
    const rows = await getByUser(req.user!.clientNumber, days, limit);
    res.json({ days, rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/cost/by-purpose', requireAdmin, async (req: Request, res: Response) => {
  try {
    const days = clampDays(req.query.days);
    const limit = clampLimit(req.query.limit, 10, 50);
    const rows = await getByPurpose(req.user!.clientNumber, days, limit);
    res.json({ days, rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/cost/by-provider', requireAdmin, async (req: Request, res: Response) => {
  try {
    const days = clampDays(req.query.days);
    const rows = await getByProvider(req.user!.clientNumber, days);
    res.json({ days, rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/cost/anomaly', requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await getAnomaly(req.user!.clientNumber);
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/cost/per-tenant', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const days = clampDays(req.query.days);
    const rows = await getPerTenant(days);
    res.json({ days, rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * Self-contained HTML dashboard. Loads Chart.js from CDN; pulls all
 * data from the JSON endpoints above. The bearer token must be in a
 * cookie or accessible via window.localStorage.token — we read it
 * client-side and fetch with Authorization header.
 *
 * Per-tenant by definition (the JSON endpoints scope by req.user.
 * clientNumber). SA users see their own tenant; the cross-tenant view
 * is its own table on the page when the SA flag is set.
 */
router.get('/cost/dashboard', requireAdmin, async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderCostDashboardHtml({
    tenantNumber: req.user!.clientNumber,
    isSuperAdmin: !!req.user!.isSuperAdmin,
    userName: req.user!.name,
  }));
});

// ─── helpers ──────────────────────────────────────────────────────

function clampDays(input: unknown): number {
  const n = parseInt(String(input ?? '30')) || 30;
  return Math.max(1, Math.min(n, 90));
}

function clampLimit(input: unknown, defaultV: number, maxV: number): number {
  const n = parseInt(String(input ?? defaultV)) || defaultV;
  return Math.max(1, Math.min(n, maxV));
}

export default router;
