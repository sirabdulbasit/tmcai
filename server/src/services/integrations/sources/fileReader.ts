/**
 * DEF-368 — Integrations: read an uploaded Excel (.xlsx, .xls) or CSV file.
 *
 * Owner 2026-10-31: "there should be integration source that can be
 * Googlesheet / API documentation file / Excel file with data". vm §7: "A
 * spreadsheet attached in the document box is uploaded and kept; every run
 * reads the stored copy, so a newer version is uploaded the same way."
 *
 *  - The file's TYPE comes from its bytes, never from the browser's mime or
 *    the name alone: a zip (PK\x03\x04) is an .xlsx workbook, the OLE header
 *    (D0 CF 11 E0 A1 B1 1A E1) is a legacy .xls, anything else must be UTF-8
 *    text and is read as CSV. A NUL byte, a web page or non-UTF-8 text is
 *    refused with what to do instead.
 *  - CSV goes through the Stage 1 parser (csv.ts) — the same header, blank-row
 *    and cap rules as a Google Sheet.
 *  - A workbook is opened ONLY inside xlsxWorker.ts, in a worker_thread with a
 *    heap limit (WORKER_HEAP_MB) and a hard timeout (WORKER_TIMEOUT_MS) after
 *    which it is terminated — xlsx@0.18.5 has published CVEs and must never
 *    parse an untrusted file in the server's own isolate. At most
 *    MAX_CONCURRENT_WORKERS run at once (the box is shared). Before an .xlsx
 *    reaches the worker its zip directory's declared unzipped size is summed
 *    (docReader.declaredUnzippedBytes, the DEF-362 bomb guard) AND every entry
 *    is inflated natively with a bounded output, walking the local headers the
 *    way xlsx does (zipSize.xlsxInflateBudget — the directory can lie, and the
 *    buffers xlsx inflates sit outside the worker's heap limit); refused over
 *    FILE_MAX_UNZIPPED_BYTES. The worker hands back string rows only.
 *  - The rows become records through csv.ts rowsToRecords: the first non-empty
 *    row is the header; blank / repeated headers are made unique and reported.
 *    Caps: integrations.max_rows (a TRUNCATED read, never a silent one) and the
 *    upload's integrations.file_max_bytes (checked at upload).
 *  - The tab is chosen by NAME (source_config.sheetName); none ⇒ the first
 *    sheet. A named tab the file does not have FAILS, naming the tabs it has —
 *    a read never silently switches to another tab.
 *  - readFile reads the STORED copy (integration_source_files) of this tenant
 *    and checks its sha256 against source_config.sha256 — the copy the
 *    connection test passed on is the one a run reads.
 *
 * No model is called here; the run engine reaches this module only through
 * the source router (sources/index.ts).
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { getBehaviorValue } from '../../behaviorConfig';
import { csvToRecords, rowsToRecords } from './csv';
import { declaredUnzippedBytes, xlsxInflateBudget } from './zipSize';
import type { FileSourceConfig, ReadResult, TestResult } from '../types';
import type { XlsxWorkerInput, XlsxWorkerOutput } from './xlsxWorker';

const log = createLogger('integrations-file');

export const WORKER_TIMEOUT_MS = 20_000;
export const WORKER_HEAP_MB = 256;
export const FILE_MAX_UNZIPPED_BYTES = 60 * 1024 * 1024;
export const MAX_CONCURRENT_WORKERS = 2;
/** Columns read at most; more are reported, never silently dropped. */
export const FILE_MAX_COLUMNS = 1000;
/** Rows above the header that may be blank, beyond max_rows (sheetRows slack). */
const HEADER_SLACK_ROWS = 50;
const DEFAULT_MAX_ROWS = 50_000;

/** A file that cannot be read, in words the admin can act on. `code` is the
 *  shared INTEGRATION_INPUT (a 400 in the routes; shown as-is by the run
 *  engine and the proposal job). */
export class FileReadError extends Error {
  readonly code = 'INTEGRATION_INPUT';
  readonly field = 'file';
  constructor(message: string) {
    super(message);
    this.name = 'FileReadError';
  }
}

