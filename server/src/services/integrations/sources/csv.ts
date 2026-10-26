/**
 * DEF-354 — Integrations Stage 1: a small RFC 4180 CSV parser.
 *
 * Why this exists instead of a library: the sheet is read as Google's CSV
 * export because Nexeo's xlsx@0.18.5 has published CVEs and must not parse
 * untrusted workbooks (spec INTEGRATIONS_DESIGN.md §2.2). CSV is simple enough
 * to parse exactly, and owning the parser lets every oddity be REPORTED rather
 * than silently corrected (vm rule: the admin sees what the reader saw).
 *
 * Handles: quoted fields (commas, newlines inside quotes), "" as an escaped
 * quote, CRLF / LF / lone CR line ends, a UTF-8 BOM. Cells are trimmed; an
 * empty cell is '' (never undefined) so blank detection downstream is uniform.
 *
 * Headers: the first non-blank row. A blank header becomes "Column N" and a
 * repeated one "Name (2)", each reported as an anomaly — the mapping addresses
 * columns by header, so two columns may never share a name.
 *
 * Pure: no I/O.
 */

/** Split CSV text into rows of raw (untrimmed) cells. `unterminated` is true
 *  when the text ended inside a quoted field — the last row is then suspect. */
export function parseCsvRows(text: string): { rows: string[][]; unterminated: boolean } {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  // True once the current row has any content (a cell, a delimiter or a quote),
  // so the text's final line end does not produce a phantom empty row.
  let rowStarted = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; rowStarted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; rowStarted = true; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = []; cell = ''; rowStarted = false;
      continue;
    }
    cell += ch;
    rowStarted = true;
  }
  if (rowStarted || cell !== '' || inQuotes) {
    row.push(cell);
    rows.push(row);
  }
  return { rows, unterminated: inQuotes };
}

export interface CsvRecords {
  records: Record<string, string>[];
  headers: string[];
  rowCount: number;
  truncated: boolean;
  truncatedReason?: string;
  anomalies: string[];
}

export interface CsvRecordOptions {
  /** Data-row cap (behavior integrations.max_rows). Rows beyond it are not read. */
  maxRows?: number;
  /** The text was cut by a byte cap: its last row may be partial, so it is
   *  dropped and the result marked truncated. */
  cutByBytes?: boolean;
  /** Reason text used when cutByBytes is set. */
  bytesReason?: string;
}

const isBlankRow = (cells: string[]): boolean => cells.every((c) => c.trim() === '');

/** Make headers unique and non-blank, reporting every change. */
export function uniqueHeaders(raw: string[]): { headers: string[]; anomalies: string[] } {
  const anomalies: string[] = [];
  const headers: string[] = [];
  const used = new Set<string>();
  const blanks: number[] = [];
  raw.forEach((h, i) => {
    let base = h.trim();
    if (!base) { base = `Column ${i + 1}`; blanks.push(i + 1); }
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    if (name !== base) anomalies.push(`Column ${i + 1} repeats the header "${base}"; it is read as "${name}".`);
    used.add(name.toLowerCase());
    headers.push(name);
  });
  if (blanks.length) {
    anomalies.push(`${blanks.length} column(s) have no header (column ${blanks.join(', ')}); named "Column N".`);
  }
  return { headers, anomalies };
}

/**
 * CSV text ⇒ header-keyed records. Every data row becomes one record with a
 * key for EVERY header ('' when the row is short). Fully blank rows carry no
 * data and are skipped (counted in an anomaly). Cells past the last header are
 * dropped and reported — never silently.
 */
export function csvToRecords(text: string, opts: CsvRecordOptions = {}): CsvRecords {
  const { rows, unterminated } = parseCsvRows(text);
  const anomalies: string[] = [];
  let truncated = false;
  let truncatedReason: string | undefined;

  if (opts.cutByBytes) {
    // The byte cut can land mid-row (or mid-character): drop the last row.
    if (rows.length) rows.pop();
    truncated = true;
    truncatedReason = opts.bytesReason ?? 'The sheet is larger than the read limit; only the first part was read.';
  } else if (unterminated) {
    anomalies.push('The last row has an opening quote that is never closed; the rest of the sheet was read as one cell.');
  }

  const headerIdx = rows.findIndex((r) => !isBlankRow(r));
  if (headerIdx < 0) {
    return { records: [], headers: [], rowCount: 0, truncated, truncatedReason, anomalies };
  }
  if (headerIdx > 0) anomalies.push(`${headerIdx} blank row(s) above the header row were skipped.`);

  const { headers, anomalies: headerAnoms } = uniqueHeaders(rows[headerIdx]!);
  anomalies.push(...headerAnoms);

  const max = opts.maxRows && opts.maxRows > 0 ? Math.floor(opts.maxRows) : Infinity;
  const records: Record<string, string>[] = [];
  let blankRows = 0;
  let extraCellRows = 0;
  let firstExtraRow = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i]!;
    if (isBlankRow(cells)) { blankRows++; continue; }
    if (records.length >= max) {
      truncated = true;
      truncatedReason = `The sheet has more than ${max} data rows; only the first ${max} were read.`;
      break;
    }
    if (cells.length > headers.length && cells.slice(headers.length).some((c) => c.trim() !== '')) {
      extraCellRows++;
      // Sheet row number as the admin sees it (1-based, header included).
      if (!firstExtraRow) firstExtraRow = i + 1;
    }
    const rec: Record<string, string> = {};
    headers.forEach((h, c) => { rec[h] = (cells[c] ?? '').trim(); });
    records.push(rec);
  }

  if (blankRows) anomalies.push(`${blankRows} blank row(s) were skipped.`);
  if (extraCellRows) {
    anomalies.push(`${extraCellRows} row(s) have values beyond the last headed column (first at row ${firstExtraRow}); those values were not read.`);
  }

  return { records, headers, rowCount: records.length, truncated, truncatedReason, anomalies };
}
