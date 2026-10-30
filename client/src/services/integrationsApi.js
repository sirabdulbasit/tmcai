/**
 * DEF-354 — Admin → Integrations client API.
 *
 * Thin wrappers over the shared axios client (services/api.js, baseURL '/api'). Paths use
 * '/v1/admin/integrations/...' so they outlive the deprecated '/api' alias (Sunset
 * 31 Dec 2026). The tenant is NEVER sent: the server takes it from req.user.clientNumber
 * (spec §2.6), so no screen can address another tenant's integration by accident.
 *
 * Shapes follow server/src/services/integrations/types.ts (IntegrationDTO, TestResult,
 * ProposalJobStatus, RunStatusView, RunChangeDTO, SuggestionDTO, KpiDefinitionDTO).
 * `unwrap` accepts both `{integration: …}` and a bare object, so a route that returns
 * either form works without the screens caring.
 *
 * Writes send ONLY the whitelisted IntegrationInput keys (`pickInput`). vm sent the whole
 * draft — derived fields (stage, approval, status) included — which is how the client
 * could reset permissions (vm §8). The server rejects unknown keys; this pick list means
 * it never has to.
 */
import api from './api';

const BASE = '/v1/admin/integrations';

/** Mirror of INTEGRATION_INPUT_KEYS in types.ts — the closed PUT/POST whitelist. */
export const INTEGRATION_INPUT_KEYS = [
  'name', 'purpose', 'adminBrief', 'sourceKind', 'link', 'tabLabel',
  'frequency', 'runTime', 'dayOfWeek', 'dayOfMonth', 'timezone',
  'changeCapPct', 'blankPolicy',
  // DEF-362 (Stage 1b). The secret is NOT here: it has its own write-only call
  // (setIntegrationSecret) so it never rides on a PUT that echoes the integration.
  'apiConfig', 'filterInstructions', 'connectInstructions',
];