export type FileKind = 'xlsx' | 'xls' | 'csv';

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** What the bytes are. Throws FileReadError for anything that is not a spreadsheet. */
export function detectFileKind(buf: Buffer): FileKind {
  if (!buf || buf.length === 0) throw new FileReadError('The file is empty.');
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'xlsx';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(OLE_MAGIC)) return 'xls';
  if (buf.subarray(0, 8192).includes(0)) {
    throw new FileReadError('This file is not a spreadsheet Nexeo can read. Upload an Excel workbook (.xlsx or .xls) or a CSV file.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.min(buf.length, 65536)));
  } catch {
    // A cut in the middle of a multi-byte character at the 64 KB edge is not an error.
    if (!isUtf8AllowingCutTail(buf.subarray(0, Math.min(buf.length, 65536)))) {
      throw new FileReadError('This CSV is not saved as UTF-8 text. In Excel use File → Save As → "CSV UTF-8 (Comma delimited)", or upload the .xlsx itself.');
    }
    text = '';
  }
  if (/^\s*<(?:!doctype|html|\?xml)/i.test(text.replace(/^﻿/, '').slice(0, 512))) {
    throw new FileReadError('This file is a web page or XML document, not a spreadsheet. Save it as .xlsx or CSV and upload that.');
  }
  return 'csv';
}

function isUtf8AllowingCutTail(b: Buffer): boolean {
  for (let cut = 0; cut <= 3 && cut < b.length; cut++) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, b.length - cut)); return true; } catch { /* try a shorter tail */ }
  }
  return false;
}

// ── The worker ────────────────────────────────────────────────────────────

let running = 0;
const waiting: Array<() => void> = [];
/** A freed slot is handed straight to the next waiter (running is not
 *  decremented), so no other caller can slip in between — never more than
 *  MAX_CONCURRENT_WORKERS at once. */
async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT_WORKERS) { running++; return; }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}
/** For tests: workers holding a slot, and callers waiting for one. */
export function workerSlots(): { running: number; waiting: number } {
  return { running, waiting: waiting.length };
}

/** The compiled worker in dist; from source (tests) the .ts through ts-node. */
function workerEntry(): { file: string; evalCode: boolean } {
  const js = path.join(__dirname, 'xlsxWorker.js');
  if (fs.existsSync(js)) return { file: js, evalCode: false };
  const ts = path.join(__dirname, 'xlsxWorker.ts');
  return {
    file: `require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } }); require(${JSON.stringify(ts)});`,
    evalCode: true,
  };
}

export interface WorkerOptions {
  timeoutMs?: number;
  heapMb?: number;
}

/** Runs xlsxWorker once; resolves with its plain output, or throws FileReadError. */
export async function runXlsxWorker(input: XlsxWorkerInput, opts: WorkerOptions = {}): Promise<XlsxWorkerOutput> {
  const timeoutMs = opts.timeoutMs ?? WORKER_TIMEOUT_MS;
  await acquire();
  try {
    return await new Promise<XlsxWorkerOutput>((resolve, reject) => {
      const entry = workerEntry();
      const worker = new Worker(entry.file, {
        eval: entry.evalCode,
        workerData: input,
        resourceLimits: { maxOldGenerationSizeMb: opts.heapMb ?? WORKER_HEAP_MB, maxYoungGenerationSizeMb: 32 },
      });
      let settled = false;
      const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
      const timer = setTimeout(() => {
        done(() => reject(new FileReadError(`The spreadsheet took longer than ${Math.round(timeoutMs / 1000)} s to open and was stopped. Save a smaller copy (only the tab with the data) and upload that.`)));
        void worker.terminate();
      }, timeoutMs);
      worker.once('message', (msg: XlsxWorkerOutput) => {
        done(() => resolve(msg));
        void worker.terminate();
      });
      worker.once('error', (err: Error & { code?: string }) => {
        done(() => reject(err?.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? new FileReadError('The spreadsheet is too large to open within the memory limit. Save a smaller copy (only the tab with the data) and upload that.')
          : new FileReadError('The spreadsheet could not be opened. Open it in Excel, save it again as .xlsx, and upload that.')));
        log.warn('xlsx worker failed', { code: err?.code, error: err?.message?.slice(0, 300) });
      });
      worker.once('exit', (code) => {
        done(() => reject(new FileReadError(code === 0
          ? 'The spreadsheet could not be opened.'
          : 'The spreadsheet could not be opened (the reader stopped). Save it again as .xlsx and upload that.')));
      });
    });
  } finally {
    release();
  }
}

