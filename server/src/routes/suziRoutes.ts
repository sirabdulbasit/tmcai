/**
 * Suzi desktop (DEF-370) — Settings → Suzi desktop in Nexeo web.
 *
 *   POST   /suzi/connect-key   → { key, expiresAt, serverUrl, connectLink }   single-use, 10 min, for the signed-in person
 *   GET    /suzi/devices       → { devices: [...] }   that person's connected computers
 *   DELETE /suzi/devices/:id   → { ok: true }         disconnect one of THEIR computers
 *
 * The owner (user id, clientNumber, display name) comes from req.user only;
 * anything in the body or query is ignored (tenant authority, DEF-179).
 * Agent tokens are refused: a key must belong to a person.
 */
import { Router, Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth } from '../middleware/auth';
import {
  SuziGatewayError, SuziNotConfiguredError, createConnectKey, disconnectDevice, listDevices, type SuziOwner,
} from '../services/suzi/gatewayAdminClient';

const router = Router();
router.use(requireAuth);
router.use((req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (user?.isAgent) {
    res.status(403).json({ error: 'Suzi desktop needs a signed-in person, not an agent token' });
    return;
  }
  if (!user?.id || !user?.clientNumber) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
});

const keyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.id?.toString() || ipKeyGenerator(req),
  message: { error: 'Too many connection keys. Please try again in a minute.' },
});

function ownerOf(req: Request): SuziOwner {
  const user = (req as any).user;
  return { userId: user.id, clientNumber: user.clientNumber, displayName: user.name || user.email || `User ${user.id}` };
}

function fail(res: Response, err: unknown): void {
  if (err instanceof SuziNotConfiguredError) {
    res.status(503).json({ error: 'Suzi desktop is not set up on this server yet' });
  } else if (err instanceof SuziGatewayError) {
    res.status(err.status).json({ error: err.message });
  } else {
    res.status(500).json({ error: 'Something went wrong' });
  }
}

router.post('/connect-key', keyLimiter, async (req: Request, res: Response) => {
  try {
    res.json(await createConnectKey(ownerOf(req)));
  } catch (err) {
    fail(res, err);
  }
});

router.get('/devices', async (req: Request, res: Response) => {
  try {
    res.json({ devices: await listDevices(ownerOf(req)) });
  } catch (err) {
    fail(res, err);
  }
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.delete('/devices/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  if (!UUID.test(id)) {
    res.status(400).json({ error: 'Invalid device id' });
    return;
  }
  try {
    await disconnectDevice(ownerOf(req), id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
