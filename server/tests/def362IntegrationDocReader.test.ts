/**
 * DEF-362 — Integrations Stage 1b, sources/docReader.ts (spec §2b Basics,
 * "AI reads the document").
 *
 * Pinned:
 *  1. extractDocText reads PDF (pdf-parse), DOCX (mammoth), TXT / MD / JSON —
 *     fixtures are generated in-test; over doc_max_bytes, an unknown type, a
 *     binary ".txt" and an empty document are refused.
 *  2. redactSecrets removes bearer tokens, Authorization values, api_key=…,
 *     password fields, JWTs, vendor keys and long high-entropy tokens, counts
 *     them, keeps the scheme word and ordinary prose/UUIDs, and is idempotent.
 *  3. attachApiDocument stores the REDACTED text (the plaintext never reaches
 *     the DB), tenant-scoped, and clears the previous reading.
 *  4. readApiDocument: the model gets the redacted text + remarks + filter
 *     words (never a secret), purpose 'integration_doc_read'; a reply without
 *     "complete": true is an error and nothing is stored; gaps are returned;
 *     the draft is whitelisted and a credential the model emits is dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { Prisma } from '@prisma/client';

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
const limits = vi.hoisted(() => ({ docMax: 5 * 1024 * 1024 }));
vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async (key: string) => ({
    'integrations.doc_max_bytes': limits.docMax,
    'integrations.api_max_bytes': 20 * 1024 * 1024,
    'integrations.api_timeout_ms': 60000,
    'integrations.api_max_pages': 50,
    'integrations.max_rows': 50000,
  } as Record<string, number>)[key],
}));
const llm = vi.hoisted(() => ({ calls: [] as any[], reply: '' }));
vi.mock('../src/services/llmRouter', () => ({
  callLLM: async (system: string, user: string, opts: any) => {
    llm.calls.push({ system, user, opts });
    return { text: llm.reply, provider: 'gemini' };
  },
}));
const db = vi.hoisted(() => ({ row: null as any, updates: [] as any[], wheres: [] as any[] }));
vi.mock('../src/db/prisma', () => ({
  __esModule: true,
  default: {
    integrationSync: {
      findFirst: async (a: any) => {
        db.wheres.push(a.where);
        return db.row && a.where.id === db.row.id && a.where.clientNumber === db.row.clientNumber ? db.row : null;
      },
      updateMany: async (a: any) => {
        db.wheres.push(a.where);
        db.updates.push(a);
        const hit = db.row && a.where.id === db.row.id && a.where.clientNumber === db.row.clientNumber;
        if (hit) Object.assign(db.row, a.data);
        return { count: hit ? 1 : 0 };
      },
    },
  },
}));

import {
  attachApiDocument, extractDocText, parseDocReaderAnswer, readApiDocument, redactSecrets, sanitiseDraft,
  DOC_READ_PURPOSE, DocReadError,
} from '../src/services/integrations/sources/docReader';
import { IntegrationInputError, IntegrationNotFoundError } from '../src/services/integrations/types';

const CN = 'TENANT_A';

// ── fixtures, generated here ───────────────────────────────────────────────

function makePdf(text: string): Buffer {
  const esc = text.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 12 Tf 72 720 Td (${esc}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('') + '</w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

beforeEach(() => {
  limits.docMax = 5 * 1024 * 1024;
  llm.calls = [];
  llm.reply = '';
  db.row = null;
  db.updates = [];
  db.wheres = [];
});

// ── 1. extraction ──────────────────────────────────────────────────────────

describe('DEF-362 extractDocText', () => {
  it('reads a PDF through pdf-parse', async () => {
    const t = await extractDocText(makePdf('GET /v1/customers returns data.items'), 'api.pdf', 'application/pdf');
    expect(t).toContain('GET /v1/customers returns data.items');
  });

  it('reads a DOCX through mammoth', async () => {
    const buf = await makeDocx(['Base URL: https://api.acme.test/v2', 'Records are in results']);
    const t = await extractDocText(buf, 'guide.docx', 'application/octet-stream');
    expect(t).toContain('Base URL: https://api.acme.test/v2');
    expect(t).toContain('Records are in results');
  });

  it('a 300k-character text or DOCX is read in full, never cut at the framework 200k', async () => {
    const body = 'x'.repeat(299_000) + ' ENDPOINT_AT_THE_END';
    const t = await extractDocText(Buffer.from(body), 'big.txt', 'text/plain');
    expect(t.length).toBeGreaterThan(299_000);
    expect(t).toContain('ENDPOINT_AT_THE_END');
    const docx = await makeDocx(['a'.repeat(300_000), 'DOCX_ENDPOINT_AT_THE_END']);
    const d = await extractDocText(docx, 'big.docx', 'application/octet-stream');
    expect(d).toContain('DOCX_ENDPOINT_AT_THE_END');
    expect(d).not.toContain('[truncated]');
  });

  it('reads TXT / MD / JSON as UTF-8 and normalises line ends', async () => {
    expect(await extractDocText(Buffer.from('﻿line one\r\nline two\r\n\r\n\r\n\r\nend'), 'a.txt', 'text/plain'))
      .toBe('line one\nline two\n\nend');
    expect(await extractDocText(Buffer.from('# Orders API\nGET /orders'), 'README.md', '')).toContain('GET /orders');
    const spec = JSON.stringify({ openapi: '3.0.0', paths: { '/orders': { get: {} } } });
    expect(await extractDocText(Buffer.from(spec), 'openapi.json', 'application/json')).toContain('"/orders"');
  });

  it('refuses a document over integrations.doc_max_bytes', async () => {
    limits.docMax = 100;
    await expect(extractDocText(Buffer.alloc(101, 'a'), 'a.txt', 'text/plain')).rejects.toBeInstanceOf(IntegrationInputError);
    await expect(extractDocText(Buffer.alloc(100, 'a'), 'a.txt', 'text/plain')).resolves.toBe('a'.repeat(100));
  });

  it('refuses an unknown type, a binary ".txt" and an empty document', async () => {
    await expect(extractDocText(Buffer.from('x'), 'sheet.xlsx', 'application/vnd.ms-excel')).rejects.toThrow(/cannot be read/);
    await expect(extractDocText(Buffer.from([0x41, 0x00, 0x42]), 'a.txt', 'text/plain')).rejects.toThrow(/not plain text/);
    await expect(extractDocText(Buffer.from(' \n\n '), 'a.txt', 'text/plain')).rejects.toThrow(/No text/);
  });

  it('a damaged PDF is an admin-readable input error, not a crash', async () => {
    await expect(extractDocText(Buffer.from('%PDF-1.4 garbage'), 'x.pdf', 'application/pdf')).rejects.toBeInstanceOf(IntegrationInputError);
  });
});

// ── 2. redaction ──────────────────────────────────────────────────────────

describe('DEF-362 redactSecrets', () => {
  const TOKEN = 'a8F3kQ9zL2mN7pR4tV6wX1yB5cD0eG8h';

  it('redacts a Bearer token and keeps the scheme word', () => {
    const r = redactSecrets(`curl -H "Authorization: Bearer ${TOKEN}" https://api.x.test`);
    expect(r.text).not.toContain(TOKEN);
    expect(r.text).toMatch(/Authorization: Bearer \[redacted\]/);
    expect(r.redactions).toBeGreaterThanOrEqual(1);
  });

  it('redacts a bare bearer token in prose and a Basic value', () => {
    const r = redactSecrets(`use bearer ${TOKEN} or Basic dXNlcjpwYXNzd29yZA==`);
    expect(r.text).not.toContain(TOKEN);
    expect(r.text).not.toContain('dXNlcjpwYXNzd29yZA==');
    expect(r.redactions).toBe(2);
  });

  it('redacts api_key=…, "password": "…", client_secret: … values (the NAME stays)', () => {
    const r = redactSecrets('GET /x?api_key=live123abc&format=json\n{"password": "hunter2!x"}\nclient_secret: s3cr3tValue');
    expect(r.text).toContain('api_key=[redacted]&format=json');
    expect(r.text).toContain('"password": "[redacted]"');
    expect(r.text).toContain('client_secret: [redacted]');
    expect(r.text).not.toMatch(/live123abc|hunter2|s3cr3tValue/);
    expect(r.redactions).toBe(3);
  });

  it('redacts JWTs, vendor keys and long high-entropy tokens with no label', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const r = redactSecrets(`token ${jwt}\nkey sk_live_51H8abcdefGHIJKL\nGoogle AIzaSyA1234567890abcdefghijklmnopqrstu\nraw ${TOKEN}`);
    expect(r.text).not.toContain(jwt);
    expect(r.text).not.toContain('sk_live_51H8abcdefGHIJKL');
    expect(r.text).not.toContain('AIzaSyA1234567890abcdefghijklmnopqrstu');
    expect(r.text).not.toContain(TOKEN);
    expect(r.redactions).toBe(4);
  });

  it('keeps placeholders, schema types, UUIDs and ordinary identifiers', () => {
    const text = [
      'Authorization: Bearer <your-token>',
      '"api_key": {"type": "string"}',
      'password: string',
      'example id 3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'GET /v1/customer_relationship_management_records_list',
    ].join('\n');
    const r = redactSecrets(text);
    expect(r.text).toBe(text);
    expect(r.redactions).toBe(0);
  });

  it('a token inside a path segment and a base64 secret containing "/" are still redacted', () => {
    const seg = 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm';
    const b64 = 'q7Rz3Kp9Lm2Xv8Nw4Tb6Yc1Hd5Fg0Js/Ua3Qe7Wr9Ty2Ui4Op6As8Df';
    const r = redactSecrets(`GET /hooks/${seg}/events\nsecret blob ${b64}`);
    expect(r.text).toContain('GET /hooks/[redacted]/events');
    expect(r.text).not.toContain(seg);
    expect(r.text).not.toContain('Ua3Qe7Wr9Ty2Ui4Op6As8Df');
  });

  it('is idempotent: redacting redacted text changes nothing', () => {
    const once = redactSecrets(`Authorization: Bearer ${TOKEN}\napi_key=abc12345`);
    const twice = redactSecrets(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.redactions).toBe(0);
  });
});

// ── 3. attach ─────────────────────────────────────────────────────────────

describe('DEF-362 attachApiDocument', () => {
  it('stores the REDACTED text, tenant-scoped, and clears the previous reading', async () => {
    db.row = { id: 'i1', clientNumber: CN, apiDocReading: { draft: {}, gaps: [], summary: 'old' } };
    const res = await attachApiDocument(CN, 'i1', { text: 'Base https://api.x.test\nAuthorization: Bearer a8F3kQ9zL2mN7pR4tV6wX1yB5cD0eG8h', name: 'notes' });
    expect(res).toMatchObject({ name: 'notes', redactions: 1 });
    const data = db.updates[0].data;
    expect(data.apiDocText).toContain('Bearer [redacted]');
    expect(data.apiDocText).not.toContain('a8F3kQ9zL2mN7pR4tV6wX1yB5cD0eG8h');
    expect(data.apiDocName).toBe('notes');
    expect(data.apiDocReading).toBe(Prisma.DbNull);
    expect(db.wheres.every((w) => w.clientNumber === CN)).toBe(true);
  });

  it('a wrong-tenant id is not found and nothing is written', async () => {
    db.row = { id: 'i1', clientNumber: 'TENANT_B' };
    await expect(attachApiDocument(CN, 'i1', { text: 'hello' })).rejects.toBeInstanceOf(IntegrationNotFoundError);
    expect(db.updates).toHaveLength(0);
  });
});

// ── 4. the AI reading ─────────────────────────────────────────────────────

const answer = (o: Record<string, unknown>) => JSON.stringify(o);

describe('DEF-362 readApiDocument', () => {
  beforeEach(() => {
    db.row = {
      id: 'i1', clientNumber: CN, name: 'CRM', purpose: 'customers', adminBrief: 'Only the customers endpoint',
      filterInstructions: 'only active customers', apiDocName: 'crm.pdf',
      apiDocText: 'GET https://api.crm.test/v1/customers\nAuthorization: Bearer [redacted]\nleftover key=Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm',
    };
  });

  it('calls the model with purpose integration_doc_read, the tenant, the actor, remarks, filters and REDACTED text', async () => {
    llm.reply = answer({ draft: { baseUrl: 'https://api.crm.test/v1', path: '/customers' }, gaps: [], summary: 's', complete: true });
    await readApiDocument(CN, 'i1', 7);
    const c = llm.calls[0];
    expect(c.opts).toMatchObject({ purpose: DOC_READ_PURPOSE, clientNumber: CN, userId: 7 });
    expect(DOC_READ_PURPOSE).toBe('integration_doc_read');
    expect(c.user).toContain('Only the customers endpoint');
    expect(c.user).toContain('only active customers');
    expect(c.user).not.toContain('Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm'); // re-redacted before the prompt
  });

  it('a reply WITHOUT "complete": true is an error and nothing is stored', async () => {
    llm.reply = answer({ draft: { baseUrl: 'https://api.crm.test' }, gaps: [], summary: 's' });
    await expect(readApiDocument(CN, 'i1', 7)).rejects.toBeInstanceOf(DocReadError);
    llm.reply = 'Sorry, I cannot help with that.';
    await expect(readApiDocument(CN, 'i1', 7)).rejects.toBeInstanceOf(DocReadError);
    expect(db.updates).toHaveLength(0);
  });

  it('returns and stores the draft, the gaps and the summary', async () => {
    llm.reply = '```json\n' + answer({
      draft: {
        baseUrl: 'https://api.crm.test/v1/', method: 'get', path: '/customers', authScheme: 'BEARER',
        recordsPath: 'data.items', idField: 'id',
        pagination: { kind: 'page', pageParam: 'page', pageSizeParam: 'per_page', pageSize: 100, startPage: 1 },
        declaredTotalPath: 'meta.total',
      },
      gaps: ['The document does not say how long a token is valid.'],
      summary: 'Lists customers.',
      complete: true,
    }) + '\n```';
    const r = await readApiDocument(CN, 'i1', 7);
    expect(r.draft).toMatchObject({
      baseUrl: 'https://api.crm.test/v1', method: 'GET', path: '/customers', authScheme: 'BEARER',
      recordsPath: 'data.items', idField: 'id', declaredTotalPath: 'meta.total',
      pagination: { kind: 'page', pageParam: 'page', pageSizeParam: 'per_page', pageSize: 100, startPage: 1 },
    });
    expect(r.gaps).toEqual(['The document does not say how long a token is valid.']);
    expect(r.summary).toBe('Lists customers.');
    expect(r.provider).toBe('gemini');
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].where).toEqual({ id: 'i1', clientNumber: CN });
    expect(db.updates[0].data.apiDocReading.gaps).toEqual(r.gaps);
  });

  it('no document attached ⇒ input error, no model call', async () => {
    db.row.apiDocText = null;
    await expect(readApiDocument(CN, 'i1', 7)).rejects.toBeInstanceOf(IntegrationInputError);
    expect(llm.calls).toHaveLength(0);
  });

  it('wrong tenant ⇒ not found, no model call', async () => {
    await expect(readApiDocument('TENANT_B', 'i1', 7)).rejects.toBeInstanceOf(IntegrationNotFoundError);
    expect(llm.calls).toHaveLength(0);
  });
});

describe('DEF-362 sanitiseDraft — the model never stores a secret', () => {
  it('a credential in query becomes "where the key goes" (authQueryParam), never a value', () => {
    const { draft, gaps } = sanitiseDraft({ baseUrl: 'https://api.x.test', query: { key: 'AIzaSyA1234567890abcdefghijklmnopqrstu', format: 'json' } });
    expect(draft.query).toEqual({ format: 'json' });
    expect(draft.authScheme).toBe('API_KEY');
    expect(draft.authQueryParam).toBe('key');
    expect(JSON.stringify(draft)).not.toContain('AIza');
    expect(gaps.join(' ')).toMatch(/URL parameter "key"/);
  });

  it('a credential inside the path\'s query string is dropped the same way', () => {
    const { draft } = sanitiseDraft({ baseUrl: 'https://api.x.test', path: '/scores?api_key=abcdef123456&year=2026' });
    expect(draft.path).toBe('/scores');
    expect(draft.query).toEqual({ year: '2026' });
    expect(JSON.stringify(draft)).not.toContain('abcdef123456');
  });

  it('http base URLs, user:password in the URL, unknown schemes and placeholders are refused', () => {
    expect(sanitiseDraft({ baseUrl: 'http://api.x.test' }).draft.baseUrl).toBeUndefined();
    const withUser = sanitiseDraft({ baseUrl: 'https://u:p@api.x.test/v1' });
    expect(withUser.draft.baseUrl).toBe('https://api.x.test/v1');
    expect(withUser.gaps.join(' ')).toMatch(/user name or password/);
    const oauth = sanitiseDraft({ authScheme: 'OAUTH2' });
    expect(oauth.draft.authScheme).toBeUndefined();
    expect(oauth.gaps[0]).toMatch(/OAUTH2/);
    expect(sanitiseDraft({ authHeaderName: '<header>', idField: 'TBD' }).draft).toEqual({ query: {} });
  });

  it('unknown draft keys (e.g. "secret") are never carried', () => {
    const { draft } = sanitiseDraft({ baseUrl: 'https://api.x.test', secret: 'abc', token: 'xyz' });
    expect(Object.keys(draft).sort()).toEqual(['baseUrl', 'query']);
  });

  it('parseDocReaderAnswer keeps model gaps and adds the draft checks', () => {
    const r = parseDocReaderAnswer(answer({ draft: { baseUrl: 'http://x.test' }, gaps: ['No paging described.'], summary: 'x', complete: true }));
    expect(r.gaps[0]).toBe('No paging described.');
    expect(r.gaps.some((g) => /https/.test(g))).toBe(true);
  });
});
