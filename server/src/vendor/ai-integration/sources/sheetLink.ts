/**
 * Integration Sync — a Google Sheet given by its link
 * ===================================================
 * The administrator pastes the sheet's link where the document goes, and every
 * run reads the sheet as it is at that moment — no file to re-upload, no Google
 * account to connect. What makes that possible is the sheet's own sharing: it
 * must be shared as "Anyone with the link — Viewer", and Google then serves it
 * to anyone holding the link. Nothing is stored but the link.
 *
 * The sheet is read as an Excel export, not CSV: the CSV export loses the
 * difference between a header written "Feb 2026" and a date, and the month
 * columns a recipe reads are found by their headers.
 *
 * Only Google's own export address is ever called, built from the sheet's id —
 * never the pasted text — so a link cannot send the server anywhere else.
 */
import xlsx from 'xlsx';
import { normaliseHeader } from './workbook';

export interface SheetLink {
  /** The link as given, kept to show the administrator. */
  url: string;
  /** A sheet's id, or a published sheet's "2PACX-…" id. */
  id: string;
  /** "File → Share → Publish to web" links live under /d/e/ and export differently. */
  published: boolean;
  /** The tab the link points at (`gid=`), when it names one. */
  gid: string | null;
}

const LINK = /https?:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/(e\/)?([A-Za-z0-9_-]{20,})[^\s"'<>]*/i;

/** The first Google Sheet link in a text, or null. */
export const parseSheetLink = (text: string): SheetLink | null => {
  const m = LINK.exec(String(text ?? ''));
  if (!m) return null;
  const url = m[0];
  const gid = /[#?&]gid=(\d+)/.exec(url)?.[1] ?? null;
  return { url, id: m[2]!, published: !!m[1], gid };
};

/** True when the text is the link and nothing else — how an API integration tells a link from a document. */
export const isOnlySheetLink = (text: string): boolean => {
  const link = parseSheetLink(text);
  return !!link && String(text).trim() === link.url;
};

const base = (l: Pick<SheetLink, 'id' | 'published'>) =>
  `https://docs.google.com/spreadsheets/d/${l.published ? 'e/' : ''}${encodeURIComponent(l.id)}`;

/** Google's export address for the whole workbook, as Excel. */
export const sheetExportUrl = (l: Pick<SheetLink, 'id' | 'published'>): string =>
  l.published ? `${base(l)}/pub?output=xlsx` : `${base(l)}/export?format=xlsx`;

/** One tab as CSV — read only for its header row, to tell which tab `gid` is. */
export const tabCsvUrl = (l: Pick<SheetLink, 'id' | 'published'>, gid: string): string =>
  l.published
    ? `${base(l)}/pub?output=csv&gid=${encodeURIComponent(gid)}`
    : `${base(l)}/export?format=csv&gid=${encodeURIComponent(gid)}`;

const MAX_BYTES = 30 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const NOT_SHARED = 'Google did not hand over the sheet — it is not shared with everyone who has the link. '
  + 'In the sheet, Share → General access → "Anyone with the link" → Viewer, then try again.';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * A response body, read only up to `max` bytes — never the whole of a body
 * that is larger, since one tenant's sheet must not fill the memory every
 * tenant shares. null when it is larger. With `stopAt`, reading also ends at
 * the first such byte (a header row needs only its first line).
 */
export const readCapped = async (res: Response, max: number, stopAt?: number): Promise<Buffer | null> => {
  if (Number(res.headers.get('content-length') ?? 0) > max && stopAt === undefined) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    if (stopAt !== undefined && value.includes(stopAt)) { await reader.cancel().catch(() => {}); break; }
    if (n > max) { await reader.cancel().catch(() => {}); return stopAt !== undefined ? Buffer.concat(parts) : null; }
  }
  return Buffer.concat(parts);
};

/** The file's name from Google's Content-Disposition, when it sends one. */
export const nameFromDisposition = (header: string | null): string | null => {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) { try { return decodeURIComponent(star[1]!.trim()); } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1]!.trim() : null;
};

