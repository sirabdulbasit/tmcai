/**
 * DEF-362 — Integrations Stage 1b, fixes from the four-angle review (security lens).
 *
 * Each block pins one verified finding and fails without its fix:
 *  S1. The stored API secret is bound to the origin + sign-in scheme it was
 *      entered for: an api_config edit that moves either drops it (an AI draft
 *      lifted from a prompt-injected document must not carry the production
 *      credential to a new host). A same-origin edit keeps it.
 *  S2. redactSecrets catches URL userinfo, curl -u, credential-named query
 *      parameters (bare key/auth/sig) and X-…-Auth/Key headers.
 *  S3. Decompression bombs: a DOCX whose central directory declares more than
 *      DOC_MAX_UNZIPPED_BYTES is refused before mammoth runs; a PDF is parsed
 *      only up to DOC_MAX_PDF_PAGES pages; extracted text over
 *      DOC_MAX_TEXT_CHARS is refused (never stored).
 *  S4. The error-snippet scrub removes the WIRE forms of the secret (URL-
 *      encoded, form-encoded, base64) and any value of the credential query
 *      parameter.
 *  S5. api_config refuses credential-named keys anywhere in the body and
 *      query names that merely CONTAIN a credential word (hapikey, app_key…).
 *  S6. Replacing the credential of an ACTIVE integration is refused before the
 *      candidate is sent anywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { makeFakeDb } from './def354IntegrationFakeDb';

const h = vi.hoisted(() => ({
  db: null as any,
  mammothCalls: 0,
  pdfParams: [] as any[],
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/db/prisma', () => {
  const p = new Proxy({}, { get: (_t, k) => h.db.prisma[k] });
  return { __esModule: true, default: p, prisma: p };
});
vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async (key: string) => ({
    'integrations.doc_max_bytes': 5 * 1024 * 1024,
  } as Record<string, number>)[key],
}));
vi.mock('../src/services/llmRouter', () => ({ callLLM: async () => ({ text: '' }) }));
vi.mock('../src/services/userTimezoneService', () => ({
  isValidTimezone: () => true,
  resolveUserTimezone: async () => 'Asia/Karachi',
}));
vi.mock('mammoth', async () => {
  const real: any = await vi.importActual('mammoth');
  const extractRawText = async (o: any) => { h.mammothCalls += 1; return real.extractRawText(o); };
  return { default: { extractRawText }, extractRawText };
});
vi.mock('pdf-parse', () => ({
  PDFParse: class {
    async getText(params?: any) { h.pdfParams.push(params); return { text: 'GET /v1/items returns items.' }; }
    async destroy() {}
  },
}));

import {
  DOC_MAX_PDF_PAGES, DOC_MAX_TEXT_CHARS, declaredUnzippedBytes, extractDocText, redactSecrets,
} from '../src/services/integrations/sources/docReader';
import { __scrubForTests as scrub } from '../src/services/integrations/sources/apiReader';
import { createIntegration, updateIntegration, validateApiConfigInput } from '../src/services/integrations/store/integrationStore';
import { setSecret } from '../src/services/integrations/store/secretStore';
import { IntegrationInputError } from '../src/services/integrations/types';

const CN = 'TMC-0001';

beforeEach(() => {
  h.db = makeFakeDb();
  h.mammothCalls = 0;
  h.pdfParams = [];
});

// ── S1 ──────────────────────────────────────────────────────────────────────

const API = {
  baseUrl: 'https://api.vendor.com/v1', method: 'GET', path: '/items', authScheme: 'BEARER',
  recordsPath: 'data', idField: 'id',
};

async function apiWithSecret() {
  const dto = await createIntegration(CN, { name: 'Vendor', sourceKind: 'api', apiConfig: API } as any, 7);
  const row = h.db.tables.integrationSync[0];
  row.secretEnc = 'v1:iv:tag:ct';
  row.secretSetAt = new Date('2026-10-01T00:00:00Z');
  return { id: dto.id as string, row };
}

describe('S1 — the secret is bound to the origin it was entered for', () => {
  it('moving the base URL to another origin drops the stored secret', async () => {
    const { id, row } = await apiWithSecret();
    const dto = await updateIntegration(CN, id, { apiConfig: { ...API, baseUrl: 'https://api.attacker.example/v1' } } as any);
    expect(row.secretEnc).toBeNull();
    expect(row.secretSetAt).toBeNull();
    expect(dto.hasSecret).toBe(false);
  });

  it('changing the sign-in scheme drops it too', async () => {
    const { id, row } = await apiWithSecret();
    await updateIntegration(CN, id, { apiConfig: { ...API, authScheme: 'API_KEY', authQueryParam: 'k' } } as any);
    expect(row.secretEnc).toBeNull();
  });

  it('a same-origin edit (another path) keeps it', async () => {
    const { id, row } = await apiWithSecret();
    await updateIntegration(CN, id, { apiConfig: { ...API, path: '/orders' } } as any);
    expect(row.secretEnc).toBe('v1:iv:tag:ct');
  });
});

// ── S2 ──────────────────────────────────────────────────────────────────────

describe('S2 — redaction of the forms rule 5 missed', () => {
  const cases: Array<[string, string]> = [
    ['curl https://alice:S3cr3tPass@api.example.com/v1/items', 'S3cr3tPass'],
    ['curl -u ck_9f8a7b6c5d4e3f2a:cs_1a2b3c4d5e6f7a8b https://api.shop.com/wp-json/wc/v3/orders', 'cs_1a2b3c4d5e6f7a8b'],
    ['curl --user=admin:hunter22 https://api.shop.com/x', 'hunter22'],
    ['GET /orders?key=a1b2c3d4e5f6a7b8', 'a1b2c3d4e5f6a7b8'],
    ['GET /orders?status=open&sig=Zx9QpLm2Rt7Kw', 'Zx9QpLm2Rt7Kw'],
    ['X-Auth: Zx9QpLm2Rt7Kw', 'Zx9QpLm2Rt7Kw'],
    ['"X-Shop-Key": "q8w7e6r5t4"', 'q8w7e6r5t4'],
  ];
  for (const [input, secret] of cases) {
    it(`redacts: ${input}`, () => {
      const r = redactSecrets(input);
      expect(r.redactions).toBeGreaterThan(0);
      expect(r.text).not.toContain(secret);
      expect(redactSecrets(r.text).redactions).toBe(0); // idempotent
    });
  }

  it('keeps ordinary request lines and placeholders readable', () => {
    for (const keep of ['GET /orders?status=open&page=2', 'curl -u <user>:<pass> https://x', 'Host: api.example.com', '?key={your_key}']) {
      expect(redactSecrets(keep).text).toBe(keep);
    }
    expect(redactSecrets('https://api.example.com/v1/items').text).toBe('https://api.example.com/v1/items');
  });
});

// ── S3 ──────────────────────────────────────────────────────────────────────

async function docx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Rewrites every central-directory entry's declared uncompressed size. */
function declareSize(buf: Buffer, size: number): Buffer {
  const out = Buffer.from(buf);
  for (let i = 0; i + 4 <= out.length; i++) {
    if (out.readUInt32LE(i) === 0x02014b50) out.writeUInt32LE(size, i + 24);
  }
  return out;
}

