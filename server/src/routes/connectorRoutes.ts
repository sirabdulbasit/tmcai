/**
 * MyOS Connector Routes — User-facing
 *
 * Users manage their personal connector connections.
 * Users can only see connectors that admin has enabled for their tenant.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import * as connectorService from '../services/connectorService';

const router = Router();

// ─── List available personal connectors for this user ─────────
router.get('/available', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const available = await connectorService.listAvailableForUser(user.id, user.clientNumber);
    res.json({ connectors: available });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── List user's active connections ───────────────────────────
router.get('/my', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const connectors = await connectorService.listUserConnectors(user.id, user.clientNumber);
    res.json({ connectors });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Connect a personal connector (test + save) ──────────────
router.post('/connect', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { connectorTypeId, config } = req.body;

    if (!connectorTypeId) {
      res.status(400).json({ error: 'connectorTypeId is required' });
      return;
    }

    const result = await connectorService.testAndConnect(
      user.id,
      user.clientNumber,
      connectorTypeId,
      config || {},
    );

    if (!result.success) {
      res.status(400).json({ error: result.error, success: false });
      return;
    }

    res.json({ success: true, email: result.email });
  } catch (error: any) {
    res.status(400).json({ error: error.message, success: false });
  }
});

// ─── Get OAuth URL for a connector ────────────────────────────
router.post('/oauth/url', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { connectorTypeId, config } = req.body;

    if (!connectorTypeId) {
      res.status(400).json({ error: 'connectorTypeId is required' });
      return;
    }

    const result = await connectorService.getOAuthUrl(user.id, connectorTypeId, config);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ url: result.url });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── OAuth callback ───────────────────────────────────────────
router.get('/oauth/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string;

  if (!code || !state) {
    res.status(400).send('Missing code or state');
    return;
  }

  const result = await connectorService.handleOAuthCallback(code, state);
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5174';

  if (result.success) {
    res.redirect(`${clientUrl}/connectors?connected=${result.slug}&success=true`);
  } else {
    res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(result.error || 'Connection failed')}`);
  }
});

// ─── Test a connected connector (verify it can actually fetch data) ──
router.post('/test', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { connectorTypeId } = req.body;
    if (!connectorTypeId) { res.status(400).json({ error: 'connectorTypeId required' }); return; }

    const result = await connectorService.testConnectedConnector(user.id, connectorTypeId);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Disconnect a personal connector ──────────────────────────
router.post('/disconnect', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { connectorTypeId } = req.body;

    if (!connectorTypeId) {
      res.status(400).json({ error: 'connectorTypeId is required' });
      return;
    }

    await connectorService.disconnectUserConnector(user.id, connectorTypeId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get the redirect URI for OAuth (public — not sensitive) ──
router.get('/oauth/redirect-uri', (_req: Request, res: Response) => {
  res.json({ redirectUri: process.env.GOOGLE_CONNECTOR_REDIRECT_URI || 'http://localhost:4002/api/v1/connectors/oauth/callback' });
});

// ─── Get connector types registry ─────────────────────────────
router.get('/types', requireAuth, async (req: Request, res: Response) => {
  try {
    const scope = req.query.scope as 'personal' | 'organizational' | undefined;
    const types = await connectorService.listConnectorTypes(scope);
    res.json({ types });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
