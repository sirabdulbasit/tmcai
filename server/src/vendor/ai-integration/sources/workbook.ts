/**
 * Integration Sync — reading records out of a SPREADSHEET instead of an API
 * ========================================================================
 * The sync engine's rules do not care where a row came from. Everything after
 * the fetch — the mapping, `classifyValue`, `resolveTarget`, `changeCapTripped`,
 * the schedule, the audit — takes `Array<Record<string, unknown>>` and works the
 * same. So a file source is a second way to produce those rows, not a second
 * pipeline, and this module is only about producing them honestly.
 *
 * The one thing genuinely NEW about a file source is that a person can edit it.
 * An API's shape changes when someone ships a release; a spreadsheet's shape
 * changes when someone drags a column, renames a heading, or inserts a title
 * row above it — and none of that is visible to us. The mapping was approved
 * against the headings that existed the day it was set up, so a renamed column
 * silently stops mapping and the run writes a subset while reporting success.
 *
 * That is the same failure shape as a truncated AI reply that still parses:
 * plausible, partial, and undetectable downstream. So the headings are checked
 * against the approved mapping on EVERY run, and a run whose columns have moved
 * is refused rather than written. Refusing costs someone a morning; a partial
 * write costs data nobody knows is wrong.
 */

import xlsx from 'xlsx';

import { extractFile } from './fileExtractor';

export interface WorkbookRows {
  rows: Array<Record<string, unknown>>;
  /** The sheet actually read — echoed so the admin can see it was the right one. */
  sheetName: string;
  /** Column headings as they appear in the file, in file order. */
  headers: string[];
}

/**
 * Read one sheet of a workbook into rows keyed by column heading.
 *
 * Delegates to the shared extractor, which already handles the awkward parts of
 * real spreadsheets — merged cells filled across their range, blanks preserved
 * rather than dropped — so a file assigned here behaves exactly like one
 * uploaded anywhere else in the product.
 */
export const readWorkbook = async (
  buf: Buffer,
  filename: string,
  mimetype?: string,
  sheetName?: string,
): Promise<WorkbookRows> => {
  const extracted = await extractFile({
    fileBase64: buf.toString('base64'),
    filename,
    ...(mimetype ? { mimetype } : {}),
    ...(sheetName ? { sheetName } : {}),
  });

  if (extracted.kind !== 'rows') {
    throw new Error(
      `"${filename}" is not a spreadsheet this integration can read. Assign an Excel workbook `
      + '(.xlsx) or a CSV — a document or an image cannot be synced from.',
    );
  }
  return {
    rows: extracted.rows,
    sheetName: extracted.sheetName,
    headers: extracted.headerHints,
  };
};

/**
 * Is this upload the DATA, or a document ABOUT the data?
 * =====================================================
 * Two boxes on the Connect step take a file: one feeds the AI reader, which
 * looks for an API in the text; the other is the spreadsheet itself. Nothing
 * stopped a data sheet going into the reader, which would then hunt for a base
 * URL in 500 rows of employee codes. The two are told apart by content, so
 * whichever box a person uses, the right thing happens.
 *
 * A sheet is DATA when it has enough rows and a column that identifies people
 * — by heading, or because its values look like emails or employee codes — and
 * does not read like documentation. It is a DOCUMENT when it is prose (PDF,
 * Word, text) or when its cells talk about endpoints, parameters and keys
 * rather than holding values.
 */
export type UploadKind = 'data' | 'document';

const IDENTITY_HEADING = /^(emp(loyee)?[\s_-]?(id|code|no|number)|personal[\s_-]?no|staff[\s_-]?(id|no)|e-?mail|email[\s_-]?address|user[\s_-]?email)$/i;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_VALUE = /^[A-Za-z]{1,4}[-_ ]?\d{2,8}$/;
// A bare number is a code only when it is long enough not to be a total, and
// the column is (almost) unique — identifiers do not repeat, amounts do.
const NUMERIC_CODE = /^\d{3,8}$/;
const DOC_WORDS = /\b(endpoint|base url|bearer|api[\s_-]?key|authorization|parameter|request|response|http[s]?:\/\/|description|pagination)\b/i;

