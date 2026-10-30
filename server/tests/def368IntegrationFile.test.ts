/**
 * DEF-368 — Integrations: an uploaded Excel (.xlsx, .xls) or CSV file as a
 * source — the reader (sources/fileReader.ts + sources/xlsxWorker.ts), the
 * migration, and the import boundary.
 *
 * Rules pinned (each test fails when its rule is removed):
 *  R1 the type comes from the BYTES (PK zip = xlsx, D0CF11E0 = xls, UTF-8 text
 *     = csv), never from the name or mime; NUL bytes, web pages and non-UTF-8
 *     text are refused with what to do.
 *  R2 CSV goes through the Stage 1 parser (same header/blank/cap rules).
 *  R3 a REAL .xlsx (generated here, in the TEST only, with the xlsx lib) is read
 *     in the worker: values as displayed, first non-empty row = headers, blank /
 *     repeated headers made unique and reported; .xls too.
 *  R4 the tab is chosen by name; none ⇒ the first; a missing tab FAILS naming
 *     the tabs — never silently another tab; listTabs lists them.
 *  R5 caps: max_rows ⇒ a TRUNCATED read; an .xlsx declaring > 60 MB unzipped
 *     (or no zip directory) is refused BEFORE the worker; the worker is
 *     terminated at its timeout, and runs under a heap limit (pinned in R8).
 *  R6 readFile reads THIS tenant's stored copy, and only the copy whose sha256
 *     source_config names; testFile answers ONE sample row, ok:false + reason
 *     on a bad file.
 *  R7 the router dispatches 'file' (sourceProblem / readSource / testSource).
 *  R8 import boundary: inside services/integrations only xlsxWorker.ts imports
 *     'xlsx' (the vendored workbook readers stay forbidden — the
 *     def365IntegrationFramework test still pins that, unchanged: no existing
 *     test forbade importing 'xlsx' itself, so this file adds the rule).
 *  R9 the migration widens source_kind to ('gsheet','api','file') and creates
 *     integration_source_files idempotently with ON DELETE CASCADE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import xlsx from 'xlsx';
import { makeFakeDb } from './def354IntegrationFakeDb';

const h = vi.hoisted(() => ({ db: null as any, maxRows: 50000 }));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/db/prisma', () => {
  const p = new Proxy({}, { get: (_t, k) => h.db.prisma[k] });
  return { __esModule: true, default: p, prisma: p };
});
vi.mock('../src/services/behaviorConfig', async (orig) => ({
  ...(await orig<any>()),
  getBehaviorValue: async (key: string) => (key === 'integrations.max_rows' ? h.maxRows : 10 * 1024 * 1024),
}));

import zlib from 'zlib';
import {
  detectFileKind, parseSpreadsheet, listTabs, readFile, testFile, sha256Hex, readFileConfig,
  FILE_MAX_UNZIPPED_BYTES, runXlsxWorker, workerSlots, MAX_CONCURRENT_WORKERS,
} from '../src/services/integrations/sources/fileReader';
import { declaredUnzippedBytes, xlsxInflateBudget } from '../src/services/integrations/sources/zipSize';
import { sourceProblem, readSource, testSource } from '../src/services/integrations/sources';

const A = 'TMC-0001';
const B = 'OTHER-9';
const SLOW = 60_000;

beforeEach(() => {
  h.db = makeFakeDb();
  h.maxRows = 50000;
});

/** A real two-tab workbook, built with the xlsx lib in the TEST only. */
function workbook(bookType: 'xlsx' | 'biff8' = 'xlsx'): Buffer {
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['Note'], ['This tab is a summary']]), 'Summary');
  const data = xlsx.utils.aoa_to_sheet([
    [],
    ['Month', 'Revenue', 'Revenue', ''],
    ['2026-01', 1234.5, 3, 'x'],
    ['2026-02', 99, 4, ''],
  ]);
  data.B3.z = '#,##0.00';
  xlsx.utils.book_append_sheet(wb, data, 'Monthly data');
  return xlsx.write(wb, { type: 'buffer', bookType }) as Buffer;
}

/** A zip whose central directory DECLARES `size` unzipped bytes (no real content). */
function zipDeclaring(size: number): Buffer {
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt32LE(size, 24);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(30, 16);
  return Buffer.concat([local, cen, eocd]);
}

