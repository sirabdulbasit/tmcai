/**
 * DEF-362 — the pure rules behind the Stage 1b screens, kept out of the JSX so they can
 * be pinned by tests (server/tests/def362IntegrationClient.test.ts) without a browser.
 *
 *  - The API connection form ⇄ ApiConfig (server types.ts). The form is strings; the
 *    config is what the server stores. `configFromForm` is the ONE conversion, and
 *    "is the form dirty?" compares two configs built by it, so a saved config that the
 *    server canonicalised (nulls, defaults) does not look edited.
 *  - The draft from the AI's reading of the document only PRE-FILLS the form; a saved
 *    config always wins over the draft (the admin's edits are never overwritten by a
 *    re-read).
 *  - The secret is never in the form or the config (it has its own write-only call).
 *  - Review groups rows by target (KPI · Context · Filter · Not used); a filter row on
 *    its own is not something a run can do, so it does not unlock Continue / the test.
 */

export const AUTH_SCHEMES = ['NONE', 'BEARER', 'API_KEY', 'BASIC'];
export const API_METHODS = ['GET', 'POST'];
export const PAGINATION_KINDS = ['none', 'page', 'offset', 'next_url'];

const str = (v) => (v === undefined || v === null ? '' : String(v));

function queryToText(q) {
  if (!q || typeof q !== 'object') return '';
  return Object.entries(q).map(([k, v]) => `${k}=${v}`).join('\n');
}

/** ApiConfig (or the AI's Partial<ApiConfig> draft) → form strings. */
export function formFromConfig(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const p = c.pagination && typeof c.pagination === 'object' ? c.pagination : { kind: 'none' };
  return {
    baseUrl: str(c.baseUrl),
    method: API_METHODS.includes(c.method) ? c.method : 'GET',
    path: str(c.path),
    query: queryToText(c.query),
    body: c.body && typeof c.body === 'object' ? JSON.stringify(c.body, null, 2) : '',
    authScheme: AUTH_SCHEMES.includes(c.authScheme) ? c.authScheme : 'NONE',
    authHeaderName: str(c.authHeaderName),
    authQueryParam: str(c.authQueryParam),
    recordsPath: str(c.recordsPath),
    idField: str(c.idField),
    declaredTotalPath: str(c.declaredTotalPath),
    pageKind: PAGINATION_KINDS.includes(p.kind) ? p.kind : 'none',
    pageParam: str(p.pageParam),
    pageSizeParam: str(p.pageSizeParam),
    offsetParam: str(p.offsetParam),
    limitParam: str(p.limitParam),
    nextUrlPath: str(p.nextUrlPath),
    pageSize: str(p.pageSize),
    startPage: str(p.startPage),
    maxPages: str(p.maxPages),
  };
}

/** The form the Connect step opens with: the SAVED config when there is one, else the
 *  AI's draft, else blank. A re-read of the document never overwrites saved edits. */
export function initialForm(integ) {
  if (integ?.apiConfig) return formFromConfig(integ.apiConfig);
  return formFromConfig(integ?.apiDocReading?.draft ?? null);
}

function posInt(raw, label, errors, { min = 1 } = {}) {
  const t = String(raw ?? '').trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isInteger(n) || n < min) {
    errors.push(`${label} must be a whole number${min > 0 ? ` of at least ${min}` : ''}.`);
    return undefined;
  }
  return n;
}

/**
 * Form → `{config, errors}`. `config` is null when `errors` is non-empty. The server
 * validates again; these checks only stop the admin sending something that cannot work
 * (vm: a draft is a question until the admin answers it).
 */