export const classifyUpload = (
  extracted: { kind: 'rows'; rows: Array<Record<string, unknown>>; headerHints: string[] } | { kind: 'text' | 'image' },
): { kind: UploadKind; reason: string } => {
  if (extracted.kind !== 'rows') return { kind: 'document', reason: 'It is a document, not a table.' };
  const { rows, headerHints } = extracted;
  if (rows.length < 3) return { kind: 'document', reason: `Only ${rows.length} row(s) — too few to be a data set.` };

  const sample = rows.slice(0, 200);
  const headers = headerHints.length ? headerHints : Object.keys(sample[0] ?? {});

  // Documentation talks; data holds values.
  let cells = 0; let docCells = 0;
  for (const row of sample) {
    for (const v of Object.values(row)) {
      const t = v == null ? '' : String(v);
      if (!t) continue;
      cells++;
      if (t.length > 60 || DOC_WORDS.test(t)) docCells++;
    }
  }
  if (cells && docCells / cells > 0.2) {
    return { kind: 'document', reason: 'Its cells describe an API rather than holding values.' };
  }

  const headed = headers.find((h) => IDENTITY_HEADING.test(String(h).trim()));
  if (headed) return { kind: 'data', reason: `"${headed}" identifies people.` };

  for (const h of headers) {
    const values = sample.map((r) => (r[h] == null ? '' : String(r[h]).trim())).filter(Boolean);
    if (values.length < 3) continue;
    const unique = new Set(values).size / values.length >= 0.9;
    const idLike = values.filter((v) =>
      EMAIL_VALUE.test(v) || CODE_VALUE.test(v) || (unique && NUMERIC_CODE.test(v))).length;
    if (idLike / values.length >= 0.6) return { kind: 'data', reason: `"${h}" holds emails or employee codes.` };
  }
  return { kind: 'document', reason: 'No column identifies people.' };
};

/** Compare headings ignoring case, spacing and punctuation — "Emp Code" = "emp_code". */
export const normaliseHeader = (h: string): string =>
  h.toLowerCase().replace(/[^a-z0-9]+/g, '');

export interface HeaderCheck {
  ok: boolean;
  /** Approved fields the file no longer has a column for. */
  missing: string[];
  /** What the file actually offers, for the message. */
  present: string[];
}

/**
 * Does this file still have every column the approved mapping reads?
 *
 * Extra columns are fine — someone adding a column breaks nothing, and refusing
 * over one would make the integration fragile in the opposite direction. Only a
 * column that has GONE matters, because that is the one whose values silently
 * become absent.
 */
export const checkHeaders = (headers: string[], required: string[]): HeaderCheck => {
  const have = new Set(headers.map(normaliseHeader));
  const missing = required.filter((f) => f && !have.has(normaliseHeader(f)));
  return { ok: missing.length === 0, missing, present: headers };
};

/**
 * What the administrator is told when the columns have moved. Names both sides:
 * the run stopped, and it stopped because of something a person can go and fix
 * in the file itself.
 */
export const describeHeaderDrift = (check: HeaderCheck, fileName: string): string => {
  const missing = check.missing.join('", "');
  return `"${fileName}" no longer has a column for "${missing}". Nothing was written — the `
    + 'mapping was approved against a column of that name, so continuing would have left those '
    + `values out without saying so. The file now offers: ${check.present.slice(0, 20).join(', ')}`
    + `${check.present.length > 20 ? ', …' : ''}. Either restore the heading in the file, or `
    + 'redo the mapping step to match what it has now.';
};

/**
 * Every sheet in the workbook, so an administrator can be shown a list rather
 * than asked to type a name. Read straight from the bytes: the extractor
 * returns one sheet's rows by design, and offering the wrong sheet's numbers is
 * exactly what the assign step exists to prevent.
 */
export const sheetNamesOf = (buf: Buffer): string[] => {
  try {
    return xlsx.read(buf, { type: 'buffer', bookSheets: true }).SheetNames ?? [];
  } catch {
    return [];
  }
};