/**
 * DEF-368 review — the local-header bypass: one deflated entry whose DIRECTORY says
 * 100 bytes and whose LOCAL header says `localUsz` (0 ⇒ xlsx grows without bound),
 * holding a highly compressible stream of `inflated` bytes.
 */
function lyingZip(inflated: number, localUsz = 0, eocdCount8 = 1): Buffer {
  const comp = zlib.deflateRawSync(Buffer.alloc(inflated, 0x20), { level: 9 });
  const name = Buffer.from('xl/workbook.xml');
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(8, 8);
  lfh.writeUInt32LE(comp.length, 18); lfh.writeUInt32LE(localUsz, 22); lfh.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(100, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const local = Buffer.concat([lfh, name, comp]);
  const dir = Buffer.concat([cd, name]);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(eocdCount8, 8); e.writeUInt16LE(1, 10);
  e.writeUInt32LE(dir.length, 12); e.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, dir, e]);
}

function plant(cn: string, id: string, bytes: Buffer, sheetName?: string) {
  h.db.tables.integrationSourceFile.push({
    integrationId: id, clientNumber: cn, filename: 'sales.xlsx', mime: 'x', bytes, sizeBytes: bytes.length,
    sha256: sha256Hex(bytes), uploadedBy: 1, uploadedAt: new Date(),
  });
  return { fileName: 'sales.xlsx', sha256: sha256Hex(bytes), ...(sheetName ? { sheetName } : {}) };
}

describe('R1 — the type comes from the bytes', () => {
  it('PK zip = xlsx, OLE = xls, UTF-8 text = csv', () => {
    expect(detectFileKind(workbook())).toBe('xlsx');
    expect(detectFileKind(workbook('biff8'))).toBe('xls');
    expect(detectFileKind(Buffer.from('Month,Revenue\n2026-01,5\n'))).toBe('csv');
    expect(detectFileKind(Buffer.from('﻿Month;Revenue\n'))).toBe('csv');
  });
  it('refuses empty, binary (NUL), web pages / XML and non-UTF-8 text with what to do', () => {
    expect(() => detectFileKind(Buffer.alloc(0))).toThrow(/empty/);
    expect(() => detectFileKind(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]))).toThrow(/not a spreadsheet/);
    expect(() => detectFileKind(Buffer.from('<!DOCTYPE html><table></table>'))).toThrow(/web page or XML/);
    expect(() => detectFileKind(Buffer.from('<?xml version="1.0"?><Workbook/>'))).toThrow(/web page or XML/);
    expect(() => detectFileKind(Buffer.from([0x4d, 0x6f, 0x6e, 0xe9, 0x2c, 0x31, 0x0a]))).toThrow(/CSV UTF-8/);
  });
  it('a CSV named .xlsx is still a CSV, an .xlsx named .csv is still a workbook (name/mime never decide)', async () => {
    // detectFileKind takes no name or mime at all — the bytes are the only input.
    expect(detectFileKind.length).toBe(1);
  });
});

describe('R2 — CSV through the Stage 1 parser', () => {
  it('headers, records, repeated header made unique and reported; no tabs', async () => {
    const p = await parseSpreadsheet(Buffer.from('Month,Revenue,Revenue\n2026-01,5,6\n\n2026-02,7,8\n'));
    expect(p.kind).toBe('csv');
    expect(p.tabs).toEqual([]);
    expect(p.headers).toEqual(['Month', 'Revenue', 'Revenue (2)']);
    expect(p.records).toEqual([{ Month: '2026-01', Revenue: '5', 'Revenue (2)': '6' }, { Month: '2026-02', Revenue: '7', 'Revenue (2)': '8' }]);
    expect(p.anomalies.join(' ')).toMatch(/repeats the header "Revenue"/);
    expect(p.anomalies.join(' ')).toMatch(/1 blank row/);
  });
  it('a tab name on a CSV fails loudly instead of being ignored', async () => {
    await expect(parseSpreadsheet(Buffer.from('a,b\n1,2\n'), { sheetName: 'Data' })).rejects.toThrow(/CSV, which has no tabs/);
  });
  it('max_rows ⇒ truncated, never silent', async () => {
    const p = await parseSpreadsheet(Buffer.from('a\n1\n2\n3\n'), { maxRows: 2 });
    expect(p.rowCount).toBe(2);
    expect(p.truncated).toBe(true);
  });
});

