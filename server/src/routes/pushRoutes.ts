/**
 * Web Push routes (per-user).
 *
 *   GET    /vapid-key                        public VAPID key (for client subscribe())
 *   GET    /devices                          list this user's active subscriptions
 *   POST   /subscribe                        register a new device
 *   DELETE /devices/:id                      remove a device (soft-delete)
 *   GET    /prefs                            get push preferences
 *   PATCH  /prefs                            update push preferences
 *   POST   /test                             fire a test push to all this user's devices
 *
 * Approval-by-token (single-use, no auth required because the token IS
 * the auth — but the token is bound to a specific (action, user, intent)):
 *
 *   POST   /approval/:token/approve          consume an approve-token
 *   POST   /approval/:token/reject           consume a reject-token
 *   GET    /approval/:token/view             consume a view-token (returns the action)
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  getVapidPublicKey, subscribe, unsubscribe, listDevices,
  loadPrefs, savePrefs, sendToUser,
} from '../services/notifications/pushService';
import { verify, consume } from '../services/notifications/approvalTokenService';
import { approve, reject } from '../services/risk/approvalWorkflow';
import prisma from '../db/prisma';

const router = Router();

// ─── Authenticated user routes ───────────────────────────────────

router.get('/vapid-key', requireAuth, (_req: Request, res: Response) => {
  const key = getVapidPublicKey();
  if (!key) {
    res.status(503).json({
      error: 'push_not_configured',
      message: 'Web push is not configured on this server. Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY env vars.',
    });
    return;
  }
  res.json({ publicKey: key });
});

router.get('/devices', requireAuth, async (req: Request, res: Response) => {
  const devices = await listDevices(req.user!.clientNumber, req.user!.id);
  res.json({ devices });
});

router.post('/subscribe', requireAuth, async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const endpoint = String(body.endpoint ?? '').trim();
  const keys = body.keys ?? {};
  const p256dhKey = String(keys.p256dh ?? '').trim();
  const authKey = String(keys.auth ?? '').trim();
  if (!endpoint || !p256dhKey || !authKey) {
    res.status(400).json({ error: 'endpoint and keys.{p256dh,auth} required' });
    return;
  }
  try {
    const sub = await subscribe({
      clientNumber: req.user!.clientNumber,
      userId: req.user!.id,
      endpoint, p256dhKey, authKey,
      deviceLabel: body.deviceLabel ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    res.json({ subscription: { id: sub.id, deviceLabel: sub.deviceLabel, createdAt: sub.createdAt } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/devices/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid id' }); return; }
  await unsubscribe(req.user!.id, id);
  res.json({ ok: true });
});

router.get('/prefs', requireAuth, async (req: Request, res: Response) => {
  const prefs = await loadPrefs(req.user!.id);
  res.json({ prefs });
});

router.patch('/prefs', requireAuth, async (req: Request, res: Response) => {
  try {
    const merged = await savePrefs(req.user!.clientNumber, req.user!.id, req.body ?? {});
    res.json({ prefs: merged });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/test', requireAuth, async (req: Request, res: Response) => {
  const result = await sendToUser(req.user!.clientNumber, req.user!.id, {
    event: 'approval_request',
    title: 'MyOS test push',
    body: 'If you see this on your device, web push is working.',
    severity: 'low',
    tag: 'test-push',
  });
  res.json({ result });
});

// ─── Approval-by-token (no auth needed; the token IS the auth) ───

router.post('/approval/:token/approve', async (req: Request, res: Response) => {
  await consumeApprovalToken(req, res, 'approve');
});

router.post('/approval/:token/reject', async (req: Request, res: Response) => {
  await consumeApprovalToken(req, res, 'reject');
});

router.get('/approval/:token/view', async (req: Request, res: Response) => {
  try {
    const v = await verify(String(req.params.token), 'view');
    // 'view' is non-destructive; consume marks it used so the same link
    // can't keep being shared, but we still return the action.
    await consume(v.id, req.ip ?? null, 'push');
    const action = await prisma.agentAction.findUnique({
      where: { id: v.actionId },
      select: { id: true, actionType: true, status: true, riskTier: true, input: true, output: true, createdAt: true },
    });
    if (!action) { res.status(404).json({ error: 'action_not_found' }); return; }
    res.json({ action });
  } catch (err: any) {
    res.status(tokenErrorToStatus(err)).json({ error: err.message });
  }
});

async function consumeApprovalToken(req: Request, res: Response, intent: 'approve' | 'reject'): Promise<void> {
  try {
    const v = await verify(String(req.params.token), intent);
    const ok = await consume(v.id, req.ip ?? null, 'push');
    if (!ok) { res.status(409).json({ error: 'already_consumed' }); return; }
    if (intent === 'approve') {
      await approve(v.actionId, v.userId);
    } else {
      const reason = String((req.body ?? {}).reason ?? 'rejected via push notification');
      await reject(v.actionId, v.userId, reason);
    }
    res.json({ ok: true, actionId: v.actionId, intent });
  } catch (err: any) {
    res.status(tokenErrorToStatus(err)).json({ error: err.message });
  }
}

function tokenErrorToStatus(err: any): number {
  switch (err?.code ?? err?.message) {
    case 'not_found': return 404;
    case 'already_consumed': return 409;
    case 'expired': return 410;
    case 'wrong_intent': return 400;
    default: return 500;
  }
}

export default router;
