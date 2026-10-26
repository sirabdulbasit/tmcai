/**
 * DEF-354 — Admin → Integrations API (Stage 1: Google Sheet → KPI readings).
 *
 * Spec: server/docs/INTEGRATIONS_DESIGN.md §2.6. Every handler is a thin shell
 * over the module contracts in services/integrations/types.ts — no business
 * rule lives here except the three the HTTP edge owns:
 *
 *   1. TENANT AUTHORITY comes from the requester (`req.user.clientNumber`),
 *      never from the body or the target row (DEF-179). Only a SuperAdmin may
 *      name another tenant, explicitly, via ?clientNumber or body.clientNumber.
 *   2. CLOSED WHITELIST on POST/PUT (vm §9 "permissions are never accepted
 *      from the client"): status, approval, activation, timestamps and the
 *      fingerprint can only change through /activate, /pause and the
 *      connection check. An unknown key is a 400, never silently dropped, so a
 *      client that believes it set `status` learns it did not.
 *   3. OWN RATE LIMITER. The lead mounts this router at
 *      /api/v1/admin/integrations BEFORE the generic `/admin` router
 *      (app.ts:186), whose 30 req/min adminLimiter would 429 the wizard while
 *      it polls a proposal or a run (critique item 1). The ceiling comes from
 *      behaviorConfig `integrations.route_limit_per_min` (default 240).
 *
 * Errors: deliberate errors carry a message the admin can act on and map to
 * 400 / 404 / 409; anything unexpected is logged and answered with a generic
 * 500 so internals (SQL, stack traces) never reach the browser.
 *
 * Mount note: `/kpi-definitions` is declared BEFORE `/:id` so it is not
 * captured as an integration id.
 */

import { Router, Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth, requireAdmin } from '../../middleware/auth';
import createLogger from '../../utils/logger';
import { BEHAVIOR_SPECS, resolveBehaviorValue } from '../../services/behaviorConfig';
import {
  INTEGRATION_INPUT_KEYS,
  type IntegrationInput,
  type KpiDefinitionInput,
  type TestResult,
} from '../../services/integrations/types';
import { testGsheet } from '../../services/integrations/sources/gsheetReader';
import { startProposalJob, getProposalJob } from '../../services/integrations/mapping/proposalJobs';
import {
  listIntegrations,
  getIntegration,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  recordConnectionTest,
} from '../../services/integrations/store/integrationStore';
import {
  listSuggestions,
  approveSuggestions,
  rejectSuggestions,
  listKpiDefinitions,
  createKpiDefinition,
  activate,
  pause,
} from '../../services/integrations/store/mappingStore';
import { startRun, getRunStatus, listRuns, listRunChanges } from '../../services/integrations/engine/runJobs';

const log = createLogger('integrationAdminRoutes');

// ── Rate limit ─────────────────────────────────────────────────────────────

const LIMIT_KEY = 'integrations.route_limit_per_min';
const LIMIT_FALLBACK = 240;

/**
 * Read ONCE at module load. express-rate-limit needs a number when the
 * router is built and the per-tenant DB override is async, so only the env
 * override (BEHAVIOR_INTEGRATIONS_ROUTE_LIMIT_PER_MIN) and the spec default
 * apply here; resolveBehaviorValue still clamps into the spec's [min,max]. Any
 * failure falls back to 240 — never to 0, which would lock the wizard out.
 */
function resolveRouteLimit(): number {
  try {
    const spec = BEHAVIOR_SPECS[LIMIT_KEY];
    if (!spec) return LIMIT_FALLBACK;
    const envKey = `BEHAVIOR_${LIMIT_KEY.replace(/[.\-]/g, '_').toUpperCase()}`;
    return resolveBehaviorValue(spec, [{ source: 'env', value: process.env[envKey] }]).value;
  } catch {
    return LIMIT_FALLBACK;
  }
}

export const ROUTE_LIMIT_PER_MIN = resolveRouteLimit();

const integrationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: ROUTE_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  // Per user, like adminLimiter: two admins of one tenant polling at once must
  // not share one budget.
  keyGenerator: (req: any) => req.user?.id?.toString() || ipKeyGenerator(req.ip ?? ''),
  message: { error: 'Too many requests. Please try again in 1 minute.' },
});

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);
router.use(integrationLimiter);

// ── Helpers ────────────────────────────────────────────────────────────────

const CLIENT_NUMBER_RE = /^[A-Za-z0-9_-]{1,20}$/;
const MAX_ID_LEN = 64;
const MAX_IDS = 1000;