describe('R3/R4 — a real workbook, read in the worker; tabs by name', () => {
  it('lists the tabs', async () => {
    expect(await listTabs(workbook())).toEqual(['Summary', 'Monthly data']);
    expect(await listTabs(Buffer.from('a,b\n'))).toEqual([]);
  }, SLOW);

  it('the chosen tab: values as displayed, header = first non-empty row, blank/repeated headers unique + reported', async () => {
    const p = await parseSpreadsheet(workbook(), { sheetName: 'Monthly data' });
    expect(p.kind).toBe('xlsx');
    expect(p.sheet).toBe('Monthly data');
    expect(p.headers).toEqual(['Month', 'Revenue', 'Revenue (2)', 'Column 4']);
    expect(p.records[0]).toEqual({ Month: '2026-01', Revenue: '1,234.50', 'Revenue (2)': '3', 'Column 4': 'x' });
    expect(p.rowCount).toBe(2);
    const anoms = p.anomalies.join(' ');
    // The empty first row is outside the sheet's range; the header is still found.
    expect(anoms).toMatch(/repeats the header "Revenue"/);
    expect(anoms).toMatch(/no header/);
    // plain strings only crossed the worker boundary
    for (const r of p.records) for (const v of Object.values(r)) expect(typeof v).toBe('string');
  }, SLOW);

  it('no tab chosen ⇒ the first sheet', async () => {
    const p = await parseSpreadsheet(workbook());
    expect(p.sheet).toBe('Summary');
    expect(p.headers).toEqual(['Note']);
  }, SLOW);

  it('a missing tab FAILS naming the tabs — never another tab', async () => {
    await expect(parseSpreadsheet(workbook(), { sheetName: 'Data 2025' }))
      .rejects.toThrow(/The tab "Data 2025" is not in this file\. Its tabs are: "Summary", "Monthly data"/);
  }, SLOW);

  it('a legacy .xls is read the same way', async () => {
    const p = await parseSpreadsheet(workbook('biff8'), { sheetName: 'Monthly data' });
    expect(p.kind).toBe('xls');
    expect(p.headers.slice(0, 2)).toEqual(['Month', 'Revenue']);
    expect(p.records[1]!.Month).toBe('2026-02');
  }, SLOW);

  it('max_rows on a workbook ⇒ truncated', async () => {
    const p = await parseSpreadsheet(workbook(), { sheetName: 'Monthly data', maxRows: 1 });
    expect(p.rowCount).toBe(1);
    expect(p.truncated).toBe(true);
  }, SLOW);
});