async function assertZipSize(buf: Buffer): Promise<void> {
  const declared = declaredUnzippedBytes(buf);
  const notWorkbook = () => new FileReadError('This .xlsx file cannot be opened — it is not a complete Excel workbook. Open it in Excel, save it again, and upload that.');
  const tooLarge = (bytes: number | null) => new FileReadError(`This workbook unpacks to ${bytes === null ? 'more than ' + Math.round(FILE_MAX_UNZIPPED_BYTES / (1024 * 1024)) : Math.round(bytes / (1024 * 1024))} MB, over the ${Math.round(FILE_MAX_UNZIPPED_BYTES / (1024 * 1024))} MB limit. Save a copy with only the tab that holds the data and upload that.`);
  if (declared === null) throw notWorkbook();
  if (declared > FILE_MAX_UNZIPPED_BYTES) throw tooLarge(declared);
  // The directory can lie: xlsx inflates by the LOCAL headers. Measure what it
  // will really allocate (bounded native inflate) before the worker starts.
  const real = await xlsxInflateBudget(buf, FILE_MAX_UNZIPPED_BYTES);
  if (!real.ok) {
    if (real.reason === 'too_large') throw tooLarge(null);
    throw notWorkbook();
  }
}

const unreadable = (kind: FileKind): FileReadError => new FileReadError(kind === 'xls'
  ? 'This .xls file could not be opened. Open it in Excel, save it as .xlsx, and upload that.'
  : 'This workbook could not be opened. Open it in Excel, save it again as .xlsx, and upload that.');

// ── Public reading functions ──────────────────────────────────────────────

/** The tab names of a workbook ([] for a CSV, which has none). */
export async function listTabs(buf: Buffer, opts: WorkerOptions = {}): Promise<string[]> {
  const kind = detectFileKind(buf);
  if (kind === 'csv') return [];
  if (kind === 'xlsx') await assertZipSize(buf);
  const out = await runXlsxWorker({ bytes: new Uint8Array(buf), mode: 'tabs', sheetName: null, rowLimit: 1, colLimit: 1 }, opts);
  if (!out.ok) throw unreadable(kind);
  if (out.tabs.length === 0) throw new FileReadError('The workbook has no sheets.');
  return out.tabs;
}

export interface ParsedFile {
  kind: FileKind;
  /** Workbook tabs ([] for a CSV). */
  tabs: string[];
  /** The tab that was read (null for a CSV). */
  sheet: string | null;
  records: Record<string, string>[];
  headers: string[];
  rowCount: number;
  truncated: boolean;
  truncatedReason?: string;
  anomalies: string[];
}

/** Bytes ⇒ records. Pure apart from the worker; exported for tests. */
export async function parseSpreadsheet(
  buf: Buffer,
  o: { sheetName?: string | null; maxRows?: number } & WorkerOptions = {},
): Promise<ParsedFile> {
  const kind = detectFileKind(buf);
  const maxRows = o.maxRows && o.maxRows > 0 ? Math.floor(o.maxRows) : DEFAULT_MAX_ROWS;
  if (kind === 'csv') {
    if (o.sheetName) {
      throw new FileReadError(`The stored file is a CSV, which has no tabs — but the tab "${o.sheetName}" is chosen. Choose no tab, or upload the workbook.`);
    }
    const parsed = csvToRecords(new TextDecoder('utf-8').decode(buf), { maxRows });
    return { kind, tabs: [], sheet: null, ...parsed };
  }
  if (kind === 'xlsx') await assertZipSize(buf);
  const out = await runXlsxWorker({
    bytes: new Uint8Array(buf),
    mode: 'rows',
    sheetName: o.sheetName ?? null,
    rowLimit: maxRows + 1 + HEADER_SLACK_ROWS + 1,
    colLimit: FILE_MAX_COLUMNS,
  }, o);
  if (!out.ok) {
    if (out.code === 'missing_tab') {
      throw new FileReadError(`The tab "${o.sheetName}" is not in this file. Its tabs are: ${out.tabs.map((t) => `"${t}"`).join(', ') || 'none'}. Choose one of them.`);
    }
    if (out.code === 'no_sheets') throw new FileReadError('The workbook has no sheets.');
    throw unreadable(kind);
  }
  const anomalies: string[] = [];
  if (out.colsCut) anomalies.push(`The tab has more than ${FILE_MAX_COLUMNS} columns; only the first ${FILE_MAX_COLUMNS} were read.`);
  const parsed = rowsToRecords(out.rows, {
    maxRows,
    anomalies,
    ...(out.rowsCut ? { truncated: true, truncatedReason: `The tab has more than ${maxRows} rows; only the first ${maxRows} were read.` } : {}),
  });
  return { kind, tabs: out.tabs, sheet: out.sheet, ...parsed };
}

/** The stored source_config of a 'file' integration, or null. */
export function readFileConfig(raw: unknown): FileSourceConfig | null {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (typeof c.fileName !== 'string' || !c.fileName || typeof c.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(c.sha256)) return null;
  return {
    fileName: c.fileName,
    sha256: c.sha256,
    ...(typeof c.sheetName === 'string' && c.sheetName ? { sheetName: c.sheetName } : {}),
  };
}