/** A deliberate, user-facing refusal raised inside this file. */
class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * The tenant this request acts on. Non-SuperAdmin: ALWAYS the session's
 * tenant — a clientNumber in query/body is ignored (DEF-179). SuperAdmin: may
 * name one explicitly; a malformed one is refused rather than guessed.
 */
function tenantOf(req: Request): string {
  const user = req.user!;
  if (!user.isSuperAdmin) return user.clientNumber;
  const named = (req.query?.clientNumber ?? (req.body && req.body.clientNumber)) as unknown;
  if (named === undefined || named === null || named === '') return user.clientNumber;
  if (typeof named !== 'string' || !CLIENT_NUMBER_RE.test(named)) {
    throw new HttpError(400, 'clientNumber is not a valid tenant id');
  }
  return named;
}

function actorOf(req: Request): number {
  return req.user!.id;
}

function idParam(req: Request, name = 'id'): string {
  const v = req.params[name];
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_ID_LEN) {
    throw new HttpError(400, `Invalid ${name}`);
  }
  return v;
}

function bodyOf(req: Request): Record<string, unknown> {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Request body must be a JSON object');
  return b as Record<string, unknown>;
}

/**
 * The closed whitelist (types.ts INTEGRATION_INPUT_KEYS). `clientNumber` is
 * consumed by tenantOf and not part of the input. Any other key — status,
 * approvedVersionId, activatedAt, connectionFingerprint, createdBy … — is a
 * 400 and NOTHING is written. Field VALUE validation is the store's job.
 */
function integrationInputOf(req: Request): IntegrationInput {
  const body = bodyOf(req);
  const allowed = new Set<string>(INTEGRATION_INPUT_KEYS as readonly string[]);
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (k === 'clientNumber') continue;
    if (!allowed.has(k)) { unknown.push(k); continue; }
    out[k] = v;
  }
  if (unknown.length > 0) {
    throw new HttpError(400, `These fields cannot be set here: ${unknown.join(', ')}`, { field: unknown[0] });
  }
  return out as IntegrationInput;
}

