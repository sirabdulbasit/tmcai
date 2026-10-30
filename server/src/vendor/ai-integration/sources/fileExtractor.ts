/**
 * AI file extractor.
 *
 * Takes a base64-encoded file + filename + mimetype, dispatches to the
 * right extractor, returns structured content for the LLM to read.
 *
 * Output shape varies by source:
 *  - Tabular (Excel/CSV): { kind: 'rows', rows: [...], headerHints: [...] }
 *  - Text (PDF/Word/TXT/MD/JSON): { kind: 'text', text: '...', pageCount? }
 *  - Image (PNG/JPG/GIF/WEBP): { kind: 'image', mimeType, base64 }
 *
 * The upload controller decides how to feed this into Gemini:
 *  - Tabular → if it matches the VM bulk-upload format, use parseObjectiveExcel
 *              directly; otherwise pass rows as text to the LLM.
 *  - Text   → pass to LLM with the goal-extraction prompt.
 *  - Image  → send to Gemini as inline multimodal data.
 */

import xlsx from 'xlsx';
import mammoth from 'mammoth';

export type ExtractedContent =
  | { kind: 'rows'; sheetName: string; rows: Record<string, unknown>[]; headerHints: string[]; mergedColumns?: string[] }
  | { kind: 'text'; text: string; pageCount?: number }
  | { kind: 'image'; mimeType: string; base64: string };

export interface ExtractInput {
  fileBase64: string;
  filename: string;
  mimetype?: string;
  /**
   * Which sheet to read. Omitted everywhere except the file-based integration
   * source, which lets an administrator assign one sheet of a workbook — an
   * uploaded file is read as it always was, from the first sheet.
   */
  sheetName?: string;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB hard cap
const MAX_TEXT_CHARS = 200_000;          // ~50k tokens, generous for one LLM call

const inferTypeFromName = (name: string): string => {
  const m = name.match(/\.([^.]+)$/);
  return m && m[1] ? m[1].toLowerCase() : '';
};

const inferTypeFromMime = (mime: string | undefined): string | null => {
  if (!mime) return null;
  const m = mime.toLowerCase();
  if (m.includes('spreadsheet') || m.includes('excel')) return 'xlsx';
  if (m === 'text/csv' || m.includes('comma-separated')) return 'csv';
  if (m === 'application/pdf') return 'pdf';
  if (m.includes('wordprocessingml') || m === 'application/msword') return 'docx';
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/json') return 'json';
  if (m.startsWith('text/')) return 'txt';
  return null;
};

export const extractFile = async (input: ExtractInput): Promise<ExtractedContent> => {
  const buf = Buffer.from(input.fileBase64, 'base64');
  if (buf.length === 0) {
    throw new Error('Uploaded file is empty.');
  }
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`File exceeds the 20 MB limit (${Math.round(buf.length / 1024 / 1024)} MB).`);
  }

  const mimeKind = inferTypeFromMime(input.mimetype);
  const extKind = inferTypeFromName(input.filename);
  const kind = mimeKind ?? extKind;

  switch (kind) {
    case 'xlsx':
    case 'xls':
    case 'csv':
      return extractTabular(buf, kind, input.sheetName);
    case 'pdf':
      return extractPdf(buf);
    case 'docx':
      return extractDocx(buf);
    case 'json':
      return extractJson(buf);
    case 'txt':
    case 'md':
    case 'markdown':
      return extractPlainText(buf);
    case 'image':
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return extractImage(buf, input.mimetype, kind);
    default:
      // Last-resort fallback — try to parse as text. If it's garbage,
      // truncation makes it harmless.
      return extractPlainText(buf);
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Per-type extractors
// ─────────────────────────────────────────────────────────────────────────

const extractTabular = (buf: Buffer, kind: string, wanted?: string): ExtractedContent => {
  const wb = xlsx.read(buf, { type: 'buffer' });
  // Default stays the first sheet, so every existing caller reads what it always
  // did. A NAMED sheet is only ever asked for by a file-based integration, where
  // the administrator picked it — and asking for one that is gone must say so
  // rather than quietly syncing a different sheet's numbers.
  const sheetName = wanted
    ? wb.SheetNames.find((n) => n === wanted)
    : wb.SheetNames[0];
  if (wanted && !sheetName) {
    throw new Error(
      `This workbook has no sheet named "${wanted}". It contains: ${wb.SheetNames.join(', ')}.`,
    );
  }
  if (!sheetName) throw new Error(`No sheets found in ${kind} file.`);
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`Could not read sheet "${sheetName}".`);

  // UN-MERGE: Excel stores a merged cell's value only in the top-left cell and
  // leaves the rest of the range empty. Left as-is, a "Pillar"/"Objective" cell
  // merged down across its key-result rows would show the name on row 1 only and
  // blanks below — so the rows can't be grouped. Fill each merged value across
  // its whole range before flattening, so every row carries the real value.
  const merges = (sheet['!merges'] as Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> | undefined) ?? [];
  for (const m of merges) {
    const anchor = sheet[xlsx.utils.encode_cell({ r: m.s.r, c: m.s.c })];
    if (anchor === undefined) continue;
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r === m.s.r && c === m.s.c) continue;
        const addr = xlsx.utils.encode_cell({ r, c });
        if (sheet[addr] === undefined) sheet[addr] = { ...anchor };
      }
    }
  }

  // Which columns are VERTICALLY merged in the DATA region (not the header row)?
  // Those are the objective-identity columns (a "Business Objective" cell merged
  // down over its key-result rows). We surface their header names so the caller
  // can group rows by them — turning "85 rows" into "9 objectives" deterministically
  // instead of relying on the LLM to group 85 rows correctly.
  const ref = sheet['!ref'] ? xlsx.utils.decode_range(sheet['!ref']) : null;
  const headerByCol = new Map<number, string>();
  if (ref) {
    for (let c = ref.s.c; c <= ref.e.c; c++) {
      const cell = sheet[xlsx.utils.encode_cell({ r: ref.s.r, c })] as { w?: string; v?: unknown } | undefined;
      const name = cell ? String(cell.w ?? cell.v ?? '').trim() : '';
      if (name) headerByCol.set(c, name);
    }
  }
  const mergedColIdx = new Set<number>();
  for (const m of merges) {
    if (m.e.r > m.s.r && m.s.r > (ref?.s.r ?? 0)) { // vertical merge below the header row
      for (let c = m.s.c; c <= m.e.c; c++) mergedColIdx.add(c);
    }
  }
  const mergedColumns = [...mergedColIdx].sort((a, b) => a - b)
    .map((c) => headerByCol.get(c)).filter((n): n is string => !!n);

  // sheet_to_json with header:1 gives raw arrays; with defval we keep blanks.
  const rows: Record<string, unknown>[] = xlsx.utils.sheet_to_json(sheet, {
    defval: null,
    raw: false,
  });
  // Header hints from the first non-empty row
  const headerHints = rows.length > 0 && rows[0] ? Object.keys(rows[0]) : [];
  return { kind: 'rows', sheetName, rows, headerHints, ...(mergedColumns.length ? { mergedColumns } : {}) };
};