describe('S3 — decompression bombs and text size', () => {
  it('a normal DOCX still reads (and its declared size is summed)', async () => {
    const buf = await docx('GET /v1/customers returns customers.');
    expect(declaredUnzippedBytes(buf)).toBeGreaterThan(100);
    expect(await extractDocText(buf, 'api.docx', '')).toContain('/v1/customers');
    expect(h.mammothCalls).toBe(1);
  });

  it('a DOCX declaring ~2 GB uncompressed is refused BEFORE mammoth runs', async () => {
    const bomb = declareSize(await docx('x'), 0x7fffffff);
    await expect(extractDocText(bomb, 'api.docx', '')).rejects.toBeInstanceOf(IntegrationInputError);
    expect(h.mammothCalls).toBe(0);
  });

  it('a DOCX that is not a walkable zip is refused before mammoth runs', async () => {
    await expect(extractDocText(Buffer.from('PK not really a zip at all, just bytes'), 'api.docx', '')).rejects.toBeInstanceOf(IntegrationInputError);
    expect(h.mammothCalls).toBe(0);
  });

  it('a PDF is parsed only up to the page cap', async () => {
    await extractDocText(Buffer.from('%PDF-1.4 stub'), 'api.pdf', 'application/pdf');
    expect(h.pdfParams[0]).toEqual({ first: DOC_MAX_PDF_PAGES });
  });

  it('extracted text over the character cap is refused, not stored', async () => {
    const big = Buffer.from('ab '.repeat(Math.ceil((DOC_MAX_TEXT_CHARS + 10) / 3)), 'utf8');
    expect(big.length).toBeLessThan(5 * 1024 * 1024);
    await expect(extractDocText(big, 'api.txt', 'text/plain')).rejects.toThrow(/characters/);
  });
});