export function configFromForm(f) {
  const errors = [];
  const baseUrl = String(f.baseUrl ?? '').trim();
  if (!baseUrl) errors.push('The base URL is missing.');
  else if (!/^https:\/\/[^\s/]+/i.test(baseUrl)) errors.push('The base URL must start with https:// (plain http is refused).');

  const query = {};
  for (const line of String(f.query ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i <= 0) { errors.push(`Fixed query line “${t}” must look like name=value.`); continue; }
    query[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }

  const method = API_METHODS.includes(f.method) ? f.method : 'GET';
  let body = null;
  if (method === 'POST' && String(f.body ?? '').trim()) {
    try {
      const parsed = JSON.parse(f.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) errors.push('The request body must be a JSON object.');
      else body = parsed;
    } catch {
      errors.push('The request body is not valid JSON.');
    }
  }

  const authScheme = AUTH_SCHEMES.includes(f.authScheme) ? f.authScheme : 'NONE';
  const authHeaderName = authScheme === 'API_KEY' ? (String(f.authHeaderName ?? '').trim() || null) : null;
  const authQueryParam = authScheme === 'API_KEY' ? (String(f.authQueryParam ?? '').trim() || null) : null;

  const maxPages = posInt(f.maxPages, 'Max pages', errors);
  let pagination;
  switch (f.pageKind) {
    case 'page': {
      const pageParam = String(f.pageParam ?? '').trim();
      if (!pageParam) errors.push('Name the page-number parameter.');
      const pageSize = posInt(f.pageSize, 'Page size', errors);
      const startPage = posInt(f.startPage, 'First page', errors, { min: 0 });
      pagination = { kind: 'page', pageParam };
      const sp = String(f.pageSizeParam ?? '').trim();
      if (sp) pagination.pageSizeParam = sp;
      if (pageSize !== undefined) pagination.pageSize = pageSize;
      if (startPage !== undefined) pagination.startPage = startPage;
      break;
    }
    case 'offset': {
      const offsetParam = String(f.offsetParam ?? '').trim();
      if (!offsetParam) errors.push('Name the offset parameter.');
      const pageSize = posInt(f.pageSize, 'Page size', errors);
      if (pageSize === undefined && !errors.some((e) => e.startsWith('Page size'))) errors.push('Offset pages need a page size.');
      pagination = { kind: 'offset', offsetParam, pageSize: pageSize ?? 0 };
      const lp = String(f.limitParam ?? '').trim();
      if (lp) pagination.limitParam = lp;
      break;
    }
    case 'next_url': {
      const nextUrlPath = String(f.nextUrlPath ?? '').trim();
      if (!nextUrlPath) errors.push('Say where the next-page link is in the answer.');
      pagination = { kind: 'next_url', nextUrlPath };
      break;
    }
    default:
      pagination = { kind: 'none' };
  }
  if (pagination.kind !== 'none' && maxPages !== undefined) pagination.maxPages = maxPages;

  const config = {
    baseUrl,
    method,
    path: String(f.path ?? '').trim(),
    query,
    body,
    authScheme,
    authHeaderName,
    authQueryParam,
    recordsPath: String(f.recordsPath ?? '').trim(),
    idField: String(f.idField ?? '').trim() || null,
    pagination,
    declaredTotalPath: String(f.declaredTotalPath ?? '').trim() || null,
  };
  return { config: errors.length ? null : config, errors };
}

/** Stable JSON (sorted keys) — so key order never makes a config look edited. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** True when the form differs from the saved config (or nothing is saved yet). Both
 *  sides go through configFromForm, so only a real edit counts. An invalid form is
 *  dirty: it cannot be what was tested. */
export function isConfigDirty(form, savedConfig) {
  if (!savedConfig) return true;
  const a = configFromForm(form);
  if (!a.config) return true;
  const b = configFromForm(formFromConfig(savedConfig));
  return stable(a.config) !== stable(b.config);
}

/** Does the scheme carry a secret at all? NONE never asks for one. */
export function needsSecret(authScheme) {
  return authScheme && authScheme !== 'NONE';
}

/** "N records on this page (declared total M)" — spec §2b Connect. */
export function pageCountText(result) {
  if (!result) return '';
  const n = Number(result.pageRecords ?? result.rows ?? 0);
  const total = result.declaredTotal;
  const base = `${n} ${n === 1 ? 'record' : 'records'} on this page`;
  return total === null || total === undefined ? base : `${base} (declared total ${total})`;
}

// ── Review ─────────────────────────────────────────────────────────────────

export const REVIEW_GROUPS = ['kpi', 'context', 'filter', 'not_used'];

/** Rows by target. A REJECTED row of any kind is "Not used" — the admin (or the AI)
 *  decided it does not go anywhere — and keeps its reason. */
export function groupSuggestions(suggestions) {
  const g = { kpi: [], context: [], filter: [], not_used: [] };
  for (const sg of suggestions || []) {
    if (sg.status === 'REJECTED') { g.not_used.push(sg); continue; }
    const kind = sg.targetKind || 'kpi';
    (g[kind] || g.kpi).push(sg);
  }
  return g;
}

/** Fields the proposer reported as not used (spec §2b "Not used, with the reason").
 *  Read from the version spec when the proposer stores them there; tolerant of
 *  either key, and of plain strings. */
export function notUsedFromSpec(spec) {
  const raw = Array.isArray(spec?.notUsed) ? spec.notUsed : Array.isArray(spec?.unused) ? spec.unused : [];
  return raw.map((x) => (typeof x === 'string'
    ? { field: x, reason: '', followed: null }
    : { field: String(x?.field ?? ''), reason: String(x?.reason ?? ''), followed: x?.followed ? String(x.followed) : null }))
    .filter((x) => x.field);
}

/** Approved rows a run can act on. The filter only narrows what KPI / Context rows
 *  read; approved on its own the run has nothing to do (runEngine fails it), so it
 *  does not count towards Continue or the test. */
export function runnableApprovedCount(suggestions) {
  return (suggestions || []).filter((x) => x.status === 'APPROVED' && x.targetKind !== 'filter').length;
}

/** Review's notice list without the "Not used: …" lines when the spec carries
 *  spec.notUsed — the proposer writes each such field to BOTH, and Review already
 *  shows notUsed in its own "Not used" group (DEF-362 review: every reason was
 *  listed twice). An older spec without notUsed keeps its notices as they are. */
export function reviewNotices(spec) {
  const notices = Array.isArray(spec?.notices) ? spec.notices : [];
  if (notUsedFromSpec(spec).length === 0) return notices;
  return notices.filter((n) => !/^Not used: /.test(String(n)));
}