describe('R5 — size, timeout and memory refusals', () => {
  it('an .xlsx declaring more than 60 MB unzipped is refused before the worker', async () => {
    const bomb = zipDeclaring(FILE_MAX_UNZIPPED_BYTES + 1);
    expect(detectFileKind(bomb)).toBe('xlsx');
    await expect(parseSpreadsheet(bomb)).rejects.toThrow(/unpacks to \d+ MB, over the 60 MB limit/);
    await expect(listTabs(bomb)).rejects.toThrow(/over the 60 MB limit/);
  });
  it('a directory that lies (CD 100 B, local 0, ~70 MB of deflate) is refused BEFORE the worker starts', async () => {
    const bomb = lyingZip(FILE_MAX_UNZIPPED_BYTES + 10 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(10 * 1024 * 1024);
    expect(declaredUnzippedBytes(bomb)).toBe(100); // the old guard alone passed it
    expect((await xlsxInflateBudget(bomb, FILE_MAX_UNZIPPED_BYTES)).ok).toBe(false);
    const before = workerSlots().running;
    const p1 = parseSpreadsheet(bomb);
    const p2 = listTabs(bomb);
    expect(workerSlots().running).toBe(before);
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect(r1.status === 'rejected' && String(r1.reason.message)).toMatch(/unpacks to more than 60 MB, over the 60 MB limit/);
    expect(r2.status === 'rejected' && String(r2.reason.message)).toMatch(/over the 60 MB limit/);
    expect(workerSlots().running).toBe(before);
  }, SLOW);
  it('a local header declaring a huge size (allocUnsafe path) is refused too', async () => {
    const r = await xlsxInflateBudget(lyingZip(1000, 0xfffffff0), FILE_MAX_UNZIPPED_BYTES);
    expect(r).toMatchObject({ ok: false, reason: 'too_large' });
  });
  it('the entry count xlsx walks (EOCD+8) is honoured even when +10 says fewer', async () => {
    const r = await xlsxInflateBudget(lyingZip(1000, 0, 3), FILE_MAX_UNZIPPED_BYTES);
    expect(r.ok).toBe(false); // the 2 extra entries walk off the directory ⇒ unreadable
  });
  it('a real workbook passes the inflate budget with its true size', async () => {
    const r = await xlsxInflateBudget(workbook(), FILE_MAX_UNZIPPED_BYTES);
    expect(r.ok).toBe(true);
    expect(r.total).toBeGreaterThan(0);
  });
  it('encryption and unknown compression methods are refused as unreadable', async () => {
    const enc = lyingZip(1000); enc.writeUInt16LE(1, 6);
    expect(await xlsxInflateBudget(enc, FILE_MAX_UNZIPPED_BYTES)).toMatchObject({ ok: false, reason: 'unreadable' });
    const meth = lyingZip(1000); meth.writeUInt16LE(12, 8);
    expect(await xlsxInflateBudget(meth, FILE_MAX_UNZIPPED_BYTES)).toMatchObject({ ok: false, reason: 'unreadable' });
  });
  it(`never more than ${MAX_CONCURRENT_WORKERS} workers at once — a freed slot goes straight to a waiter`, async () => {
    const wb = new Uint8Array(workbook());
    let peak = 0;
    const iv = setInterval(() => { peak = Math.max(peak, workerSlots().running); }, 1);
    const jobs = Array.from({ length: 5 }, () => runXlsxWorker({ bytes: wb, mode: 'tabs', sheetName: null, rowLimit: 1, colLimit: 1 })
      .then((o) => { peak = Math.max(peak, workerSlots().running); return o; }));
    await Promise.all(jobs);
    clearInterval(iv);
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_WORKERS);
    expect(workerSlots()).toEqual({ running: 0, waiting: 0 });
  }, SLOW);
  it('a zip without a readable directory is refused', async () => {
    await expect(parseSpreadsheet(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40, 7)])))
      .rejects.toThrow(/not a complete Excel workbook/);
  });
  it('the worker is stopped at its timeout', async () => {
    await expect(parseSpreadsheet(workbook(), { timeoutMs: 5 })).rejects.toThrow(/took longer than .* to open and was stopped/);
  }, SLOW);
  // The heap limit itself (resourceLimits) is pinned at source level in R8: V8 will not run
  // a worker small enough to exhaust on a test-sized workbook, so no runtime case here.
});

