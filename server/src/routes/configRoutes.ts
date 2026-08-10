import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth, requireAdmin, requireSuperAdmin } from '../middleware/auth';
import { setConfig, deleteConfig } from '../services/configService';
import { getTableInfo, getTenants, previewPurge, executePurge } from '../services/dataManagementService';
import prisma from '../db/prisma';

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.id?.toString() || ipKeyGenerator(req),
  message: { error: 'Too many requests. Please try again in 1 minute.' },
});
router.use(adminLimiter);

const SENSITIVE_KEYS = [
  'gemini_api_key', 'anthropic_api_key', 'openai_api_key',
  'groq_api_key', 'openrouter_api_key', 'google_client_secret',
  'smtp_pass', 'encryption_key',
  // A service-account JSON is a private key. Masked on read like any other
  // secret, and never returned to the browser once stored.
  'ai_service_account_json',
];

// System-level keys — only SuperAdmin can read/write these
const SYSTEM_KEYS = [
  'app_name', 'session_hours', 'max_tokens', 'request_timeout_ms', 'max_context_chars',
  'rag_enabled', 'pii_enabled', 'rag_top_k', 'rag_min_score',
  'gemini_api_key', 'anthropic_api_key', 'openai_api_key', 'groq_api_key', 'openrouter_api_key',
  // AI provider selection. Application-level, never per-tenant: one Brain, one
  // inference backend. A tenant choosing its own model would make "why did
  // Brain answer differently" unanswerable.
  'ai_provider', 'ai_model', 'ai_service_account_json', 'ai_region',
];

const MASKED = '********';

// Resolve target client — SuperAdmin can pass ?client=XYZ-0001
function getTargetClient(req: Request): string {
  const override = req.query.client as string || req.body?.clientNumber;
  if (override && req.user!.isSuperAdmin) return override;
  return req.user!.clientNumber;
}


/**
 * POST /config/ai/verify — the "Verify integration" button.
 *
 * Makes a REAL generate call against the saved configuration rather than
 * checking that credentials parse. A valid key with no quota, a retired model,
 * and a region that does not host the model all pass a credential check and
 * fail in production — two of those three have happened to this project inside
 * one week.
 *
 * SuperAdmin only: it exercises an application-level secret and costs a token.
 */
router.post('/ai/verify', requireSuperAdmin, async (_req: Request, res: Response) => {
  const { verifyAiProvider, clearAiProviderCache } = await import('../services/aiProviderConfig');
  // Read fresh: the operator has almost certainly just pressed Save.
  clearAiProviderCache();
  const result = await verifyAiProvider();
  res.json(result);
});

/** GET /config/ai — the provider panel's state, with the secret never leaving. */
router.get('/ai', requireSuperAdmin, async (_req: Request, res: Response) => {
  const { getAiProviderConfig } = await import('../services/aiProviderConfig');
  const cfg = await getAiProviderConfig();
  const stored = await prisma.systemConfig.findFirst({
    where: { key: 'ai_service_account_json' }, select: { value: true },
  }).catch(() => null);
  res.json({
    provider: cfg.provider,
    model: cfg.model,
    flashModel: cfg.flashModel,
    region: cfg.region,
    // Presence, never content. The panel shows a masked box and the operator
    // leaves it alone to keep the stored value.
    hasServiceAccount: !!(stored?.value?.trim()),
    usesAmbientCredentials: !stored?.value?.trim() && !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
    ready: cfg.ready,
    reason: cfg.reason ?? null,
  });
});

// Get all config (filtered by access level)
router.get('/', async (req: Request, res: Response) => {
  const targetClient = getTargetClient(req);
  const rows = await prisma.systemConfig.findMany({
    where: { clientNumber: targetClient },
    orderBy: { key: 'asc' },
  });

  // Admin sees only client-level keys, SuperAdmin sees all
  const filtered = req.user!.isSuperAdmin
    ? rows
    : rows.filter(r => !SYSTEM_KEYS.includes(r.key));

  const configs = filtered.map(r => ({
    key: r.key,
    value: r.isSensitive ? MASKED : r.value,
    isSensitive: r.isSensitive,
    description: r.description,
  }));

  res.json({ configs });
});

