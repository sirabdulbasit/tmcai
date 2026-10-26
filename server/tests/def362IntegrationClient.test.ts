/**
 * DEF-362 — Integrations Stage 1b client rules (spec §2b), pinned without a browser.
 *
 * The pure logic lives in client/src/pages/admin/integrations/integrationLogic.js and is
 * imported directly; the JSX wiring is pinned by source checks, like the def354 client
 * pins in def354IntegrationStore.test.ts. Each test names the rule it holds and fails
 * when that rule is removed.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { INTEGRATION_INPUT_KEYS } from '../src/services/integrations/types';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain JS module from the client, no type declarations.
import * as logic from '../../client/src/pages/admin/integrations/integrationLogic.js';

const DIR = path.join(__dirname, '../../client/src/pages/admin/integrations');
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');
const apiSrc = fs.readFileSync(path.join(__dirname, '../../client/src/services/integrationsApi.js'), 'utf8');

const SAVED = {
  baseUrl: 'https://api.example.com/v2',
  method: 'GET',
  path: '/customers',
  query: { status: 'active' },
  body: null,
  authScheme: 'API_KEY',
  authHeaderName: 'X-Key',
  authQueryParam: null,
  recordsPath: 'data.items',
  idField: 'id',
  pagination: { kind: 'page', pageParam: 'page', pageSize: 50 },
  declaredTotalPath: 'meta.total',
};

describe('DEF-362 client — the connection form', () => {
  it('a SAVED config wins over the AI draft; the draft only pre-fills when nothing is saved', () => {
    const draft = { baseUrl: 'https://draft.example.com', path: '/x' };
    expect(logic.initialForm({ apiConfig: SAVED, apiDocReading: { draft } }).baseUrl).toBe(SAVED.baseUrl);
    const f = logic.initialForm({ apiConfig: null, apiDocReading: { draft } });
    expect(f.baseUrl).toBe('https://draft.example.com');
    expect(f.path).toBe('/x');
    expect(logic.initialForm(null).baseUrl).toBe('');
  });

  it('round-trips a saved config exactly (form → config is the one conversion)', () => {
    const { config, errors } = logic.configFromForm(logic.formFromConfig(SAVED));
    expect(errors).toEqual([]);
    expect(config).toEqual(SAVED);
  });

  it('refuses a non-https base URL before it is ever sent', () => {
    const f = { ...logic.formFromConfig(SAVED), baseUrl: 'http://api.example.com' };
    const r = logic.configFromForm(f);
    expect(r.config).toBeNull();
    expect(r.errors.join(' ')).toMatch(/https/);
  });

  it('rejects malformed query lines and invalid POST bodies; GET ignores the body', () => {
    const base = logic.formFromConfig(SAVED);
    expect(logic.configFromForm({ ...base, query: 'novalue' }).config).toBeNull();
    expect(logic.configFromForm({ ...base, method: 'POST', body: '{bad' }).config).toBeNull();
    expect(logic.configFromForm({ ...base, method: 'POST', body: '[1]' }).config).toBeNull();
    expect(logic.configFromForm({ ...base, method: 'POST', body: '{"a":1}' }).config.body).toEqual({ a: 1 });
    expect(logic.configFromForm({ ...base, method: 'GET', body: '{bad' }).config.body).toBeNull();
  });

  it('pagination: each kind needs its parameter; offset needs a page size', () => {
    const base = logic.formFromConfig(SAVED);
    expect(logic.configFromForm({ ...base, pageKind: 'page', pageParam: '' }).config).toBeNull();
    expect(logic.configFromForm({ ...base, pageKind: 'offset', offsetParam: 'offset', pageSize: '' }).config).toBeNull();
    expect(logic.configFromForm({ ...base, pageKind: 'next_url', nextUrlPath: '' }).config).toBeNull();
    expect(logic.configFromForm({ ...base, pageKind: 'offset', offsetParam: 'o', pageSize: '25', maxPages: '3' }).config.pagination)
      .toEqual({ kind: 'offset', offsetParam: 'o', pageSize: 25, maxPages: 3 });
    expect(logic.configFromForm({ ...base, pageKind: 'none', maxPages: '3' }).config.pagination).toEqual({ kind: 'none' });
  });

  it('API-key names are dropped for any other scheme; the config never carries a secret', () => {
    const f = { ...logic.formFromConfig(SAVED), authScheme: 'BEARER', secret: 'sk_live_abc', password: 'x' };
    const { config } = logic.configFromForm(f);
    expect(config.authHeaderName).toBeNull();
    expect(config.authQueryParam).toBeNull();
    expect(JSON.stringify(config)).not.toContain('sk_live_abc');
    expect(Object.keys(config)).not.toContain('secret');
  });

  it('dirty = a real edit only: a saved config (any key order) is clean; an edit, an invalid form or nothing saved is dirty', () => {
    const reordered = Object.fromEntries(Object.entries(SAVED).reverse());
    expect(logic.isConfigDirty(logic.formFromConfig(SAVED), reordered)).toBe(false);
    expect(logic.isConfigDirty({ ...logic.formFromConfig(SAVED), path: '/orders' }, SAVED)).toBe(true);
    expect(logic.isConfigDirty({ ...logic.formFromConfig(SAVED), baseUrl: 'http://x' }, SAVED)).toBe(true);
    expect(logic.isConfigDirty(logic.formFromConfig(SAVED), null)).toBe(true);
  });

  it('only a scheme that signs in asks for a secret', () => {
    expect(logic.needsSecret('NONE')).toBe(false);
    for (const a of ['BEARER', 'API_KEY', 'BASIC']) expect(logic.needsSecret(a)).toBe(true);
  });

  it('"N records on this page (declared total M)"', () => {
    expect(logic.pageCountText({ ok: true, rows: 20, pageRecords: 20, declaredTotal: 1156 }))
      .toBe('20 records on this page (declared total 1156)');
    expect(logic.pageCountText({ ok: true, rows: 1, pageRecords: 1, declaredTotal: null })).toBe('1 record on this page');
  });
});

describe('DEF-362 client — Review groups', () => {
  const rows = [
    { id: 'k', targetKind: 'kpi', status: 'APPROVED' },
    { id: 'c', targetKind: 'context', status: 'PENDING' },
    { id: 'f', targetKind: 'filter', status: 'APPROVED' },
    { id: 'r', targetKind: 'context', status: 'REJECTED' },
  ];

  it('groups by target; a REJECTED row of any kind is "Not used"', () => {
    const g = logic.groupSuggestions(rows);
    expect(g.kpi.map((x: { id: string }) => x.id)).toEqual(['k']);
    expect(g.context.map((x: { id: string }) => x.id)).toEqual(['c']);
    expect(g.filter.map((x: { id: string }) => x.id)).toEqual(['f']);
    expect(g.not_used.map((x: { id: string }) => x.id)).toEqual(['r']);
  });

  it('an approved filter on its own does not unlock Continue / the test (nothing to feed)', () => {
    expect(logic.runnableApprovedCount([{ targetKind: 'filter', status: 'APPROVED' }])).toBe(0);
    expect(logic.runnableApprovedCount(rows)).toBe(1);
  });

  it('reads the proposer\'s "not used" fields with their reasons', () => {
    expect(logic.notUsedFromSpec({ notUsed: [{ field: 'notes', reason: 'free text', followed: 'ignore notes' }, 'x', { reason: 'no field' }] }))
      .toEqual([
        { field: 'notes', reason: 'free text', followed: 'ignore notes' },
        { field: 'x', reason: '', followed: null },
      ]);
    expect(logic.notUsedFromSpec({})).toEqual([]);
  });
});

describe('DEF-362 client — wiring pins', () => {
  it('the client whitelist mirrors the server INTEGRATION_INPUT_KEYS exactly (never the secret / approvedFilter / doc text)', () => {
    const m = apiSrc.match(/export const INTEGRATION_INPUT_KEYS = \[([\s\S]*?)\];/);
    expect(m).not.toBeNull();
    const keys = [...m![1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]);
    expect(keys.sort()).toEqual([...INTEGRATION_INPUT_KEYS].sort());
    for (const k of ['secret', 'approvedFilter', 'apiDocText', 'apiDocReading']) expect(keys).not.toContain(k);
  });

  it('the secret has its own write-only call and a password field that is never pre-filled', () => {
    expect(apiSrc).toMatch(/export async function setIntegrationSecret\(id, secret\)/);
    const connect = read('StepConnect.jsx');
    expect(connect).toMatch(/type="password"/);
    expect(connect).toMatch(/const \[secret, setSecret\] = useState\(''\);/);
    expect(connect).toContain('Stored encrypted, never shown again.');
    expect(connect).toContain('A secret is stored.');
    // Cleared from memory before the request goes out.
    expect(connect).toMatch(/const candidate = secret;\s*\n\s*setSecret\(''\);/);
  });

  it('Connect: one record view, page count, instructions box, and Suggest gated on a passing test of the current connection', () => {
    const connect = read('StepConnect.jsx');
    expect(connect).toContain('<OneRecord record={result.sampleRow}');
    expect(connect).toContain('pageCountText(result)');
    expect(connect).toContain('How should this data be mapped?');
    expect(connect).toMatch(/const tested = !!integ\?\.connectionOk && !dirty;/);
    expect(connect).toMatch(/disabled=\{!tested \|\| busy\} onClick=\{suggest\}/);
    expect(connect).toContain('stageHasMapping(integ?.stage)');
  });

  it('Basics: source choice, document upload ≤5 MB, Read with AI, gaps list, remarks and filter words', () => {
    const basics = read('StepBasics.jsx');
    expect(basics).toContain("kind: 'api'");
    expect(basics).toContain('accept={DOC_ACCEPT}');
    expect(basics).toMatch(/file\.size > DOC_MAX_BYTES/);
    expect(basics).toContain('Read with AI');
    expect(basics).toContain('What the document did not say');
    expect(basics).toContain('Remarks for the AI');
    expect(basics).toContain('Filters (in your words');
    expect(apiSrc).toContain("export const DOC_ACCEPT = '.pdf,.docx,.txt,.md,.json';");
  });

  it('Review: grouped, every row shows what it followed; Continue counts runnable rows only', () => {
    const review = read('StepReview.jsx');
    expect(review).toContain('Brain will be able to read this as knowledge');
    expect(review).toMatch(/sg\.followed && <Followed/);
    expect(review).toContain('<FilterConditions filter={sg.transform} words={integ.filterInstructions} />');
    expect(review).toMatch(/disabled=\{runnable === 0\} onClick=\{onNext\}/);
  });

  it('Test & turn on: page create/update/stale tiles and filtered-out records; Stage 1 pins kept', () => {
    const t = read('StepTestTurnOn.jsx');
    for (const label of ['Knowledge pages to create', 'Knowledge pages to update', 'Pages to mark stale', 'Records filtered out']) {
      expect(t).toContain(label);
    }
    expect(t).toMatch(/Date\.parse\(r\.startedAt\) >= lastDecided/);
    const ui = read('integrationUi.jsx');
    expect(ui).toContain('export function isContextChange(c)');
    expect(ui).toContain('No changes — see notes');
  });
});