function stringField(body: Record<string, unknown>, key: string, required: true): string;
function stringField(body: Record<string, unknown>, key: string, required: false): string | undefined;
function stringField(body: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${key} is required`, { field: key });
    return undefined;
  }
  if (typeof v !== 'string' || v.length > MAX_ID_LEN) throw new HttpError(400, `${key} is invalid`, { field: key });
  return v;
}

function queryString(req: Request, key: string): string | undefined {
  const v = req.query?.[key];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || v.length > MAX_ID_LEN) throw new HttpError(400, `${key} is invalid`, { field: key });
  return v;
}

function idsOf(body: Record<string, unknown>): string[] | 'all' {
  const ids = body.ids;
  if (ids === 'all') return 'all';
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS
    || !ids.every((x) => typeof x === 'string' && x.length > 0 && x.length <= MAX_ID_LEN)) {
    throw new HttpError(400, "ids must be 'all' or a non-empty list of suggestion ids", { field: 'ids' });
  }
  return ids as string[];
}

/** 404 for a missing OR foreign id — never a 403 that confirms it exists in
 *  another tenant (types.ts IntegrationNotFoundError). */
async function requireIntegration(cn: string, id: string) {
  const integ = await getIntegration(cn, id);
  if (!integ) throw new HttpError(404, `Integration ${id} not found.`);
  return integ;
}

/**
 * Map a thrown error to a response. Matched on the contract's `code` (not
 * instanceof) so a duplicated module instance cannot turn a deliberate 409
 * into a 500.
 */
function sendError(res: Response, err: unknown, route: string): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...(err.extra ?? {}) });
    return;
  }
  const e = err as { code?: unknown; message?: string; field?: string; reasons?: string[] } | null;
  switch (e?.code) {
    case 'RUN_BUSY':
      res.status(409).json({ error: e.message, code: e.code });
      return;
    case 'INTEGRATION_NOT_FOUND':
      res.status(404).json({ error: e.message, code: e.code });
      return;
    case 'INTEGRATION_INPUT':
      res.status(400).json({ error: e.message, code: e.code, ...(e.field ? { field: e.field } : {}) });
      return;
    case 'ACTIVATION_REFUSED':
      res.status(409).json({ error: e.message, code: e.code, reasons: e.reasons ?? [] });
      return;
    case 'CREDENTIAL_UNREADABLE':
      res.status(400).json({ error: e.message, code: e.code });
      return;
    default:
      log.error('integration admin route failed', {
        route,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  }
}

type Handler = (req: Request, res: Response) => Promise<void>;
function handle(route: string, fn: Handler) {
  return (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err) => sendError(res, err, route));
  };
}

// ── KPI catalogue (before /:id) ────────────────────────────────────────────

router.get('/kpi-definitions', handle('GET /kpi-definitions', async (req, res) => {
  const cn = tenantOf(req);
  res.json({ definitions: await listKpiDefinitions(cn) });
}));

router.post('/kpi-definitions', handle('POST /kpi-definitions', async (req, res) => {
  const cn = tenantOf(req);
  const body = bodyOf(req);
  // Closed set here too: source_integration_id / is_active are never client-set.
  const allowed = new Set(['kpiKey', 'label', 'unit', 'direction', 'grain', 'clientNumber']);
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new HttpError(400, `These fields cannot be set here: ${unknown.join(', ')}`, { field: unknown[0] });
  }
  const input: KpiDefinitionInput = {
    kpiKey: body.kpiKey as string,
    label: body.label as string,
    ...(body.unit !== undefined ? { unit: body.unit as string | null } : {}),
    ...(body.direction !== undefined ? { direction: body.direction as KpiDefinitionInput['direction'] } : {}),
    ...(body.grain !== undefined ? { grain: body.grain as KpiDefinitionInput['grain'] } : {}),
  };
  const def = await createKpiDefinition(cn, input, actorOf(req));
  res.status(201).json({ definition: def });
}));

// ── Integrations CRUD ──────────────────────────────────────────────────────

router.get('/', handle('GET /', async (req, res) => {
  const cn = tenantOf(req);
  res.json({ integrations: await listIntegrations(cn) });
}));

router.post('/', handle('POST /', async (req, res) => {
  const cn = tenantOf(req);
  const input = integrationInputOf(req);
  const integration = await createIntegration(cn, input, actorOf(req));
  res.status(201).json({ integration });
}));

router.get('/:id', handle('GET /:id', async (req, res) => {
  const cn = tenantOf(req);
  res.json({ integration: await requireIntegration(cn, idParam(req)) });
}));

router.put('/:id', handle('PUT /:id', async (req, res) => {
  const cn = tenantOf(req);
  const id = idParam(req);
  const patch = integrationInputOf(req);
  res.json({ integration: await updateIntegration(cn, id, patch) });
}));

router.delete('/:id', handle('DELETE /:id', async (req, res) => {
  const cn = tenantOf(req);
  const id = idParam(req);
  await deleteIntegration(cn, id);
  res.json({ success: true });
}));

// ── Step 2: Connect ────────────────────────────────────────────────────────

/**
 * Reads the sheet FOR REAL (spec §2.2: a 200 with 0 rows is not ok) and
 * records the outcome, so "Suggest the mapping" unlocks only on a passed test
 * of the CURRENT config. An unreadable designated-account credential is a
 * failed test with its reason — it is recorded (clearing any earlier pass),
 * never a fallback to another account.
 */
router.get('/:id/connection-check', handle('GET /:id/connection-check', async (req, res) => {
  const cn = tenantOf(req);
  const id = idParam(req);
  const integ = await requireIntegration(cn, id);
  if (!integ.sourceConfig) {
    throw new HttpError(400, 'Paste the Google Sheet link first.', { field: 'link' });
  }
  let result: TestResult;
  try {
    result = await testGsheet(cn, integ.sourceConfig);
  } catch (err) {
    if ((err as { code?: unknown })?.code !== 'CREDENTIAL_UNREADABLE') throw err;
    result = { ok: false, rows: 0, columns: [], sampleRow: null, reason: (err as Error).message };
  }
  const integration = await recordConnectionTest(cn, id, result);
  res.json({ result, integration });
}));

// ── Step 3: Mapping ────────────────────────────────────────────────────────

router.post('/:id/propose/start', handle('POST /:id/propose/start', async (req, res) => {
  const cn = tenantOf(req);
  const id = idParam(req);
  const body = bodyOf(req);
  const prompt = body.prompt;
  if (prompt !== undefined && prompt !== null && (typeof prompt !== 'string' || prompt.length > 4000)) {
    throw new HttpError(400, 'prompt must be text of at most 4000 characters', { field: 'prompt' });
  }
  const { jobId } = await startProposalJob(cn, id, {
    actorId: actorOf(req),
    ...(typeof prompt === 'string' && prompt.trim() ? { prompt: prompt.trim() } : {}),
  });
  res.status(202).json({ jobId });
}));

router.get('/:id/propose/status', handle('GET /:id/propose/status', async (req, res) => {
  const cn = tenantOf(req);
  const id = idParam(req);
  const jobId = queryString(req, 'jobId');
  if (!jobId) throw new HttpError(400, 'jobId is required', { field: 'jobId' });
  const job = getProposalJob(cn, id, jobId);
  if (!job) throw new HttpError(404, 'That proposal is no longer available. Start a new one.');
  res.json({ job });
}));

router.get('/:id/suggestions', handle('GET /:id/suggestions', async (req, res) => {
  const cn = tenantOf(req);
  const id = idParam(req);
  await requireIntegration(cn, id);
  res.json(await listSuggestions(cn, id, queryString(req, 'versionId')));
}));

router.post('/:id/suggestions/approve', handle('POST /:id/suggestions/approve', async (req, res) => {
  const cn = tenantOf(req);
  const id = idParam(req);
  const body = bodyOf(req);
  const versionId = stringField(body, 'versionId', true);
  res.json(await approveSuggestions(cn, id, versionId, idsOf(body), actorOf(req)));
}));

router.post('/:id/suggestions/reject', handle('POST /:id/suggestions/reject', async (req, res) => {
  const cn = tenantOf(req);
  const id = idParam(req);
  const body = bodyOf(req);
  const versionId = stringField(body, 'versionId', true);
  res.json(await rejectSuggestions(cn, id, versionId, idsOf(body), actorOf(req)));
}));

// ── Step 5: Test & run ─────────────────────────────────────────────────────

/**
 * A manual run. `dryRun` defaults to TRUE: a live write must be asked for
 * explicitly (`dryRun: false`), so a client that forgets the flag previews
 * instead of writing. Manual runs are never change-capped (spec §2.4 step 5);
 * that is the engine's rule, keyed on trigger 'manual'.
 */
router.post('/:id/run/start', handle('POST /:id/run/start', async (req, res) => {
  const cn = tenantOf(req);
  const id = idParam(req);
  const body = bodyOf(req);
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    throw new HttpError(400, 'dryRun must be true or false', { field: 'dryRun' });
  }
  const dryRun = body.dryRun !== false;
  const versionId = stringField(body, 'versionId', false);
  const { runId } = await startRun(cn, id, {
    dryRun,
    trigger: 'manual',
    triggeredBy: `user:${actorOf(req)}`,
    ...(versionId ? { versionId } : {}),
  });
  // jobId mirrors the proposal endpoints so the client polls both the same way.
  res.status(202).json({ jobId: runId, runId });
}));

router.get('/:id/run/status', handle('GET /:id/run/status', async (req, res) => {
  const cn = tenantOf(req);
  const id = idParam(req);
  const runId = queryString(req, 'jobId') ?? queryString(req, 'runId');
  if (!runId) throw new HttpError(400, 'jobId is required', { field: 'jobId' });
  const run = await getRunStatus(cn, id, runId);
  if (!run) throw new HttpError(404, `Run ${runId} not found.`);
  res.json({ run });
}));

router.get('/:id/runs', handle('GET /:id/runs', async (req, res) => {
  const cn = tenantOf(req);
  const id = idParam(req);
  const rawLimit = queryString(req, 'limit');
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new HttpError(400, 'limit must be 1–200', { field: 'limit' });
    limit = n;
  }
  await requireIntegration(cn, id);
  res.json({ runs: await listRuns(cn, id, limit) });
}));

router.get('/:id/runs/:runId/changes', handle('GET /:id/runs/:runId/changes', async (req, res) => {
  const cn = tenantOf(req);
  const id = idParam(req);
  const runId = idParam(req, 'runId');
  await requireIntegration(cn, id);
  res.json({ changes: await listRunChanges(cn, id, runId) });
}));

// ── Turn on / pause ────────────────────────────────────────────────────────

/** Turning on NEVER runs anything (spec §2.5); refusals come back as 409 with
 *  the reasons the admin reads verbatim. */
router.post('/:id/activate', handle('POST /:id/activate', async (req, res) => {
  const cn = tenantOf(req);
  const id = idParam(req);
  const versionId = stringField(bodyOf(req), 'versionId', true);
  res.json({ integration: await activate(cn, id, versionId, actorOf(req)) });
}));

router.post('/:id/pause', handle('POST /:id/pause', async (req, res) => {
  const cn = tenantOf(req);
  res.json({ integration: await pause(cn, idParam(req)) });
}));

export default router;
