/**
 * DEF-368 — the ONE place Nexeo's own code opens an Excel workbook.
 *
 * xlsx@0.18.5 has published CVEs (prototype pollution on a crafted file,
 * ReDoS) — the reason Stage 1 read Google Sheets as CSV (spec §2.2). An
 * uploaded .xlsx / .xls is untrusted, so it is opened here, inside a
 * worker_thread that fileReader.ts starts with a heap limit and a hard
 * timeout and terminates when either is reached: a polluted prototype, a
 * runaway regex or a memory blow-up dies with this isolate and never touches
 * the server's. Nothing but plain data crosses back: the tab names, and the
 * chosen tab's rows as arrays of strings (no workbook or worksheet objects).
 *
 * Opened with formulas, HTML, styles and stub cells OFF; rows come from
 * sheet_to_json(raw:false, defval:'', header:1) — the values as Excel
 * DISPLAYS them (formatted numbers and dates), one array per row.
 * `sheetRows` caps how many rows are parsed at all.
 *
 * The tab is chosen BY NAME. A named tab the workbook does not have is an
 * error ('missing_tab') — never silently another tab. No name ⇒ the first.
 *
 * Only this file imports 'xlsx' outside the vendored framework; the vendored
 * workbook readers stay forbidden (tests/def365IntegrationFramework +
 * tests/def368IntegrationFile pin both).
 */
import { parentPort, workerData } from 'worker_threads';
import xlsx, { type WorkBook } from 'xlsx';

export interface XlsxWorkerInput {
  bytes: Uint8Array;
  mode: 'tabs' | 'rows';
  sheetName: string | null;
  /** Rows parsed at most (header + data + slack). */
  rowLimit: number;
  /** Columns returned at most. */
  colLimit: number;
}

export type XlsxWorkerOutput =
  | { ok: true; tabs: string[]; sheet: string | null; rows: string[][]; rowsCut: boolean; colsCut: boolean }
  | { ok: false; code: 'missing_tab' | 'no_sheets' | 'unreadable'; tabs: string[]; message: string };

function run(input: XlsxWorkerInput): XlsxWorkerOutput {
  const buf = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const base = { type: 'buffer' as const, cellFormula: false, cellHTML: false, cellStyles: false, sheetStubs: false };
  let wb: WorkBook;
  try {
    wb = input.mode === 'tabs'
      ? xlsx.read(buf, { ...base, bookSheets: true })
      : xlsx.read(buf, { ...base, sheetRows: Math.max(1, Math.floor(input.rowLimit)) });
  } catch (err) {
    return { ok: false, code: 'unreadable', tabs: [], message: err instanceof Error ? err.message.slice(0, 300) : 'unreadable' };
  }
  const tabs = (wb.SheetNames ?? []).map((n) => String(n));
  if (input.mode === 'tabs') return { ok: true, tabs, sheet: null, rows: [], rowsCut: false, colsCut: false };
  if (tabs.length === 0) return { ok: false, code: 'no_sheets', tabs, message: 'no sheets' };

  const name = input.sheetName ?? tabs[0]!;
  if (!tabs.includes(name)) return { ok: false, code: 'missing_tab', tabs, message: name };
  const ws = wb.Sheets[name];
  if (!ws || !ws['!ref']) return { ok: true, tabs, sheet: name, rows: [], rowsCut: false, colsCut: false };

  const range = xlsx.utils.decode_range(ws['!ref']);
  // sheetRows cut the parse; the full extent is kept in !fullref.
  const full = ws['!fullref'] ? xlsx.utils.decode_range(String(ws['!fullref'])) : range;
  const rowsCut = full.e.r > range.e.r;
  let colsCut = false;
  const maxCol = range.s.c + Math.max(1, Math.floor(input.colLimit)) - 1;
  if (range.e.c > maxCol) { range.e.c = maxCol; colsCut = true; }

  const raw = xlsx.utils.sheet_to_json<unknown[]>(ws, { raw: false, defval: '', header: 1, range, blankrows: true });
  const rows: string[][] = raw.map((r) => (Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? '' : String(c))) : []));
  return { ok: true, tabs, sheet: name, rows, rowsCut, colsCut };
}

if (parentPort) {
  let out: XlsxWorkerOutput;
  try {
    out = run(workerData as XlsxWorkerInput);
  } catch (err) {
    out = { ok: false, code: 'unreadable', tabs: [], message: err instanceof Error ? err.message.slice(0, 300) : 'unreadable' };
  }
  parentPort.postMessage(out);
}