/**
 * Download the sheet as an Excel workbook. Throws, in words an administrator
 * can act on, when the sheet is missing or not shared — Google answers an
 * unshared sheet with its sign-in page, not an error code.
 */
export const downloadSheetLink = async (
  l: SheetLink,
  fetchImpl: FetchLike = fetch,
): Promise<{ bytes: Buffer; name: string }> => {
  let res: Response;
  try {
    res = await fetchImpl(sheetExportUrl(l), { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Google Sheets could not be reached (${err instanceof Error ? err.message : 'no answer'}).`);
  }
  if (res.status === 404) throw new Error('That Google Sheet was not found — check the link.');
  if (res.status === 401 || res.status === 403) throw new Error(NOT_SHARED);
  if (!res.ok) throw new Error(`Google Sheets answered ${res.status} for this sheet.`);
  if (/text\/html/i.test(res.headers.get('content-type') ?? '')) throw new Error(NOT_SHARED);
  const bytes = await readCapped(res, MAX_BYTES);
  if (!bytes) throw new Error('That Google Sheet is larger than 30 MB, which is more than an integration reads.');
  // An xlsx is a zip: anything else is a page, whatever its headers said.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(NOT_SHARED);
  const given = nameFromDisposition(res.headers.get('content-disposition'));
  const name = given ? (/\.xlsx$/i.test(given) ? given : `${given}.xlsx`) : 'Google Sheet.xlsx';
  return { bytes, name };
};

/** The cells of a CSV's first line (quotes honoured), for comparing headers. */
export const csvHeaderCells = (csv: string): string[] => {
  const line = csv.replace(/^﻿/, '');
  const cells: string[] = [];
  let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { cells.push(cur); cur = ''; } else if (ch === '\n' || ch === '\r') break;
    else cur += ch;
  }
  cells.push(cur);
  return cells;
};

/** Every named sheet whose header row is exactly these headers (blank trailing cells ignored). */
export const sheetsWithHeaders = (
  candidates: Array<{ name: string; headers: string[] }>,
  wanted: string[],
): string[] => {
  const key = (hs: string[]) => {
    const n = hs.map((h) => normaliseHeader(String(h ?? '')));
    while (n.length && !n[n.length - 1]) n.pop();
    return JSON.stringify(n);
  };
  const w = key(wanted);
  return candidates.filter((c) => key(c.headers) === w).map((c) => c.name);
};

/**
 * The tab the link points at, by name, so the workbook read takes it: Google
 * exports every tab, and `gid` is not a name. Found by matching that tab's
 * header row against each tab's first row. No `gid`, or a one-tab workbook →
 * null (the only tab). A `gid` that matches no tab, or several, is an error:
 * reading some other tab instead would put another month's or another
 * sheet's figures on goals without anyone noticing.
 */
export const tabForLink = async (
  l: SheetLink,
  bytes: Buffer,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> => {
  if (!l.gid) return null;
  let wb: xlsx.WorkBook;
  try {
    // Only the first row of each tab: the headers are all that is compared.
    wb = xlsx.read(bytes, { type: 'buffer', sheetRows: 1 });
  } catch { return null; }
  if (wb.SheetNames.length <= 1) return null;
  let wanted: string[];
  try {
    const res = await fetchImpl(tabCsvUrl(l, l.gid), { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const head = await readCapped(res, 64 * 1024, 0x0a);
    wanted = csvHeaderCells((head ?? Buffer.alloc(0)).toString('utf8'));
  } catch (err) {
    throw new Error(`The tab this link points at could not be read from Google Sheets (${err instanceof Error ? err.message : 'no answer'}).`);
  }
  const candidates = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const first = ws ? ((xlsx.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false }) as unknown[][])[0] ?? []) : [];
    return { name, headers: first.map((v) => String(v ?? '')) };
  });
  const hits = sheetsWithHeaders(candidates, wanted);
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new Error(`The link points at one tab, but the tabs ${hits.map((h) => `"${h}"`).join(', ')} have the same columns, `
      + 'so which one it means cannot be told. Give each its own columns, or link to a sheet with one tab.');
  }
  throw new Error('The tab this link points at was not found in the sheet — it may be empty. Copy the link again while that tab is open.');
};

/* ── a private sheet, read through a signed-in Google account ─────────────── */

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * Read a sheet through the Google Sheets API with an account's access token
 * (SHEETS_SCOPES) — the sheet stays private. The tab is the link's `gid` when
 * it names one (matched exactly by its id), else the first. Values are read as
 * the sheet displays them ("Feb 2026", "10.8%") and handed back as an Excel
 * workbook, so the same reader, header checks and recipes apply as for every
 * other spreadsheet source.
 */
export const readSheetWithToken = async (
  l: SheetLink,
  accessToken: string,
  account: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<{ bytes: Buffer; name: string; tab: string }> => {
  if (l.published) throw new Error('A "Publish to web" link cannot be read through an account — paste the sheet\'s own link (…/spreadsheets/d/<id>/edit).');
  const who = account ? `The connected Google account (${account})` : 'The connected Google account';
  const call = async (url: string): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`Google Sheets could not be reached (${err instanceof Error ? err.message : 'no answer'}).`);
    }
    if (res.status === 401) throw new Error('Google no longer accepts the connected account\'s permission — connect the Google account again.');
    if (!res.ok) {
      // Google says WHY; a 403 alone is several different problems.
      const why = await res.text().then((t) => {
        try { return String((JSON.parse(t) as { error?: { message?: unknown } }).error?.message ?? ''); } catch { return ''; }
      }, () => '');
      if (/has not been used in project|is disabled|SERVICE_DISABLED/i.test(why)) {
        throw new Error('The Google Sheets API is not enabled in your organisation\'s Google Cloud project — ask IT to enable '
          + '"Google Sheets API" for the project that holds the host application\'s sign-in, then try again.');
      }
      if (/not supported for this document/i.test(why)) {
        throw new Error('This file is an Excel file stored in Google Drive, not a Google Sheet, so it cannot be read this way. '
          + 'In Google, open it and use File → Save as Google Sheets, then paste the new sheet\'s link.');
      }
      if (res.status === 403) throw new Error(`${who} cannot open this sheet. Share the sheet with that account (Viewer is enough), or connect an account that can open it.`);
      if (res.status === 404) throw new Error('That Google Sheet was not found — check the link.');
      throw new Error(`Google Sheets answered ${res.status} for this sheet${why ? ` — ${why.slice(0, 200)}` : ''}.`);
    }
    const body = await readCapped(res, MAX_BYTES);
    if (!body) throw new Error('That Google Sheet is larger than 30 MB, which is more than an integration reads.');
    return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  };
  const meta = await call(`${SHEETS_API}/${encodeURIComponent(l.id)}?fields=properties.title,sheets.properties(sheetId,title,index)`);
  const tabs = ((meta.sheets as Array<{ properties?: { sheetId?: number; title?: string; index?: number } }> | undefined) ?? [])
    .map((s) => s.properties ?? {})
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (!tabs.length) throw new Error('That Google Sheet has no tabs to read.');
  const tab = l.gid != null ? tabs.find((t) => String(t.sheetId) === l.gid) : tabs[0];
  if (!tab?.title) throw new Error('The tab this link points at was not found in the sheet. Copy the link again while that tab is open.');
  const range = encodeURIComponent(`'${tab.title.replace(/'/g, "''")}'`);
  const values = await call(`${SHEETS_API}/${encodeURIComponent(l.id)}/values/${range}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`);
  const rows = (values.values as unknown[][] | undefined) ?? [];
  const ws = xlsx.utils.aoa_to_sheet(rows.map((r) => r.map((v) => (v == null ? '' : String(v)))));
  // Every cell as text, exactly as displayed — no date or number guessing.
  for (const k of Object.keys(ws)) if (!k.startsWith('!')) { const c = ws[k] as xlsx.CellObject; c.t = 's'; }
  const book = xlsx.utils.book_new();
  // Google allows / : ? * [ ] in a tab name and Excel does not; the name is
  // only a label here (the values were read by the real title above).
  const sheetName = tab.title.replace(/[\\/?*[\]:]/g, '_').slice(0, 31).trim() || 'Sheet1';
  xlsx.utils.book_append_sheet(book, ws, sheetName);
  const bytes = xlsx.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const title = String((meta.properties as { title?: unknown } | undefined)?.title ?? 'Google Sheet');
  return { bytes, name: `${title}.xlsx`, tab: sheetName };
};

/* ── any spreadsheet in Google Drive: a Google Sheet or an Excel file ─────── */

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
/** Spreadsheet files Drive keeps as they were uploaded, read like an upload. */
const DRIVE_WORKBOOKS: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
};