describe('R6 — readFile / testFile read this tenant\'s stored copy', () => {
  it('reads the copy source_config names; ONE sample row in the test', async () => {
    const cfg = plant(A, 'i1', Buffer.from('Month,Revenue\n2026-01,5\n2026-02,7\n'));
    const r = await readFile(A, { id: 'i1', sourceConfig: cfg });
    expect(r.rowCount).toBe(2);
    expect(r.sourceLabel).toBe('sales.xlsx');
    const t = await testFile(A, { id: 'i1', sourceConfig: cfg });
    expect(t).toEqual({ ok: true, rows: 2, columns: ['Month', 'Revenue'], sampleRow: { Month: '2026-01', Revenue: '5' } });
    const where = h.db.calls.find((c: any) => c.model === 'integrationSourceFile').args.where;
    expect(where).toEqual({ integrationId: 'i1', clientNumber: A });
  });
  it('another tenant\'s copy is never read', async () => {
    const cfg = plant(A, 'i1', Buffer.from('a\n1\n'));
    await expect(readFile(B, { id: 'i1', sourceConfig: cfg })).rejects.toThrow(/No file is stored/);
    expect((await testFile(B, { id: 'i1', sourceConfig: cfg })).ok).toBe(false);
  });
  it('a stored copy that is not the one named (sha256) is refused', async () => {
    const cfg = plant(A, 'i1', Buffer.from('a\n1\n'));
    await expect(readFile(A, { id: 'i1', sourceConfig: { ...cfg, sha256: 'f'.repeat(64) } })).rejects.toThrow(/not the one this connection names/);
  });
  it('the test is not ok on a header-only file, with the reason', async () => {
    const cfg = plant(A, 'i1', Buffer.from('Month,Revenue\n'));
    const t = await testFile(A, { id: 'i1', sourceConfig: cfg });
    expect(t.ok).toBe(false);
    expect(t.reason).toMatch(/no data rows/);
  });
  it('the workbook tab in source_config is read, and a missing one fails the test with the tabs', async () => {
    const cfg = plant(A, 'i1', workbook(), 'Monthly data');
    const r = await readFile(A, { id: 'i1', sourceConfig: cfg });
    expect(r.sourceLabel).toBe('sales.xlsx › Monthly data');
    const bad = await testFile(A, { id: 'i1', sourceConfig: { ...cfg, sheetName: 'Gone' } });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/"Gone" is not in this file.*"Summary", "Monthly data"/);
  }, SLOW);
  it('readFileConfig accepts only {fileName, sha256 hex, sheetName?}', () => {
    expect(readFileConfig({ fileName: 'a.csv', sha256: 'a'.repeat(64) })).toEqual({ fileName: 'a.csv', sha256: 'a'.repeat(64) });
    expect(readFileConfig({ fileName: 'a.csv', sha256: 'nothex' })).toBeNull();
    expect(readFileConfig({ sheetId: 'x', gid: '0' })).toBeNull();
  });
});

describe('R7 — the source router dispatches file', () => {
  it('sourceProblem names the file when none is uploaded', () => {
    expect(sourceProblem({ id: 'i1', sourceKind: 'file', sourceConfig: {} })).toEqual({ message: expect.stringMatching(/Upload the spreadsheet/), field: 'file' });
    expect(sourceProblem({ id: 'i1', sourceKind: 'file', sourceConfig: { fileName: 'a.csv', sha256: 'a'.repeat(64) } })).toBeNull();
  });
  it('readSource / testSource read the stored copy', async () => {
    const cfg = plant(A, 'i1', Buffer.from('k,v\nx,1\n'));
    const row = { id: 'i1', sourceKind: 'file', sourceConfig: cfg };
    expect((await readSource(A, row)).records).toEqual([{ k: 'x', v: '1' }]);
    expect((await testSource(A, row)).sampleRow).toEqual({ k: 'x', v: '1' });
    await expect(readSource(A, { id: 'i1', sourceKind: 'file', sourceConfig: {} })).rejects.toThrow(/Upload the spreadsheet/);
  });
});

describe('R8 — import boundary', () => {
  const ROOT = path.resolve(__dirname, '../src/services/integrations');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.ts$/.test(e.name) ? [p] : [];
  });
  it("only sources/xlsxWorker.ts imports 'xlsx' in services/integrations", () => {
    const users = files(ROOT).filter((f) => /(?:from\s+'xlsx'|require\(\s*'xlsx'\s*\)|import\(\s*'xlsx'\s*\))/.test(fs.readFileSync(f, 'utf8')));
    expect(users.map((f) => path.relative(ROOT, f))).toEqual([path.join('sources', 'xlsxWorker.ts')]);
  });
  it('fileReader opens workbooks only through a worker_thread with limits and a timeout', () => {
    const src = fs.readFileSync(path.join(ROOT, 'sources/fileReader.ts'), 'utf8');
    expect(src).toMatch(/new Worker\(/);
    expect(src).toMatch(/resourceLimits: \{ maxOldGenerationSizeMb/);
    expect(src).toMatch(/worker\.terminate\(\)/);
    expect(src).not.toMatch(/vendor\/ai-integration/);
    const worker = fs.readFileSync(path.join(ROOT, 'sources/xlsxWorker.ts'), 'utf8');
    expect(worker).toMatch(/cellFormula: false, cellHTML: false, cellStyles: false, sheetStubs: false/);
    expect(worker).toMatch(/raw: false, defval: '', header: 1/);
  });
  it('engine/** does not import the file reader or xlsx directly (it reads through the router)', () => {
    for (const f of files(path.join(ROOT, 'engine'))) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/fileReader|xlsxWorker|from 'xlsx'/);
    }
  });
});