const extractPdf = async (buf: Buffer): Promise<ExtractedContent> => {
  // pdf-parse v2 exports a PDFParse class (not a default function).
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    let text = String(result.text ?? '').trim();
    if (!text) {
      throw new Error('PDF contains no extractable text — likely scanned. Re-upload as an image, or use a text-based PDF.');
    }
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[truncated]';
    return { kind: 'text', text, pageCount: result.total };
  } finally {
    await parser.destroy().catch(() => {});
  }
};

const extractDocx = async (buf: Buffer): Promise<ExtractedContent> => {
  const result = await mammoth.extractRawText({ buffer: buf });
  let text = String(result.value ?? '').trim();
  if (!text) throw new Error('Word document contains no extractable text.');
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[truncated]';
  return { kind: 'text', text };
};

const extractJson = (buf: Buffer): ExtractedContent => {
  const raw = buf.toString('utf8');
  // Validate it parses (so AI doesn't waste tokens on broken JSON)
  try {
    JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`);
  }
  return { kind: 'text', text: raw.slice(0, MAX_TEXT_CHARS) };
};

const extractPlainText = (buf: Buffer): ExtractedContent => {
  const text = buf.toString('utf8').slice(0, MAX_TEXT_CHARS).trim();
  if (!text) throw new Error('File contains no readable text.');
  return { kind: 'text', text };
};

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const extractImage = (buf: Buffer, mimetype: string | undefined, ext: string): ExtractedContent => {
  const mimeType = (mimetype && mimetype.startsWith('image/'))
    ? mimetype
    : (MIME_BY_EXT[ext] ?? 'image/png');
  return { kind: 'image', mimeType, base64: buf.toString('base64') };
};
