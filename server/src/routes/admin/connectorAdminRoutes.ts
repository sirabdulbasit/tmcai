/**
 * MyOS Connector Admin Routes
 *
 * Admins manage connector scope (which personal connectors users can access)
 * and configure organizational connectors (credentials, sync schedule).
 */

import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../../middleware/auth';
import * as connectorService from '../../services/connectorService';

const router = Router();

// ─── List all connector configs for this tenant ───────────────
router.get('/', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const configs = await connectorService.listTenantConfigs(user.clientNumber);
    const allTypes = await connectorService.listConnectorTypes();
    res.json({ configs, allTypes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Toggle a personal connector on/off for users ─────────────
router.post('/personal/toggle', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { connectorTypeId, enabled } = req.body;

    if (!connectorTypeId || typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'connectorTypeId and enabled (boolean) are required' });
      return;
    }

    const config = await connectorService.togglePersonalConnector(user.clientNumber, connectorTypeId, enabled);
    res.json({ config });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Configure an organizational connector ────────────────────
router.post('/org/configure', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { connectorTypeId, config, syncSchedule } = req.body;

    if (!connectorTypeId || !config) {
      res.status(400).json({ error: 'connectorTypeId and config are required' });
      return;
    }

    const result = await connectorService.configureOrgConnector(
      user.clientNumber,
      connectorTypeId,
      config,
      syncSchedule,
    );
    res.json({ config: result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Remove an organizational connector ───────────────────────
router.delete('/org/:connectorTypeId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    await connectorService.removeOrgConnector(user.clientNumber, req.params.connectorTypeId as string);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get enabled personal connectors ──────────────────────────
router.get('/personal/enabled', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const connectors = await connectorService.getEnabledPersonalConnectors(user.clientNumber);
    res.json({ connectors });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get configured org connectors ────────────────────────────
router.get('/org/configured', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const connectors = await connectorService.getConfiguredOrgConnectors(user.clientNumber);
    res.json({ connectors });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