// ── S4 ──────────────────────────────────────────────────────────────────────

describe('S4 — the error snippet never carries the secret in a wire form', () => {
  const secret = 'Zm9v+ab/c==';
  it('URL-encoded, form-encoded and base64 forms are removed', () => {
    const enc = encodeURIComponent(secret);
    const form = new URLSearchParams({ k: secret }).toString().slice(2);
    const b64 = Buffer.from('user:pa55word').toString('base64');
    expect(scrub(`{"url":"/v1/items?api_key=${enc}"}`, secret)).not.toContain(enc);
    expect(scrub(`echo ${form}`, secret)).not.toContain(form);
    expect(scrub(`got ${b64}`, 'user:pa55word')).not.toContain(b64);
  });

  it('any value of the credential query parameter is removed (even an unlisted encoding)', () => {
    const out = scrub('{"url":"/v1/items?page=2&api_key=Zm9v%252Bab%252Fc%253D%253D"}', secret, { authQueryParam: 'api_key' });
    expect(out).not.toContain('Zm9v%252B');
    expect(out).toContain('page=2');
  });
});

// ── S5 ──────────────────────────────────────────────────────────────────────

describe('S5 — api_config never stores a credential by another name', () => {
  const base = { baseUrl: 'https://api.hubapi.com', path: '/crm/v3/objects', recordsPath: 'results' };
  for (const q of ['hapikey', 'app_key', 'subscription-key', 'consumer_secret']) {
    it(`refuses the query parameter "${q}"`, () => {
      expect(() => validateApiConfigInput({ ...base, query: { [q]: 'pat-na1-1234' } })).toThrow(IntegrationInputError);
    });
  }
  it('refuses a credential key anywhere in the body (JSON-RPC params)', () => {
    expect(() => validateApiConfigInput({
      ...base, method: 'POST', body: { jsonrpc: '2.0', params: { args: [{ login: 'x', password: 'hunter2' }] } },
    })).toThrow(/password/);
  });
  it('keeps an ordinary body and query', () => {
    const cfg = validateApiConfigInput({ ...base, method: 'POST', query: { limit: '100' }, body: { filter: { status: 'active' } } });
    expect(cfg?.body).toEqual({ filter: { status: 'active' } });
  });
});

// ── S6 ──────────────────────────────────────────────────────────────────────

describe('S6 — no credential swap under an ACTIVE integration', () => {
  it('is refused before the candidate is tested or stored', async () => {
    const row = h.db.insert('integrationSync', {
      clientNumber: CN, name: 'Billing API', sourceKind: 'api', createdBy: 1, status: 'ACTIVE', secretEnc: 'v1:old',
    });
    const testFirst = vi.fn(async () => ({ ok: true, rows: 1, columns: [], sampleRow: null }));
    await expect(setSecret(CN, row.id, 'new-key-for-another-account', { testFirst } as any)).rejects.toThrow(/Pause/);
    expect(testFirst).not.toHaveBeenCalled();
    expect(h.db.tables.integrationSync[0].secretEnc).toBe('v1:old');
  });
});