export const sha256Hex = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

interface FileRef { id: string; sourceConfig: FileSourceConfig }

/** One row of integration_source_files (schema.prisma IntegrationSourceFile). */
export interface SourceFileRow {
  integrationId: string;
  clientNumber: string;
  filename: string | null;
  mime: string | null;
  bytes: Uint8Array;
  sizeBytes: number | null;
  sha256: string | null;
  uploadedBy: number | null;
  uploadedAt: Date;
}
type Args = Record<string, unknown>;
/** The calls Nexeo makes on the IntegrationSourceFile delegate. Typed here so
 *  this module compiles against a client generated before DEF-368's model
 *  (the deploy's `npm run build` regenerates it); every call still goes
 *  through the tenant-scoping extension (TENANT_SCOPED_MODELS) AND names
 *  client_number itself. */
export interface SourceFileDelegate {
  findFirst(a: Args): Promise<Partial<SourceFileRow> | null>;
  findMany(a: Args): Promise<Array<Partial<SourceFileRow>>>;
  create(a: Args): Promise<unknown>;
  deleteMany(a: Args): Promise<{ count: number }>;
}
/** The delegate on a client or a transaction client. */
export const sourceFileTable = (client: unknown = prisma): SourceFileDelegate =>
  (client as { integrationSourceFile: SourceFileDelegate }).integrationSourceFile;

/** The stored copy of THIS tenant's integration; refuses a copy that is not
 *  the one source_config names (it changed after the test). */
async function loadStoredFile(cn: string, ref: FileRef): Promise<Buffer> {
  const row = await sourceFileTable().findFirst({
    where: { integrationId: ref.id, clientNumber: cn },
    select: { bytes: true, sha256: true },
  });
  if (!row) throw new FileReadError('No file is stored for this integration. Upload the spreadsheet in Connect.');
  if (!row.bytes) throw new FileReadError('No file is stored for this integration. Upload the spreadsheet in Connect.');
  const bytes = Buffer.from(row.bytes);
  if (sha256Hex(bytes) !== ref.sourceConfig.sha256) {
    throw new FileReadError('The stored file is not the one this connection names. Upload the spreadsheet again in Connect.');
  }
  return bytes;
}

export async function readFile(cn: string, ref: FileRef, opts: WorkerOptions = {}): Promise<ReadResult> {
  const bytes = await loadStoredFile(cn, ref);
  const maxRows = await getBehaviorValue('integrations.max_rows', { clientNumber: cn }).catch(() => DEFAULT_MAX_ROWS);
  const p = await parseSpreadsheet(bytes, { sheetName: ref.sourceConfig.sheetName ?? null, maxRows, ...opts });
  const sourceLabel = p.sheet ? `${ref.sourceConfig.fileName} › ${p.sheet}` : ref.sourceConfig.fileName;
  log.info('file read', { clientNumber: cn, integrationId: ref.id, kind: p.kind, rows: p.rowCount, bytes: bytes.length, truncated: p.truncated });
  return {
    records: p.records, headers: p.headers, rowCount: p.rowCount,
    truncated: p.truncated, ...(p.truncatedReason ? { truncatedReason: p.truncatedReason } : {}),
    anomalies: p.anomalies, sourceLabel,
  };
}

/** The Connect-step test: reads the stored copy for real; ONE sample row.
 *  Never throws for a bad file (ok:false + reason). */
export async function testFile(cn: string, ref: FileRef, opts: WorkerOptions = {}): Promise<TestResult> {
  try {
    const r = await readFile(cn, ref, opts);
    if (!r.headers.length) {
      return { ok: false, rows: 0, columns: [], sampleRow: null, reason: 'The tab is empty — it has no header row.' };
    }
    if (r.rowCount === 0) {
      return { ok: false, rows: 0, columns: r.headers, sampleRow: null, reason: 'The tab has a header row but no data rows. Choose the tab with the numbers, or upload the right file.' };
    }
    return { ok: true, rows: r.rowCount, columns: r.headers, sampleRow: r.records[0] ?? null };
  } catch (err) {
    const reason = err instanceof Error && (err as { code?: string }).code === 'INTEGRATION_INPUT' ? err.message : 'The file could not be read.';
    if (!(err instanceof FileReadError)) log.warn('file test failed', { clientNumber: cn, integrationId: ref.id, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, rows: 0, columns: [], sampleRow: null, reason };
  }
}
