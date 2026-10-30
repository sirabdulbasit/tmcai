/**
 * DEF-365 — the Nexeo adapter for the vendored framework
 * (services/integrations/framework/index.ts) and the import boundaries.
 *
 * Pinned:
 *  - a framework TenantId is a clientNumber, checked on every call; a model
 *    call for another tenant, or one asking for tools, is refused;
 *  - the LlmProvider goes through llmRouter.callLLM with the tenant and purpose
 *    (spend is the router's) and reports finishReason 'unknown' so framework
 *    truncation guards stay on;
 *  - secrets go through secretStore with the tenant; store reads are tenant-bound;
 *  - NO Nexeo module imports a framework xlsx reader, the framework's
 *    Google/Microsoft OAuth (another account model), or the process-wide
 *    network policy; only docReader imports fileExtractor;
 *  - engine/** imports neither the adapter nor any AI module, vendored or not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ system: string; user: string; opts: any }>,
  secrets: [] as any[],
  wheres: [] as any[],
  row: null as any,
}));

vi.mock('../src/services/llmRouter', () => ({
  callLLM: async (system: string, user: string, opts: any) => { h.calls.push({ system, user, opts }); return { text: '{"ok":true}', provider: 'claude' }; },
}));
vi.mock('../src/services/integrations/store/secretStore', () => ({
  getSecret: async (cn: string, id: string) => { h.secrets.push(['get', cn, id]); return 'sk'; },
  setSecret: async (cn: string, id: string, v: string) => { h.secrets.push(['set', cn, id, v]); return { ok: true }; },
}));
vi.mock('../src/db/prisma', () => {
  const p = { integrationSync: { findFirst: async (a: any) => { h.wheres.push(a.where); return h.row && h.row.clientNumber === a.where.clientNumber && h.row.id === a.where.id ? h.row : null; } } };
  return { __esModule: true, default: p, prisma: p };
});

import { flattenMessages, getIntegrationRecord, nexeoAiProviderSource, nexeoLlmProvider, nexeoSecrets, tenantOf } from '../src/services/integrations/framework';

beforeEach(() => { h.calls = []; h.secrets = []; h.wheres = []; h.row = null; });

describe('DEF-365 adapter: tenant binding', () => {
  it('a tenant is a clientNumber, never a default', () => {
    expect(tenantOf('TMC-0001')).toBe('TMC-0001');
    expect(tenantOf(42)).toBe('42');
    for (const bad of ['', 'a b', 'x'.repeat(21), null as any, undefined as any]) expect(() => tenantOf(bad)).toThrow();
  });
});

describe('DEF-365 adapter: LlmProvider over callLLM', () => {
  it('routes through callLLM with the tenant and purpose', async () => {
    const p = nexeoLlmProvider('TMC-0001', { purpose: 'integration_mapping', providers: ['claude'], timeoutMs: 5000 });
    const r = await p.chat({ systemPrompt: 'S', messages: [{ role: 'user', content: 'U' }], maxOutputTokens: 900 });
    expect(h.calls).toEqual([{ system: 'S', user: 'U', opts: { clientNumber: 'TMC-0001', purpose: 'integration_mapping', providers: ['claude'], timeoutMs: 5000, maxTokens: 900 } }]);
    expect(r).toMatchObject({ text: '{"ok":true}', toolCalls: [], modelUsed: 'claude', finishReason: 'unknown' });
    expect(p.providerKey).toBe('anthropic');
  });
  it('refuses tools and a call for another tenant', async () => {
    const p = nexeoLlmProvider('TMC-0001', { purpose: 'x' });
    await expect(p.chat({ systemPrompt: 'S', messages: [{ role: 'user', content: 'U' }], tools: [{ name: 't', description: '', parameters: {} }] })).rejects.toThrow(/Tool calls/);
    await expect(p.chat({ systemPrompt: 'S', messages: [{ role: 'user', content: 'U' }], tenantKey: 'TMC-0002' })).rejects.toThrow(/different tenant/);
    expect(h.calls).toEqual([]);
  });
  it('several messages become one labelled prompt', () => {
    expect(flattenMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }])).toBe('USER: a\n\nASSISTANT: b');
  });
  it('AiProviderSource gives a provider bound to the asked tenant', async () => {
    const p = await nexeoAiProviderSource({ purpose: 'p' }).forTenant('TMC-0003');
    await p!.chat({ systemPrompt: 'S', messages: [{ role: 'user', content: 'U' }] });
    expect(h.calls[0]!.opts.clientNumber).toBe('TMC-0003');
  });
});

describe('DEF-365 adapter: secrets and store reads', () => {
  it('secrets go through secretStore with the tenant', async () => {
    expect(await nexeoSecrets.getSecret('TMC-0001', 'i1')).toBe('sk');
    await nexeoSecrets.setSecret('TMC-0001', 'i1', 'new');
    expect(h.secrets).toEqual([['get', 'TMC-0001', 'i1'], ['set', 'TMC-0001', 'i1', 'new']]);
    await expect(nexeoSecrets.getSecret('', 'i1')).rejects.toThrow();
  });
  it('the integration record is read tenant-bound; another tenant sees nothing', async () => {
    h.row = { id: 'i1', clientNumber: 'TMC-0001', name: 'Orders', adminBrief: 'b', purpose: null, sourceKind: 'api', apiConfig: { baseUrl: 'https://api.x', auth: { scheme: 'bearer' } }, secretSetAt: null, status: 'ACTIVE', frequency: 'daily', changeCapPct: 25 };
    expect(await getIntegrationRecord('TMC-0001', 'i1')).toMatchObject({ id: 'i1', tenantId: 'TMC-0001', sourceMode: 'api', baseUrl: 'https://api.x', authType: 'BEARER', authExtra: null });
    expect(await getIntegrationRecord('TMC-0002', 'i1')).toBeNull();
    expect(h.wheres).toEqual([{ id: 'i1', clientNumber: 'TMC-0001' }, { id: 'i1', clientNumber: 'TMC-0002' }]);
  });
});

describe('DEF-365 import boundaries', () => {
  const SRC = path.resolve(__dirname, '../src');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return p.includes(`${path.sep}vendor${path.sep}`) || e.name === 'vendor' ? [] : files(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
  const nexeo = files(SRC);
  const importsOf = (src: string) => [...src.matchAll(/import\s+([\s\S]*?)\s+from\s+'([^']*vendor\/ai-integration[^']*)'/g)].map((m) => ({ what: m[1]!, from: m[2]! }));

  it('no Nexeo module imports a framework xlsx reader, the framework OAuth, or the process-wide network policy', () => {
    const forbiddenModules = /sources\/(workbook|googleMicrosoftDrive)$|net\/networkPolicy$|vendor\/ai-integration$/;
    const forbiddenNames = /\b(readWorkbook|sheetNamesOf|downloadSheetLink|tabForLink|readSheetWithToken|readDriveFileWithToken|downloadWorkbook|accessTokenFor|configureOAuth|applyOutboundNetworkPolicy|sheetExportUrl|tabCsvUrl)\b/;
    const hits: string[] = [];
    for (const f of nexeo) {
      for (const i of importsOf(fs.readFileSync(f, 'utf8'))) {
        if (forbiddenModules.test(i.from) || (/sources\/sheetLink$/.test(i.from) && forbiddenNames.test(i.what))) hits.push(`${path.relative(SRC, f)}: ${i.what} from ${i.from}`);
      }
    }
    expect(hits).toEqual([]);
  });
  it('only docReader imports the framework file extractor', () => {
    const users = nexeo.filter((f) => importsOf(fs.readFileSync(f, 'utf8')).some((i) => /sources\/fileExtractor$/.test(i.from)));
    expect(users.map((f) => path.relative(SRC, f))).toEqual([path.join('services', 'integrations', 'sources', 'docReader.ts')]);
  });
  it('engine/** imports no AI module and not the adapter; the vendored modules it imports are AI-free', () => {
    const dir = path.join(SRC, 'services/integrations/engine');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/llmRouter|callLLM|integrations\/framework|from '\.\.\/framework|vendor\/ai-integration\/ai\//);
      for (const i of importsOf(src)) {
        const vendored = fs.readFileSync(path.resolve(dir, `${i.from}.ts`), 'utf8');
        expect(vendored, i.from).not.toMatch(/from '\.\.\/ai\/|llmProvider|batching/);
      }
    }
  });
});
