/**
 * Risk Rules — per-user routes for managing what fires on Risk Radar.
 *
 *   GET    /                         list visible rules + overrides
 *   POST   /                         create user-scope rule
 *   PATCH  /:id                      edit rule (own user-rules / admin tenant)
 *   DELETE /:id                      delete rule (own user-rules / admin tenant)
 *   POST   /system/:ruleKey/disable  disable a system rule for self (or
 *                                    tenant if admin + ?scope=tenant)
 *   POST   /system/:ruleKey/enable   re-enable a previously disabled system rule
 *   POST   /test                     dry-run a predicate against test ctx
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  listRulesEditable, createUserRule, updateRule, deleteRule, toggleSystemRule,
} from '../services/brain/riskRulesService';
import { matches as matchPredicate, type Predicate } from '../services/triage/ruleEngineService';

const router = Router();
router.use(requireAuth);

router.get('/', async (req: Request, res: Response) => {
  try {
    const out = await listRulesEditable(
      req.user!.clientNumber, req.user!.id, !!req.user!.isAdmin,
    );
    res.json(out);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    if (!body.name || !body.source || !body.predicate) {
      res.status(400).json({ error: 'name, source, and predicate are required' });
      return;
    }
    if (!['feed_event', 'open_item', 'wiki_page'].includes(body.source)) {
      res.status(400).json({ error: 'source must be feed_event | open_item | wiki_page' });
      return;
    }
    if (!['low', 'medium', 'high'].includes(body.severity ?? 'medium')) {
      res.status(400).json({ error: 'severity must be low | medium | high' });
      return;
    }
    const rule = await createUserRule(req.user!.clientNumber, req.user!.id, {
      name: String(body.name),
      description: body.description ?? null,
      source: body.source,
      lookbackHours: body.lookbackHours ?? 24,
      predicate: body.predicate,
      severity: body.severity ?? 'medium',
      titleTemplate: body.titleTemplate ?? null,
      reasonTemplate: body.reasonTemplate ?? null,
      suggestedAction: body.suggestedAction ?? null,
      enabled: body.enabled !== false,
    });
    res.status(201).json({ rule });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    const rule = await updateRule(
      id, req.user!.clientNumber, req.user!.id, !!req.user!.isAdmin,
      req.body ?? {},
    );
    res.json({ rule });
  } catch (err: any) {
    res.status(/admin required|not your rule|immutable/.test(err.message) ? 403 : 400)
       .json({ error: err.message });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    await deleteRule(id, req.user!.clientNumber, req.user!.id, !!req.user!.isAdmin);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(/admin required|not your|cannot be deleted/.test(err.message) ? 403 : 400)
       .json({ error: err.message });
  }
});

router.post('/system/:ruleKey/disable', async (req: Request, res: Response) => {
  try {
    const reason = String((req.body ?? {}).reason ?? '');
    const scope = String(req.query.scope ?? 'user') === 'tenant' ? 'tenant' : 'user';
    await toggleSystemRule(
      req.params.ruleKey as string,
      req.user!.clientNumber, req.user!.id, !!req.user!.isAdmin,
      scope, true, reason,
    );
    res.json({ ok: true, scope });
  } catch (err: any) { res.status(/admin required/.test(err.message) ? 403 : 400).json({ error: err.message }); }
});

router.post('/system/:ruleKey/enable', async (req: Request, res: Response) => {
  try {
    const scope = String(req.query.scope ?? 'user') === 'tenant' ? 'tenant' : 'user';
    await toggleSystemRule(
      req.params.ruleKey as string,
      req.user!.clientNumber, req.user!.id, !!req.user!.isAdmin,
      scope, false,
    );
    res.json({ ok: true, scope });
  } catch (err: any) { res.status(/admin required/.test(err.message) ? 403 : 400).json({ error: err.message }); }
});

router.post('/test', async (req: Request, res: Response) => {
  // Dry-run a predicate against an example row context. Returns true/false
  // without touching any data.
  try {
    const body = req.body ?? {};
    if (!body.predicate || !body.ctx) {
      res.status(400).json({ error: 'predicate and ctx required' });
      return;
    }
    const result = matchPredicate(body.predicate as Predicate, body.ctx);
    res.json({ matched: result });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

export default router;