export function pickInput(obj) {
  const out = {};
  for (const k of INTEGRATION_INPUT_KEYS) {
    if (obj && obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function unwrap(data, key) {
  if (data && typeof data === 'object' && key in data) return data[key];
  return data;
}

/** The one wording for an API error: server's `error` text, else the transport message. */
export function errorText(e) {
  return e?.response?.data?.error ?? e?.response?.data?.message ?? e?.message ?? 'Unknown error';
}

// ── Integrations ──────────────────────────────────────────────────────────

export async function listIntegrations() {
  const { data } = await api.get(BASE);
  const list = unwrap(data, 'integrations');
  return Array.isArray(list) ? list : [];
}

export async function getIntegration(id) {
  const { data } = await api.get(`${BASE}/${encodeURIComponent(id)}`);
  return unwrap(data, 'integration');
}

export async function createIntegration(input) {
  const { data } = await api.post(BASE, pickInput(input));
  return unwrap(data, 'integration');
}

export async function updateIntegration(id, patch) {
  const { data } = await api.put(`${BASE}/${encodeURIComponent(id)}`, pickInput(patch));
  return unwrap(data, 'integration');
}

export async function deleteIntegration(id) {
  await api.delete(`${BASE}/${encodeURIComponent(id)}`);
}

/** Reads the sheet for real (spec §2.2: a 200 with 0 rows is NOT ok). Returns
 *  `{result: TestResult, integration: IntegrationDTO}` — the server records (or clears)
 *  connection_tested_at + fingerprint, so the refreshed DTO is what unlocks step 3. */
export async function checkConnection(id) {
  const { data } = await api.get(`${BASE}/${encodeURIComponent(id)}/connection-check`);
  // `note`: DEF-367 — set when a key printed in the API document was tested and kept.
  return { result: data?.result ?? null, integration: data?.integration ?? null, note: data?.note ?? null };
}

// ── API document and secret (DEF-362, spec §2b) ──────────────────────────

/** Biggest document the server accepts (behavior integrations.doc_max_bytes default).
 *  Checked here only so the admin hears it before a 5 MB upload; the server checks again. */
export const DOC_MAX_BYTES = 5 * 1024 * 1024;
export const DOC_ACCEPT = '.pdf,.docx,.txt,.md,.json';

/** Upload the API document (multipart field `file`). The server extracts the text,
 *  redacts credential-looking strings BEFORE storing it, and clears the previous AI
 *  reading. Returns `{document: {name, chars, redactions}, integration}`. */
export async function uploadApiDocument(id, file) {
  const form = new FormData();
  form.append('file', file, file.name);
  // The shared client defaults to 'Content-Type: application/json', and axios 1.x turns a
  // FormData sent with a JSON type into JSON.stringify(formDataToJSON(form)) — the File
  // becomes {} and multer never runs (DEF-362 review). A multipart type keeps it a
  // FormData; the browser adapter then drops the header so the browser adds the boundary.
  const { data } = await api.post(`${BASE}/${encodeURIComponent(id)}/api-document`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return { document: data?.document ?? null, integration: data?.integration ?? null };
}

/** Same as uploadApiDocument, for pasted text. */
export async function attachApiDocumentText(id, text, name) {
  const body = { text };
  if (name && name.trim()) body.name = name.trim();
  const { data } = await api.post(`${BASE}/${encodeURIComponent(id)}/api-document`, body);
  return { document: data?.document ?? null, integration: data?.integration ?? null };
}

/** The AI reads the stored (already redacted) document with the remarks and filter
 *  words. The server runs it as a job (one model call can outlast a request): POST
 *  /api-document/read answers 202 {jobId}; GET /api-document/read/status?jobId= answers
 *  {job: {state, reading, error}}. Resolves with `{reading, integration}` only once the
 *  job is done — the integration is re-fetched so the stored reading (and the draft
 *  Connect pre-fills from) is the server's, never a stale copy. */
export async function startApiDocumentRead(id) {
  const { data } = await api.post(`${BASE}/${encodeURIComponent(id)}/api-document/read`);
  return data; // { jobId }
}

export async function getApiDocumentReadStatus(id, jobId) {
  const { data } = await api.get(`${BASE}/${encodeURIComponent(id)}/api-document/read/status`, { params: { jobId } });
  return unwrap(data, 'job');
}

export async function readApiDocument(id, { onTick, signal } = {}) {
  const { jobId } = await startApiDocumentRead(id);
  const job = await pollJob(() => getApiDocumentReadStatus(id, jobId), (j) => j.state !== 'running', { onTick, signal });
  if (job.state === 'failed') throw new Error(job.error || 'The AI could not read the document.');
  const integration = await getIntegration(id);
  return { reading: job.reading ?? integration?.apiDocReading ?? null, integration };
}

/** Write-only. The server tests the candidate first and keeps a working secret over a
 *  failing one (spec §2b). The route is PUT /:id/secret and answers
 *  `{stored, verified, reason, integration}` — `verified` = stored AND the API answered
 *  with it. The secret itself never comes back. */
export async function setIntegrationSecret(id, secret) {
  const { data } = await api.put(`${BASE}/${encodeURIComponent(id)}/secret`, { secret });
  return {
    stored: !!data?.stored,
    verified: !!data?.verified,
    reason: data?.reason ?? null,
    integration: data?.integration ?? null,
  };
}

// ── Mapping ───────────────────────────────────────────────────────────────

export async function startProposal(id, prompt) {
  const body = prompt && prompt.trim() ? { prompt: prompt.trim() } : {};
  const { data } = await api.post(`${BASE}/${encodeURIComponent(id)}/propose/start`, body);
  return data; // { jobId }
}

export async function getProposalStatus(id, jobId) {
  const { data } = await api.get(`${BASE}/${encodeURIComponent(id)}/propose/status`, { params: { jobId } });
  return unwrap(data, 'job');
}

/** versionId omitted ⇒ the latest version. Returns {version, suggestions}. */
export async function listSuggestions(id, versionId) {
  const { data } = await api.get(`${BASE}/${encodeURIComponent(id)}/suggestions`, {
    params: versionId ? { versionId } : {},
  });
  return { version: data?.version ?? null, suggestions: Array.isArray(data?.suggestions) ? data.suggestions : [] };
}

/** ids: string[] | 'all' (the route's idsOf takes the literal 'all'). Approval is
 *  version-scoped (vm §9), so the version always travels. */
function decisionBody(versionId, ids) {
  return { versionId, ids };
}

export async function approveSuggestions(id, versionId, ids) {
  const { data } = await api.post(`${BASE}/${encodeURIComponent(id)}/suggestions/approve`, decisionBody(versionId, ids));
  return data; // SuggestionDecisionResult
}

export async function rejectSuggestions(id, versionId, ids) {
  const { data } = await api.post(`${BASE}/${encodeURIComponent(id)}/suggestions/reject`, decisionBody(versionId, ids));
  return data;
}

export async function listKpiDefinitions() {
  const { data } = await api.get(`${BASE}/kpi-definitions`);
  const list = unwrap(data, 'definitions');
  return Array.isArray(list) ? list : [];
}

export async function createKpiDefinition(input) {
  const { data } = await api.post(`${BASE}/kpi-definitions`, input);
  return unwrap(data, 'definition');
}

// ── Runs ──────────────────────────────────────────────────────────────────

/** dryRun true ⇒ versionId = the ON-SCREEN version (a test proves what you are looking at).
 *  A live run never sends a version: the server always uses approved_version_id. */
export async function startRun(id, { dryRun, versionId } = {}) {
  const body = { dryRun: !!dryRun };
  if (dryRun && versionId) body.versionId = versionId;
  const { data } = await api.post(`${BASE}/${encodeURIComponent(id)}/run/start`, body);
  return data; // { runId }
}

export async function getRunStatus(id, runId) {
  const { data } = await api.get(`${BASE}/${encodeURIComponent(id)}/run/status`, { params: { runId } });
  return unwrap(data, 'run');
}

/** Newest first, tests (dry runs) included — History filters them on screen. */
export async function listRuns(id, { limit = 50 } = {}) {
  const { data } = await api.get(`${BASE}/${encodeURIComponent(id)}/runs`, { params: { limit } });
  const list = unwrap(data, 'runs');
  return Array.isArray(list) ? list : [];
}

export async function listRunChanges(id, runId) {
  const { data } = await api.get(`${BASE}/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/changes`);
  const list = unwrap(data, 'changes');
  return Array.isArray(list) ? list : [];
}

// ── Turn on / pause ───────────────────────────────────────────────────────

/** Never runs anything (spec §2.5). Resume of a PAUSED integration is the same call with
 *  its approved version: the server re-checks the tested-version precondition. */
export async function activateIntegration(id, versionId) {
  const { data } = await api.post(`${BASE}/${encodeURIComponent(id)}/activate`, { versionId });
  return unwrap(data, 'integration');
}

export async function pauseIntegration(id) {
  const { data } = await api.post(`${BASE}/${encodeURIComponent(id)}/pause`);
  return unwrap(data, 'integration');
}

// ── Shared job polling ────────────────────────────────────────────────────

export const POLL_INTERVAL_MS = 2500;

/**
 * Poll `fetchStatus()` every `intervalMs` until `isDone(status)` — shared by proposals and
 * runs. Ported from vm proposeMappingInBackground/runIntegrationInBackground, with their
 * rules: a 4xx is final (the server has lost or never had the job); any other error is
 * retried, and `maxMisses` in a row gives up with a message that says it may still finish
 * (a run lives on the server, not in this tab). `onTick(status)` drives the overlay text.
 * `signal.cancelled = true` stops it (component unmount).
 */
export async function pollJob(fetchStatus, isDone, {
  intervalMs = POLL_INTERVAL_MS, maxMisses = 5, onTick, signal,
} = {}) {
  let misses = 0;
  for (;;) {
    if (signal?.cancelled) throw new Error('Stopped watching.');
    try {
      const status = await fetchStatus();
      misses = 0;
      onTick?.(status);
      if (status && isDone(status)) return status;
    } catch (e) {
      const code = e?.response?.status;
      if (code && code >= 400 && code < 500) throw e;
      misses += 1;
      if (misses >= maxMisses) {
        throw new Error('Lost track of the job — it may still finish on the server. Check History in a minute.');
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Start a proposal and wait for it. Resolves with the ProposeResult. */
export async function proposeAndWait(id, prompt, { onTick, signal } = {}) {
  const { jobId } = await startProposal(id, prompt);
  const job = await pollJob(() => getProposalStatus(id, jobId), (j) => j.state !== 'running', { onTick, signal });
  if (job.state === 'failed') throw new Error(job.error || 'The proposal failed.');
  return job.result;
}

/** Start a run and wait for it. Resolves with the final RunStatusView. */
export async function runAndWait(id, opts, { onTick, signal } = {}) {
  const { runId } = await startRun(id, opts);
  return pollJob(() => getRunStatus(id, runId), (r) => r.status !== 'RUNNING', { onTick, signal });
}