/**
 * Read whatever spreadsheet a Drive link names, through the connected account
 * (drive.readonly): a native Google Sheet through the Sheets API (the tab the
 * link's `gid` names, as displayed — readSheetWithToken), an Excel or CSV file
 * downloaded as it is and read like an upload (its first tab — an Excel file's
 * `gid` is Google's view of it, not one of its tabs). Anything else is refused
 * by what it is.
 */
export const readDriveFileWithToken = async (
  l: SheetLink,
  accessToken: string,
  account: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<{ bytes: Buffer; name: string; tab: string | null }> => {
  if (l.published) throw new Error('A "Publish to web" link cannot be read through an account — paste the file\'s own link.');
  const who = account ? `The connected Google account (${account})` : 'The connected Google account';
  const get = async (url: string): Promise<Response> => {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`Google Drive could not be reached (${err instanceof Error ? err.message : 'no answer'}).`);
    }
    if (res.ok) return res;
    if (res.status === 401) throw new Error('Google no longer accepts the connected account\'s permission — connect the Google account again.');
    const why = await res.text().then((t) => {
      try {
        const e = (JSON.parse(t) as { error?: { message?: unknown; errors?: Array<{ reason?: unknown }> } }).error;
        return `${String(e?.errors?.[0]?.reason ?? '')} ${String(e?.message ?? '')}`;
      } catch { return ''; }
    }, () => '');
    if (/insufficientPermissions|insufficient authentication scopes/i.test(why)) {
      throw new Error('The Google account was connected before Drive files could be read. Press Disconnect, then '
        + 'Connect Google account again and allow access to Google Drive files.');
    }
    if (/has not been used in project|is disabled|accessNotConfigured/i.test(why)) {
      throw new Error('The Google Drive API is not enabled in your organisation\'s Google Cloud project — ask IT to enable '
        + '"Google Drive API" for the project that holds the host application\'s sign-in, then try again.');
    }
    if (res.status === 404 || res.status === 403) {
      throw new Error(`${who} cannot open this file, or it does not exist. Check the link, and share the file with that account (Viewer is enough).`);
    }
    throw new Error(`Google Drive answered ${res.status} for this file.`);
  };
  const metaRes = await get(`${DRIVE_API}/${encodeURIComponent(l.id)}?fields=name,mimeType,size&supportsAllDrives=true`);
  const meta = (await metaRes.json()) as { name?: string; mimeType?: string; size?: string };
  const mime = String(meta.mimeType ?? '');
  if (mime === GOOGLE_SHEET) return readSheetWithToken(l, accessToken, account, fetchImpl);
  const ext = DRIVE_WORKBOOKS[mime];
  if (!ext) {
    throw new Error(`"${meta.name ?? 'This file'}" is not a spreadsheet (${mime || 'unknown type'}) — link a Google Sheet or an Excel file.`);
  }
  if (Number(meta.size ?? 0) > MAX_BYTES) throw new Error('That file is larger than 30 MB, which is more than an integration reads.');
  const body = await get(`${DRIVE_API}/${encodeURIComponent(l.id)}?alt=media&supportsAllDrives=true`);
  const bytes = await readCapped(body, MAX_BYTES);
  if (!bytes) throw new Error('That file is larger than 30 MB, which is more than an integration reads.');
  const base = String(meta.name ?? 'Drive file').replace(/\.(xlsx|xls|csv)$/i, '');
  return { bytes, name: `${base}.${ext}`, tab: null };
};
