/**
 * DEF-367 — Connect works the way Vision Metric does (owner 10-30: "see how
 * vision metric work"). The owner's employee_directory_api.pdf reached Connect
 * with the example address "your-domain.com" and no key, because Nexeo blanks
 * every key out of the document; vm reads the key from the document and TESTS
 * it (vm integrationDocReader.pickWorkingSecret). Rules pinned here:
 *
 *  1. extractKeyCandidates returns exactly the credential values redaction
 *     removes — in document order, no placeholders, deduplicated, capped.
 *  2. attachApiDocument keeps those keys ONLY as 'v1:' ciphertext; the stored
 *     document text still has none of them.
 *  3. placeholderHost names documentation-example hosts; a test against one
 *     answers without any network call; the AI's draft names it as a gap.
 *  4. tryDocumentKeys tries the printed keys in order and stores the first that
 *     returns records; nothing on an ACTIVE integration; never a key in a reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/services/behaviorConfig', () => ({
  BEHAVIOR_SPECS: {},
  resolveBehaviorValue: () => undefined,
  getBehaviorValue: async (key: string) => ({
    'integrations.doc_max_bytes': 5 * 1024 * 1024,
    'integrations.api_max_bytes': 20 * 1024 * 1024,
    'integrations.api_timeout_ms': 60000,
    'integrations.api_max_pages': 50,
    'integrations.max_rows': 50000,
  } as Record<string, number>)[key],
}));
vi.mock('../src/services/llmRouter', () => ({ callLLM: async () => ({ text: '{}', provider: 'gemini' }) }));
const net = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/services/integrations/sources/integrationFetch', async (orig) => {
  const actual = await orig<typeof import('../src/services/integrations/sources/integrationFetch')>();
  return { ...actual, guardedFetch: async () => { net.calls++; throw new Error('network must not be called'); } };
});
const db = vi.hoisted(() => ({ row: null as any, updates: [] as any[] }));
vi.mock('../src/db/prisma', () => ({
  __esModule: true,
  default: {
    integrationSync: {
      findFirst: async (a: any) => (db.row && a.where.id === db.row.id && a.where.clientNumber === db.row.clientNumber ? db.row : null),
      updateMany: async (a: any) => {
        db.updates.push(a);
        const hit = db.row && a.where.id === db.row.id && a.where.clientNumber === db.row.clientNumber;
        if (hit) Object.assign(db.row, a.data);
        return { count: hit ? 1 : 0 };
      },
    },
  },
}));

import { attachApiDocument, extractKeyCandidates, redactSecrets, sanitiseDraft } from '../src/services/integrations/sources/docReader';
import { placeholderHost, testApiWith } from '../src/services/integrations/sources/apiReader';
import { decryptSecret, encryptSecret } from '../src/services/integrations/store/secretStore';
import * as apiReader from '../src/services/integrations/sources/apiReader';
import * as secretStore from '../src/services/integrations/store/secretStore';
import { tryDocumentKeys } from '../src/services/integrations/sources/docKeys';

const CN = 'TENANT_A';
const KEY_1 = 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm';      // the "authentication section" key
const KEY_2 = 'Mn4Bv5Cx6Za7Sd8Fg9Hj0Kl1Qw2Er3Ty';      // the "code examples" key
// The shape of the owner's employee-directory document: an example host, an
// x-api-key header, and TWO different keys (vm's own note on ESS said so).
const DOC = [
  'Employee Directory API',
  'Base URL: https://your-domain.com/taql/api',
  'Authentication: send the key in the x-api-key header.',
  `x-api-key: ${KEY_1}`,
  'Example:',
  `curl -H "x-api-key: ${KEY_2}" https://your-domain.com/taql/api/employee/directory`,
  'Placeholder form: x-api-key: <your-key>',
  `Repeat: x-api-key: ${KEY_1}`,
].join('\n');

let savedKey: string | undefined;
beforeEach(() => {
  db.row = null;
  db.updates = [];
  net.calls = 0;
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  vi.restoreAllMocks();
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
});

describe('DEF-367 1. extractKeyCandidates', () => {
  it('returns the printed keys in document order, deduplicated, never a placeholder', () => {
    expect(extractKeyCandidates(DOC)).toEqual([KEY_1, KEY_2]);
  });

  it('collects exactly what redaction removes: Bearer, name=value, query parameter', () => {
    const doc = 'Authorization: Bearer a8F3kQ9zL2mN7pR4tV6wX1yB5cD0eG8h\napi_key=QQ11ww22EE33rr44\nGET /x?token=tok_ABCDEFGH1234';
    const keys = extractKeyCandidates(doc);
    expect(keys).toEqual(expect.arrayContaining(['a8F3kQ9zL2mN7pR4tV6wX1yB5cD0eG8h', 'QQ11ww22EE33rr44', 'tok_ABCDEFGH1234']));
    for (const k of keys) expect(redactSecrets(doc).text).not.toContain(k);
  });

  it('a document with no key gives none, and redactSecrets is unchanged by the refactor', () => {
    expect(extractKeyCandidates('GET https://api.crm.test/v1/customers\nx-api-key: <your-key>')).toEqual([]);
    expect(redactSecrets(DOC).redactions).toBeGreaterThanOrEqual(3);
    expect(redactSecrets(DOC).text).not.toContain(KEY_1);
    expect(redactSecrets(DOC).text).not.toContain(KEY_2);
  });

  it('is capped at 10 candidates', () => {
    const doc = Array.from({ length: 15 }, (_, i) => `api_key=KEYVALUE${String(i).padStart(4, '0')}abcd`).join('\n');
    expect(extractKeyCandidates(doc)).toHaveLength(10);
  });
});

describe('DEF-367 2. attachApiDocument keeps the keys only as ciphertext', () => {
  it('stores v1: ciphertext of the keys; the document text holds none of them', async () => {
    db.row = { id: 'i1', clientNumber: CN };
    const res = await attachApiDocument(CN, 'i1', { text: DOC, name: 'employee_directory_api.pdf' });
    expect(res.keysKept).toBe(2);
    const data = db.updates[0].data;
    expect(data.apiDocKeysEnc).toMatch(/^v1:/);
    expect(data.apiDocKeysEnc).not.toContain(KEY_1);
    expect(JSON.parse(decryptSecret(data.apiDocKeysEnc))).toEqual([KEY_1, KEY_2]);
    expect(data.apiDocText).not.toContain(KEY_1);
    expect(data.apiDocText).not.toContain(KEY_2);
  });

  it('without a server key nothing is kept — never a plaintext fallback — and the attach still works', async () => {
    delete process.env.ENCRYPTION_KEY;
    db.row = { id: 'i1', clientNumber: CN };
    const res = await attachApiDocument(CN, 'i1', { text: DOC });
    expect(res.keysKept).toBe(0);
    expect(db.updates[0].data.apiDocKeysEnc).toBeNull();
    expect(JSON.stringify(db.updates)).not.toContain(KEY_1);
  });

  it('a new document without keys clears the old keys', async () => {
    db.row = { id: 'i1', clientNumber: CN, apiDocKeysEnc: encryptSecret(JSON.stringify([KEY_1])) };
    await attachApiDocument(CN, 'i1', { text: 'GET https://api.crm.test/v1/customers' });
    expect(db.row.apiDocKeysEnc).toBeNull();
  });
});

describe('DEF-367 3. example addresses', () => {
  it('names documentation-example hosts and leaves real ones alone', () => {
    expect(placeholderHost('https://your-domain.com/taql/api')).toBe('your-domain.com');
    expect(placeholderHost('https://api.example.com/v1')).toBe('api.example.com');
    expect(placeholderHost('https://yourcompany.io')).toBe('yourcompany.io');
    expect(placeholderHost('https://erp.tmcltd.com:5004/taql/api')).toBeNull();
    expect(placeholderHost('https://api.hubspot.com')).toBeNull();
  });

  it('a test against an example host answers without any network call', async () => {
    const r = await testApiWith(CN, {
      baseUrl: 'https://your-domain.com/taql/api', method: 'GET', path: '/employee/directory', query: {},
      authScheme: 'API_KEY', authHeaderName: 'x-api-key', recordsPath: 'data', idField: 'id', pagination: { kind: 'none' },
    } as any, KEY_1);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/document's example \(your-domain\.com\)/);
    expect(net.calls).toBe(0);
  });

  it("the AI's draft keeps the example address but names it as a gap", () => {
    const { draft, gaps } = sanitiseDraft({ baseUrl: 'https://your-domain.com/taql/api', path: '/employee/directory' });
    expect(draft.baseUrl).toBe('https://your-domain.com/taql/api');
    expect(gaps.join(' ')).toMatch(/your-domain\.com\) is an example/);
  });
});

describe('DEF-367 4. tryDocumentKeys (vm pickWorkingSecret)', () => {
  const cfg = {
    baseUrl: 'https://erp.tmcltd.com:5004/taql/api', method: 'GET', path: '/employee/directory', query: {},
    authScheme: 'API_KEY', authHeaderName: 'x-api-key', recordsPath: 'data', idField: 'email', pagination: { kind: 'none' },
  };
  const seed = (status = 'DRAFT') => {
    db.row = { id: 'i1', clientNumber: CN, status, apiDocKeysEnc: encryptSecret(JSON.stringify([KEY_1, KEY_2])) };
  };

  it('tries the printed keys in order and stores the first that returns records', async () => {
    seed();
    const tested: string[] = [];
    vi.spyOn(apiReader, 'testApiWith').mockImplementation(async (_cn, _cfg, key) => {
      tested.push(key as string);
      return key === KEY_2
        ? { ok: true, rows: 3, columns: ['email'], sampleRow: { email: 'a@b.c' } }
        : { ok: false, rows: 0, columns: [], sampleRow: null, reason: 'The API refused the credential (HTTP 403).' };
    });
    const stored = vi.spyOn(secretStore, 'setSecret').mockResolvedValue({ stored: true, test: null });
    const out = await tryDocumentKeys(CN, { id: 'i1', status: 'DRAFT', apiConfig: cfg });
    expect(tested).toEqual([KEY_1, KEY_2]);
    expect(out).toMatchObject({ adopted: true, tried: 2 });
    expect(stored).toHaveBeenCalledWith(CN, 'i1', KEY_2);
  });

  it('when none works: nothing stored, the count and the last answer — never a key — in the outcome', async () => {
    seed();
    vi.spyOn(apiReader, 'testApiWith').mockResolvedValue({ ok: false, rows: 0, columns: [], sampleRow: null, reason: 'HTTP 401' });
    const stored = vi.spyOn(secretStore, 'setSecret');
    const out = await tryDocumentKeys(CN, { id: 'i1', status: 'DRAFT', apiConfig: cfg });
    expect(out).toMatchObject({ adopted: false, tried: 2, lastReason: 'HTTP 401' });
    expect(stored).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain(KEY_1);
  });

  it('never on an ACTIVE integration: no key is sent anywhere', async () => {
    seed('ACTIVE');
    const t = vi.spyOn(apiReader, 'testApiWith');
    const out = await tryDocumentKeys(CN, { id: 'i1', status: 'ACTIVE', apiConfig: cfg });
    expect(t).not.toHaveBeenCalled();
    expect(out).toMatchObject({ adopted: false, tried: 0 });
    expect(out.skipped).toMatch(/pause it first/);
  });

  it('no keys are tried against an example host or a connection that signs in with nothing', async () => {
    seed();
    const t = vi.spyOn(apiReader, 'testApiWith');
    await tryDocumentKeys(CN, { id: 'i1', status: 'DRAFT', apiConfig: { ...cfg, baseUrl: 'https://your-domain.com/taql/api' } });
    await tryDocumentKeys(CN, { id: 'i1', status: 'DRAFT', apiConfig: { ...cfg, authScheme: 'NONE' } });
    expect(t).not.toHaveBeenCalled();
  });

  it('another tenant never reaches this integration\'s keys', async () => {
    seed();
    const t = vi.spyOn(apiReader, 'testApiWith');
    const out = await tryDocumentKeys('TENANT_B', { id: 'i1', status: 'DRAFT', apiConfig: cfg });
    expect(t).not.toHaveBeenCalled();
    expect(out.tried).toBe(0);
  });
});
