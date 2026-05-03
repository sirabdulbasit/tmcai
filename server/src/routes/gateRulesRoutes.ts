/**
 * Rule-Engine Gate routes.
 *
 * Two surfaces:
 *
 *   /api/v1/gate-rules                user-scoped (own rules + visible system+tenant rules)
 *   /api/v1/admin/gate-rules          admin-scoped (tenant rules CRUD + override system)
 *
 * Both routers live here because they share the same service layer.
 * Mounting in app.ts: the user router is mounted at /gate-rules, the
 * admin router at /admin/gate-rules.
 *
 * What each scope can do:
 *   Anonymous user (logged-in):
 *     - View their own rules + visible system + visible tenant rules
 *     - Create / edit / delete their OWN rules
 *     - Disable / re-enable a system rule for themselves
 *   Tenant admin (SA / AD):
 *     - Everything above, plus:
 *     - Create / edit / delete TENANT rules
 *     - Disable / re-enable a system rule for the whole tenant
 *     - Read firing metrics for the tenant
 */
import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import prisma from '../db/prisma';
import { invalidateRuleCache, matches as predicateMatches, type Predicate } from '../services/triage/ruleEngineService';

// ─── Shared validators ────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validatePredicate(p: unknown, depth = 0): string | null {
  if (depth > 6) return 'predicate nested too deep (max 6 levels)';
  if (!isPlainObject(p)) return 'predicate must be an object';
  if ('all' in p) {
    if (!Array.isArray(p.all)) return 'all must be an array';
    for (const sub of p.all) { const e = validatePredicate(sub, depth + 1); if (e) return e; }
    return null;
  }
  if ('any' in p) {
    if (!Array.isArray(p.any)) return 'any must be an array';
    for (const sub of p.any) { const e = validatePredicate(sub, depth + 1); if (e) return e; }
    return null;
  }
  if ('not' in p) return validatePredicate(p.not, depth + 1);
  // Atomic
  if (typeof p.field !== 'string') return 'atomic predicate needs string field';
  if (typeof p.op !== 'string') return 'atomic predicate needs string op';
  return null;
}

function validateAction(a: unknown): string | null {
  if (!isPlainObject(a)) return 'action must be an object';
  const allowedDecisions = ['auto_handle', 'auto_ack', 'defer', 'escalate', 'block'];
  if (!allowedDecisions.includes(String(a.decision))) {
    return `action.decision must be one of: ${allowedDecisions.join(', ')}`;
  }
  return null;
}

// ─── User-scoped router ───────────────────────────────────────────

export const userGateRulesRouter = Router();
userGateRulesRouter.use(requireAuth);

userGateRulesRouter.get('/', async (req: Request, res: Response) => {
  // Returns visible rules: user's own + tenant + system. Plus the
  // user's overrides so the UI can render "you've disabled this system rule".
  try {
    const [rules, overrides] = await Promise.all([
      prisma.gateRule.findMany({
        where: {
          enabled: true,
          OR: [
            { scope: 'system', clientNumber: null },
            { scope: 'tenant', clientNumber: req.user!.clientNumber },
            { scope: 'user', clientNumber: req.user!.clientNumber, userId: req.user!.id },
          ],
        },
        orderBy: [{ priority: 'asc' }, { name: 'asc' }],
      }),
      prisma.gateRuleOverride.findMany({
        where: {
          OR: [
            { clientNumber: req.user!.clientNumber, scope: 'tenant' },
            { clientNumber: req.user!.clientNumber, scope: 'user', userId: req.user!.id },
          ],
        },
      }),
    ]);
    res.json({ rules, overrides });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

userGateRulesRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const predErr = validatePredicate(body.predicate);
    if (predErr) { res.status(400).json({ error: predErr }); return; }
    const actErr = validateAction(body.action);
    if (actErr) { res.status(400).json({ error: actErr }); return; }
    if (!body.name) { res.status(400).json({ error: 'name required' }); return; }
    const row = await prisma.gateRule.create({
      data: {
        scope: 'user',
        clientNumber: req.user!.clientNumber,
        userId: req.user!.id,
        name: String(body.name).slice(0, 200),
        description: body.description ? String(body.description) : null,
        predicate: body.predicate,
        action: body.action,
        priority: typeof body.priority === 'number' ? body.priority : 100,
        enabled: body.enabled !== false,
        createdByUserId: req.user!.id,
      },
    });
    await invalidateRuleCache(req.user!.clientNumber, req.user!.id);
    res.status(201).json({ rule: row });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

userGateRulesRouter.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const existing = await prisma.gateRule.findUnique({ where: { id } });
    if (!existing) { res.status(404).json({ error: 'not found' }); return; }
    if (existing.scope !== 'user' || existing.userId !== req.user!.id || existing.clientNumber !== req.user!.clientNumber) {
      res.status(403).json({ error: 'cannot edit a rule you do not own' });
      return;
    }
    const body = req.body ?? {};
    if (body.predicate !== undefined) {
      const e = validatePredicate(body.predicate);
      if (e) { res.status(400).json({ error: e }); return; }
    }
    if (body.action !== undefined) {
      const e = validateAction(body.action);
      if (e) { res.status(400).json({ error: e }); return; }
    }
    const updated = await prisma.gateRule.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: String(body.name).slice(0, 200) }),
        ...(body.description !== undefined && { description: body.description ? String(body.description) : null }),
        ...(body.predicate !== undefined && { predicate: body.predicate }),
        ...(body.action !== undefined && { action: body.action }),
        ...(body.priority !== undefined && { priority: body.priority }),
        ...(body.enabled !== undefined && { enabled: !!body.enabled }),
        updatedByUserId: req.user!.id,
      },
    });
    await invalidateRuleCache(req.user!.clientNumber, req.user!.id);
    res.json({ rule: updated });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

userGateRulesRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const existing = await prisma.gateRule.findUnique({ where: { id } });
    if (!existing) { res.status(404).json({ error: 'not found' }); return; }
    if (existing.scope !== 'user' || existing.userId !== req.user!.id || existing.clientNumber !== req.user!.clientNumber) {
      res.status(403).json({ error: 'cannot delete a rule you do not own' });
      return;
    }
    await prisma.gateRule.delete({ where: { id } });
    await invalidateRuleCache(req.user!.clientNumber, req.user!.id);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

userGateRulesRouter.post('/system/:ruleKey/disable', async (req: Request, res: Response) => {
  try {
    const reason = String((req.body ?? {}).reason ?? 'user disabled').slice(0, 1000);
    await prisma.gateRuleOverride.upsert({
      where: {
        ruleKey_scope_clientNumber_userId: {
          ruleKey: req.params.ruleKey as string,
          scope: 'user',
          clientNumber: req.user!.clientNumber,
          userId: req.user!.id,
        },
      } as any,
      create: {
        ruleKey: req.params.ruleKey as string,
        scope: 'user',
        clientNumber: req.user!.clientNumber,
        userId: req.user!.id,
        disabled: true,
        reason,
      },
      update: { disabled: true, reason },
    });
    await invalidateRuleCache(req.user!.clientNumber, req.user!.id);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

userGateRulesRouter.post('/system/:ruleKey/enable', async (req: Request, res: Response) => {
  try {
    await prisma.gateRuleOverride.deleteMany({
      where: {
        ruleKey: req.params.ruleKey as string,
        scope: 'user',
        clientNumber: req.user!.clientNumber,
        userId: req.user!.id,
      },
    });
    await invalidateRuleCache(req.user!.clientNumber, req.user!.id);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

userGateRulesRouter.post('/test', async (req: Request, res: Response) => {
  // Dry-run a predicate against an example event without persisting.
  try {
    const body = req.body ?? {};
    const e = validatePredicate(body.predicate);
    if (e) { res.status(400).json({ error: e }); return; }
    const ev = body.event ?? {};
    const ctx = {
      sender_email: String(ev.senderEmail ?? '').toLowerCase(),
      sender_domain: String(ev.senderEmail ?? '').toLowerCase().split('@')[1] ?? '',
      sender_name: String(ev.senderName ?? '').toLowerCase(),
      subject: String(ev.subject ?? '').toLowerCase(),
      body_preview: String(ev.body ?? '').toLowerCase(),
      source_type: String(ev.sourceType ?? 'gmail'),
      event_type: String(ev.eventType ?? ''),
      recipient_count: Number(ev.recipientCount ?? 1),
      is_cc_only: !!ev.isCcOnly,
      has_attachment: !!ev.hasAttachment,
      time_of_day_hour: new Date().getHours(),
      day_of_week: new Date().getDay(),
    };
    const matched = predicateMatches(body.predicate as Predicate, ctx);
    res.json({ matched, ctx });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

// ─── Admin-scoped router ──────────────────────────────────────────

export const adminGateRulesRouter = Router();
adminGateRulesRouter.use(requireAuth, requireAdmin);

adminGateRulesRouter.get('/', async (req: Request, res: Response) => {
  // List ALL rules visible to this tenant + the tenant's overrides.
  try {
    const [rules, overrides] = await Promise.all([
      prisma.gateRule.findMany({
        where: {
          OR: [
            { scope: 'system', clientNumber: null },
            { scope: 'tenant', clientNumber: req.user!.clientNumber },
            { scope: 'user', clientNumber: req.user!.clientNumber },
          ],
        },
        orderBy: [{ scope: 'asc' }, { priority: 'asc' }],
      }),
      prisma.gateRuleOverride.findMany({
        where: { clientNumber: req.user!.clientNumber, scope: 'tenant' },
      }),
    ]);
    res.json({ rules, overrides });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

adminGateRulesRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const predErr = validatePredicate(body.predicate);
    if (predErr) { res.status(400).json({ error: predErr }); return; }
    const actErr = validateAction(body.action);
    if (actErr) { res.status(400).json({ error: actErr }); return; }
    if (!body.name) { res.status(400).json({ error: 'name required' }); return; }
    const row = await prisma.gateRule.create({
      data: {
        scope: 'tenant',
        clientNumber: req.user!.clientNumber,
        name: String(body.name).slice(0, 200),
        description: body.description ? String(body.description) : null,
        predicate: body.predicate,
        action: body.action,
        priority: typeof body.priority === 'number' ? body.priority : 100,
        enabled: body.enabled !== false,
        createdByUserId: req.user!.id,
      },
    });
    await invalidateRuleCache(req.user!.clientNumber);
    res.status(201).json({ rule: row });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

adminGateRulesRouter.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const existing = await prisma.gateRule.findUnique({ where: { id } });
    if (!existing) { res.status(404).json({ error: 'not found' }); return; }
    if (existing.scope !== 'tenant' || existing.clientNumber !== req.user!.clientNumber) {
      res.status(403).json({ error: 'cannot edit this rule via admin route' });
      return;
    }
    const body = req.body ?? {};
    if (body.predicate !== undefined) {
      const e = validatePredicate(body.predicate);
      if (e) { res.status(400).json({ error: e }); return; }
    }
    if (body.action !== undefined) {
      const e = validateAction(body.action);
      if (e) { res.status(400).json({ error: e }); return; }
    }
    const updated = await prisma.gateRule.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: String(body.name).slice(0, 200) }),
        ...(body.description !== undefined && { description: body.description ? String(body.description) : null }),
        ...(body.predicate !== undefined && { predicate: body.predicate }),
        ...(body.action !== undefined && { action: body.action }),
        ...(body.priority !== undefined && { priority: body.priority }),
        ...(body.enabled !== undefined && { enabled: !!body.enabled }),
        updatedByUserId: req.user!.id,
      },
    });
    await invalidateRuleCache(req.user!.clientNumber);
    res.json({ rule: updated });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

adminGateRulesRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const existing = await prisma.gateRule.findUnique({ where: { id } });
    if (!existing) { res.status(404).json({ error: 'not found' }); return; }
    if (existing.scope !== 'tenant' || existing.clientNumber !== req.user!.clientNumber) {
      res.status(403).json({ error: 'cannot delete this rule via admin route' });
      return;
    }
    await prisma.gateRule.delete({ where: { id } });
    await invalidateRuleCache(req.user!.clientNumber);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

adminGateRulesRouter.post('/system/:ruleKey/disable', async (req: Request, res: Response) => {
  // Tenant-wide overrides have user_id=NULL. Postgres unique constraints
  // treat NULLs as distinct, so we don't rely on upsert here — delete the
  // existing tenant-wide row (if any) and create a fresh one in one txn.
  try {
    const reason = String((req.body ?? {}).reason ?? 'tenant admin disabled').slice(0, 1000);
    const ruleKey = req.params.ruleKey as string;
    await prisma.$transaction([
      prisma.gateRuleOverride.deleteMany({
        where: {
          ruleKey,
          scope: 'tenant',
          clientNumber: req.user!.clientNumber,
          userId: null,
        },
      }),
      prisma.gateRuleOverride.create({
        data: {
          ruleKey,
          scope: 'tenant',
          clientNumber: req.user!.clientNumber,
          disabled: true,
          reason,
        },
      }),
    ]);
    await invalidateRuleCache(req.user!.clientNumber);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

adminGateRulesRouter.post('/system/:ruleKey/enable', async (req: Request, res: Response) => {
  try {
    await prisma.gateRuleOverride.deleteMany({
      where: {
        ruleKey: req.params.ruleKey as string,
        scope: 'tenant',
        clientNumber: req.user!.clientNumber,
        userId: null,
      },
    });
    await invalidateRuleCache(req.user!.clientNumber);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

adminGateRulesRouter.get('/metrics', async (req: Request, res: Response) => {
  try {
    const days = Math.min(parseInt(String(req.query.days ?? '30'), 10) || 30, 90);
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT rule_id, rule_name, rule_scope, rule_key, decision,
              COUNT(*)::int AS fires
         FROM gate_rule_firings
        WHERE client_number = $1
          AND fired_at >= NOW() - (INTERVAL '1 day' * $2)
        GROUP BY rule_id, rule_name, rule_scope, rule_key, decision
        ORDER BY fires DESC`,
      req.user!.clientNumber, days,
    ).catch(() => [] as any[]);
    const total = rows.reduce((a, r) => a + Number(r.fires), 0);
    // Rough $-saved estimate: $0.0008/fire (avg cost of triage LLM call).
    const estUsdSaved = total * 0.0008;
    res.json({ days, total, estUsdSaved, rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});