describe('R9 — migration and model', () => {
  const ROOT = path.resolve(__dirname, '..');
  const sql = fs.readFileSync(path.join(ROOT, 'prisma/migrations/20261031_integrations_file_source/migration.sql'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
  it('widens source_kind with every other enum kept', () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS integration_syncs_enums_check;/);
    expect(sql).toMatch(/source_kind IN \('gsheet','api','file'\)/);
    expect(sql).toMatch(/status IN \('DRAFT','ACTIVE','PAUSED'\)/);
    expect(sql).toMatch(/last_run_status IN \('RUNNING','SUCCESS','PARTIAL','FAILED','ABORTED'\)/);
  });
  it('creates integration_source_files idempotently, keyed by integration, cascading on delete', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS integration_source_files/);
    expect(sql).toMatch(/integration_id TEXT\s+PRIMARY KEY/);
    expect(sql).toMatch(/client_number\s+VARCHAR\(20\)\s+NOT NULL/);
    expect(sql).toMatch(/bytes\s+BYTEA\s+NOT NULL/);
    expect(sql).toMatch(/REFERENCES integration_syncs\(id\) ON DELETE CASCADE/);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?(TABLE|INDEX) (?!IF NOT EXISTS)/);
    const adds = sql.match(/ADD CONSTRAINT/g) ?? [];
    const guards = sql.match(/EXCEPTION WHEN duplicate_object THEN NULL; END;?/g) ?? [];
    expect(guards.length).toBe(adds.length);
  });
  it('the Prisma model matches and is tenant-scoped', async () => {
    expect(schema).toMatch(/model IntegrationSourceFile \{[\s\S]*?@@map\("integration_source_files"\)/);
    expect(schema).toMatch(/integration IntegrationSync @relation\(fields: \[integrationId\], references: \[id\], onDelete: Cascade\)/);
    const { TENANT_SCOPED_MODELS } = await vi.importActual<any>('../src/db/prisma');
    expect(TENANT_SCOPED_MODELS.has('IntegrationSourceFile')).toBe(true);
  });
});

describe('R10 — the client offers the file source the vm way', () => {
  const DIR = path.resolve(__dirname, '../../client/src/pages/admin/integrations');
  const basics = fs.readFileSync(path.join(DIR, 'StepBasics.jsx'), 'utf8');
  const connect = fs.readFileSync(path.join(DIR, 'StepConnect.jsx'), 'utf8');
  const api = fs.readFileSync(path.resolve(__dirname, '../../client/src/services/integrationsApi.js'), 'utf8');
  it('Basics: Google Sheet · API (with its document) · Excel or CSV file', () => {
    expect(basics).toContain("kind: 'gsheet', label: 'Google Sheet'");
    expect(basics).toContain("kind: 'api', label: 'API (with its document)'");
    expect(basics).toContain("kind: 'file', label: 'Excel or CSV file'");
  });
  it('Connect: choosing a file uploads it at once; size, tab picker, newer version, same test and Suggest gate', () => {
    expect(connect).toMatch(/onChange=\{\(e\) => \{ const f = e\.target\.files\?\.\[0\] \?\? null; e\.target\.value = ''; if \(f\) onChoose\(f\); \}\}/);
    expect(connect).toContain('const res = await uploadSourceFile(integ.id, chosen);');
    expect(connect).toContain('Upload the spreadsheet — .xlsx, .xls or .csv, up to 10 MB; every run reads this copy until you upload a newer one.');
    expect(connect).toContain('Upload a newer version');
    expect(connect).toContain('Which tab holds the data?');
    // A tab kept from an older upload that the new file lacks: the picker shows even for a
    // one-tab file, so "The first tab" can clear it (else the admin is stuck failing tests).
    expect(connect).toContain('{sourceFile && (list.length > 1 || missing) && (');
    expect(connect).toContain("? { sheetName: sheetName || null }");
    expect(connect).toMatch(/disabled=\{!tested \|\| busy\} onClick=\{suggest\}/);
    expect(api).toContain("export const FILE_ACCEPT = '.xlsx,.xls,.csv';");
    expect(api).toMatch(/source-file`, form, \{\s*headers: \{ 'Content-Type': 'multipart\/form-data' \}/);
  });
});
