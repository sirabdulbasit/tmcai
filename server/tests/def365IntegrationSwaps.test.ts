/**
 * DEF-365 — Nexeo's up-to-mapping code now runs THROUGH the vendored
 * @tmc/ai-integration framework, composed so that no Nexeo guarantee is weaker.
 *
 * Pinned, per swap:
 *  - sheetLink: the framework recogniser is consulted on every parse and can
 *    only refuse more; Nexeo's stricter rules (publish-to-web, two tabs) still
 *    decide; gsheetReader's nameFromDisposition IS the framework function;
 *  - fieldInventory: fill counts come from the framework's discoverSourceFields
 *    (spied), sheet order and majority typing stay Nexeo's;
 *  - docReader: DOCX and text are extracted by the framework's extractFile with
 *    a mime type NEXEO chose (a ".docx" labelled as Excel never reaches the
 *    xlsx branch); PDF, a zip bomb and a NUL file never reach the framework;
 *    the 2M-character refusal still happens;
 *  - guardedFetch: the framework URL rule runs first on every hop (credentials
 *    in the URL, metadata and encoded loopback hosts refused before any DNS).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';

const spy = vi.hoisted(() => ({
  extract: [] as Array<{ filename: string; mimetype?: string }>,
  discover: 0,
  parse: 0,
  parseOverride: null as null | ((t: string) => unknown),
}));

vi.mock('../src/vendor/ai-integration/sources/fileExtractor', async () => {
  const real: any = await vi.importActual('../src/vendor/ai-integration/sources/fileExtractor');
  return { ...real, extractFile: (i: any) => { spy.extract.push({ filename: i.filename, mimetype: i.mimetype }); return real.extractFile(i); } };
});
vi.mock('../src/vendor/ai-integration/mapping/fieldInventory', async () => {
  const real: any = await vi.importActual('../src/vendor/ai-integration/mapping/fieldInventory');
  return { ...real, discoverSourceFields: (r: any) => { spy.discover += 1; return real.discoverSourceFields(r); } };
});
vi.mock('../src/vendor/ai-integration/sources/sheetLink', async () => {
  const real: any = await vi.importActual('../src/vendor/ai-integration/sources/sheetLink');
  return { ...real, parseSheetLink: (t: string) => { spy.parse += 1; return spy.parseOverride ? spy.parseOverride(t) : real.parseSheetLink(t); } };
});
vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/services/behaviorConfig', () => ({ getBehaviorValue: async () => 5 * 1024 * 1024 }));
vi.mock('../src/services/llmRouter', () => ({ callLLM: async () => ({ text: '', provider: 'gemini' }) }));
vi.mock('../src/db/prisma', () => ({ __esModule: true, default: {}, prisma: {} }));
vi.mock('../src/db/tenantContext', () => ({ runInTenantScope: (_c: unknown, fn: () => unknown) => fn() }));
vi.mock('pdf-parse', () => ({
  PDFParse: class { async getText() { return { text: 'GET /v1/items returns items.' }; } async destroy() {} },
}));

import { parseSheetLink } from '../src/services/integrations/sources/sheetLink';
import { nameFromDisposition } from '../src/services/integrations/sources/gsheetReader';
import { nameFromDisposition as fwNameFromDisposition } from '../src/vendor/ai-integration/sources/sheetLink';
import { buildFieldCoverage } from '../src/services/integrations/mapping/fieldInventory';
import { DOC_MAX_TEXT_CHARS, extractDocText } from '../src/services/integrations/sources/docReader';
import { assertFrameworkSafe, guardedFetch } from '../src/services/integrations/sources/integrationFetch';
import { FetchGuardError, IntegrationInputError } from '../src/services/integrations/types';

const ID = '1JrYos_Evg0U3wCXEg4C_2VAKh6PmZbg-SANXX2o06mM';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function docx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

beforeEach(() => { spy.extract = []; spy.discover = 0; spy.parse = 0; spy.parseOverride = null; });

describe('DEF-365 sheet link: framework recogniser composed, Nexeo rules kept', () => {
  it('a normal link parses as before, and the framework was consulted', () => {
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=42`)).toEqual({
      sheetId: ID, gid: '42', link: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=42`,
    });
    expect(spy.parse).toBe(1);
  });
  it('the framework disagreeing about the id refuses the link — it can only refuse more', () => {
    spy.parseOverride = () => ({ url: 'x', id: 'another-sheet-id-000000000', published: false, gid: null });
    expect(() => parseSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/edit`)).toThrow(IntegrationInputError);
    spy.parseOverride = () => null;
    expect(() => parseSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/edit`)).toThrow(/could not be read reliably/);
  });
  it('Nexeo still refuses what the framework would accept', () => {
    // The framework reads published links and takes the first gid; Nexeo refuses both.
    expect(() => parseSheetLink('https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pubhtml')).toThrow(/Publish to web/);
    expect(() => parseSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=1#gid=2`)).toThrow(/two different tabs/);
    expect(() => parseSheetLink(`see https://docs.google.com/spreadsheets/d/${ID}/edit`)).toThrow();
  });
  it('gsheetReader.nameFromDisposition is the framework function', () => {
    expect(nameFromDisposition).toBe(fwNameFromDisposition);
    expect(nameFromDisposition("attachment; filename*=UTF-8''Sales%20Q1.csv")).toBe('Sales Q1.csv');
  });
});

describe('DEF-365 field inventory: framework counts, Nexeo order and typing', () => {
  it('uses discoverSourceFields; keeps sheet order and majority types', () => {
    const records = [
      { Zeta: '1', Alpha: '' }, { Zeta: '2', Alpha: 'x' }, { Zeta: '3', Alpha: '' }, { Zeta: '4', Alpha: '' }, { Zeta: 'n/a', Alpha: '' },
    ];
    const cov = buildFieldCoverage(records, ['Zeta', 'Alpha']);
    expect(spy.discover).toBe(1);
    expect(cov.map((c) => c.field)).toEqual(['Zeta', 'Alpha']); // the framework sorts most-filled first; Nexeo keeps the sheet's order
    expect(cov[0]).toMatchObject({ filled: 5, total: 5, inferredType: 'number' }); // 4 of 5 numeric = majority
    expect(cov[1]).toMatchObject({ filled: 1, inferredType: 'text', distinct: ['x'] });
  });
});

describe('DEF-365 document text: framework extractor behind Nexeo\'s caps', () => {
  it('DOCX goes through the framework with NEXEO\'s mime type, whatever the upload claims', async () => {
    const t = await extractDocText(await docx('GET /v1/customers'), 'api.docx', 'application/vnd.ms-excel');
    expect(t).toContain('GET /v1/customers');
    expect(spy.extract).toEqual([{ filename: 'document.docx', mimetype: DOCX_MIME }]);
  });
  it('text goes through the framework as text/plain; Nexeo normalisation still applies', async () => {
    expect(await extractDocText(Buffer.from('line one\r\n\r\n\r\n\r\nend'), 'spec.json', 'application/json')).toBe('line one\n\nend');
    expect(spy.extract).toEqual([{ filename: 'document.txt', mimetype: 'text/plain' }]);
  });
  it('an empty text is Nexeo\'s "No text was found", not the framework\'s wording', async () => {
    await expect(extractDocText(Buffer.from('   \n  '), 'a.txt', 'text/plain')).rejects.toThrow(/No text was found/);
  });
  it('PDF, a zip bomb, a NUL file and an over-long text never reach the framework', async () => {
    await extractDocText(Buffer.from('%PDF-1.4 stub'), 'api.pdf', 'application/pdf');
    const bomb = Buffer.from(await docx('x'));
    for (let i = 0; i + 4 <= bomb.length; i++) if (bomb.readUInt32LE(i) === 0x02014b50) bomb.writeUInt32LE(0x7fffffff, i + 24);
    await expect(extractDocText(bomb, 'api.docx', '')).rejects.toBeInstanceOf(IntegrationInputError);
    await expect(extractDocText(Buffer.from([0x41, 0, 0x42]), 'a.txt', 'text/plain')).rejects.toThrow(/not plain text/);
    const big = Buffer.from('ab '.repeat(Math.ceil((DOC_MAX_TEXT_CHARS + 10) / 3)), 'utf8');
    await expect(extractDocText(big, 'a.txt', 'text/plain')).rejects.toThrow(/characters/);
    expect(spy.extract).toEqual([]);
  });
  it('a spreadsheet is still refused by Nexeo before any extractor runs', async () => {
    await expect(extractDocText(Buffer.from('x'), 'sheet.xlsx', 'application/vnd.ms-excel')).rejects.toThrow(/cannot be read/);
    expect(spy.extract).toEqual([]);
  });
});

describe('DEF-365 fetch guard: the framework URL rule runs first', () => {
  it('refuses credentials in the URL, metadata and encoded loopback/link-local hosts', () => {
    for (const u of ['https://user:pw@api.example.com/x', 'https://metadata.google.internal/x', 'https://0x7f000001/x', 'https://2852039166/x', 'https://localhost/x']) {
      expect(() => assertFrameworkSafe(new URL(u)), u).toThrow(FetchGuardError);
    }
    expect(() => assertFrameworkSafe(new URL('https://api.example.com/v1?key=secret'))).not.toThrow();
  });
  it('the refusal never echoes the query (a key may ride there)', () => {
    try { assertFrameworkSafe(new URL('https://user:pw@api.example.com/x?api_key=SECRET')); } catch (e) {
      expect((e as Error).message).not.toMatch(/SECRET|pw/);
      expect((e as FetchGuardError).kind).toBe('address');
    }
  });
  it('guardedFetch stops at the framework rule before any DNS lookup', async () => {
    await expect(guardedFetch('https://user:pw@api.example.com/x', {
      origin: 'https://api.example.com', timeoutMs: 1000, maxBytes: 1000,
    } as any)).rejects.toMatchObject({ kind: 'address' });
  });
});