// Update config entries (bulk)
router.put('/', async (req: Request, res: Response) => {
  const { configs } = req.body;
  if (!configs || !Array.isArray(configs)) {
    res.status(400).json({ error: 'configs array is required' });
    return;
  }

  let updated = 0;
  for (const entry of configs) {
    if (!entry.key || entry.value === undefined) continue;
    if (entry.value === MASKED) continue;

    // Block non-SuperAdmin from writing system keys
    if (SYSTEM_KEYS.includes(entry.key) && !req.user!.isSuperAdmin) continue;
    await invalidateIfProviderKey(entry.key);

    const isSensitive = SENSITIVE_KEYS.includes(entry.key) || entry.isSensitive === true;
    await setConfig(getTargetClient(req), entry.key, entry.value, isSensitive, entry.description);
    updated++;
  }

  res.json({ success: true, updated });
});

// Set single config entry
/** Any ai_* write invalidates the provider cache so Save takes effect at once. */
async function invalidateIfProviderKey(key: string): Promise<void> {
  if (!key.startsWith('ai_')) return;
  const { clearAiProviderCache } = await import('../services/aiProviderConfig');
  clearAiProviderCache();
}

router.put('/:key', async (req: Request, res: Response) => {
  const { value, description } = req.body;
  const key = req.params.key as string;
  if (value === undefined) { res.status(400).json({ error: 'value is required' }); return; }
  if (value === MASKED) { res.status(400).json({ error: 'Cannot save masked value' }); return; }

  if (SYSTEM_KEYS.includes(key) && !req.user!.isSuperAdmin) {
    res.status(403).json({ error: 'System config requires SuperAdmin access' });
    return;
  }

  const isSensitive = SENSITIVE_KEYS.includes(key) || req.body.isSensitive === true;
  await setConfig(getTargetClient(req), key, value, isSensitive, description);
  await invalidateIfProviderKey(key);
  res.json({ success: true });
});

// Upload logo (base64 in request body)
router.post('/logo', async (req: Request, res: Response) => {
  const { logo } = req.body; // data:image/png;base64,xxxx
  if (!logo || !logo.startsWith('data:image/')) {
    res.status(400).json({ error: 'logo must be a base64 data URL (data:image/png;base64,...)' });
    return;
  }
  // Limit size: ~2MB base64 ≈ 2.7M chars
  if (logo.length > 3000000) {
    res.status(400).json({ error: 'Logo too large. Max 2MB.' });
    return;
  }
  const targetClient = getTargetClient(req);
  await setConfig(targetClient, 'client_logo', logo, false, 'Client logo (base64)');
  res.json({ success: true });
});

// Delete config entry
router.delete('/:key', async (req: Request, res: Response) => {
  const key = req.params.key as string;
  if (SYSTEM_KEYS.includes(key) && !req.user!.isSuperAdmin) {
    res.status(403).json({ error: 'System config requires SuperAdmin access' });
    return;
  }
  await deleteConfig(getTargetClient(req), key);
  res.json({ success: true });
});

// ─── Data Management (SuperAdmin only) ─────────────────────────

// List tenants for client selector
router.get('/data/tenants', requireSuperAdmin, async (_req: Request, res: Response) => {
  const tenants = await getTenants();
  res.json({ tenants });
});

// Get table info with row counts
router.get('/data/tables', requireSuperAdmin, async (req: Request, res: Response) => {
  const clientNumber = req.query.client as string || undefined;
  const tables = await getTableInfo(clientNumber || undefined);
  res.json({ tables, clientNumber: clientNumber || 'ALL' });
});

// Preview purge (counts only, no deletion)
router.post('/data/preview', requireSuperAdmin, async (req: Request, res: Response) => {
  const { tables, clientNumber } = req.body;
  if (!tables || !Array.isArray(tables) || tables.length === 0) {
    res.status(400).json({ error: 'tables array is required' });
    return;
  }
  const preview = await previewPurge(tables, clientNumber || undefined);
  res.json({ preview, clientNumber: clientNumber || 'ALL' });
});

// Execute purge
router.delete('/data/purge', requireSuperAdmin, async (req: Request, res: Response) => {
  const { tables, clientNumber } = req.body;
  if (!tables || !Array.isArray(tables) || tables.length === 0) {
    res.status(400).json({ error: 'tables array is required' });
    return;
  }
  const results = await executePurge(tables, clientNumber || undefined);
  res.json({ success: true, results });
});

export default router;
