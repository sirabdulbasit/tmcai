/**
 * DEF-354 — Integrations Stage 1: a Google Sheet given by its link.
 *
 * Ported from vm src/services/integrationSheetLink.ts (parseSheetLink /
 * sheetExportUrl). Two vm rules are kept verbatim, because each one closes a
 * real hole (spec INTEGRATIONS_DESIGN.md §2.2):
 *
 *  1. The export URL is REBUILT from the sheet id and gid alone — never the
 *     pasted text — so a link cannot send the server anywhere but Google's own
 *     export address (SSRF-proof by construction). `link` is kept for display.
 *  2. A tab is never silently swapped. The gid is always explicit in the stored
 *     config ('0' when the link names none), and a link whose query and
 *     fragment name DIFFERENT tabs is refused rather than guessed at — reading
 *     the wrong tab would put another month's figures on a KPI unnoticed.
 *
 * Differences from vm, on purpose:
 *  - CSV, not xlsx: Nexeo's xlsx@0.18.5 has published CVEs and must not parse
 *    untrusted workbooks. A CSV export with `gid` IS that one tab, so vm's
 *    header-matching tab finder (tabForLink) is not needed.
 *  - "Publish to web" links (/d/e/2PACX-…) are refused: their id is not the
 *    sheet id, the /export address does not serve them, and Stage 1 reads
 *    either publicly-shared or account-readable sheets through one address.
 *  - The input must BE the link (not a text containing one): this is a form
 *    field, and a value with extra text is far more likely a paste mistake.
 *
 * DEF-365: the vendored @tmc/ai-integration parseSheetLink is composed in as
 * a second recogniser (see parseSheetLink). Its xlsx export / tab finder / token
 * readers are NOT used (xlsx@0.18.5 CVEs; Nexeo reads one tab as CSV).
 *
 * Pure: no I/O.
 */
import { IntegrationInputError, type GsheetSourceConfig } from '../types';
import { parseSheetLink as frameworkParseSheetLink } from '../../../vendor/ai-integration/sources/sheetLink';

/** Google sheet ids are base64url-ish and long; vm used ≥20, kept. */
const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,128}$/;
const GID_RE = /^\d{1,12}$/;
const MAX_LINK_LEN = 2048;

/** The one host the server ever asks for a sheet. */
export const SHEETS_EXPORT_HOST = 'docs.google.com';

const fail = (message: string): never => { throw new IntegrationInputError(message, 'link'); };

/**
 * Parse a pasted Google Sheet link into the stored source config.
 * Throws IntegrationInputError(…, 'link') on anything that is not a
 * docs.google.com spreadsheet link. Missing gid ⇒ '0' (the sheet's first tab).
 */
export function parseSheetLink(link: string): GsheetSourceConfig {
  const raw = String(link ?? '').trim();
  if (!raw) fail('Paste the Google Sheet link.');
  if (raw.length > MAX_LINK_LEN) fail('That link is too long to be a Google Sheet link.');

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return fail('That is not a Google Sheet link. Copy it from the browser address bar while the sheet is open.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('That is not a Google Sheet link.');
  if (url.hostname.toLowerCase() !== SHEETS_EXPORT_HOST || url.username || url.password || url.port) {
    fail('Only Google Sheets links (docs.google.com/spreadsheets/…) can be used.');
  }

  // /spreadsheets/d/<id>/… or /spreadsheets/u/<n>/d/<id>/… (account-switch form).
  const m = /^\/spreadsheets\/(?:u\/\d+\/)?d\/(e\/)?([^/]+)(?:\/|$)/.exec(url.pathname);
  if (!m) fail('That Google link is not a spreadsheet. Open the sheet and copy its link from the address bar.');
  if (m![1]) {
    fail('That is a "Publish to web" link. Use the sheet\'s own link instead (open the sheet and copy it from the address bar).');
  }
  const sheetId = m![2]!;
  if (!SHEET_ID_RE.test(sheetId)) fail('That Google Sheet link is incomplete — the sheet id is missing or cut short.');
  // DEF-365: the framework's recogniser must read the SAME sheet id from the
  // normalised link. Composed, never substituted: Nexeo's stricter rules above
  // (host, no userinfo/port, no "Publish to web", one input = one link) and the
  // gid-conflict refusal below still decide; the framework is a second opinion
  // that can only refuse more.
  const fw = frameworkParseSheetLink(url.toString());
  if (!fw || fw.published || fw.id !== sheetId) {
    fail('That Google Sheet link could not be read reliably. Open the sheet and copy its link from the address bar.');
  }

  const gid = pickGid(url);
  return { sheetId, gid, link: raw };
}

/** gid from `?gid=` and/or `#gid=`. Both present and different ⇒ refuse:
 *  which tab is meant cannot be told, and guessing is how a tab gets swapped. */
function pickGid(url: URL): string {
  const fromQuery = url.searchParams.get('gid');
  const hash = url.hash.replace(/^#/, '');
  const fromHash = new URLSearchParams(hash).get('gid');
  for (const g of [fromQuery, fromHash]) {
    if (g != null && !GID_RE.test(g)) fail('The tab id (gid) in that link is not valid. Copy the link again while the tab is open.');
  }
  if (fromQuery != null && fromHash != null && fromQuery !== fromHash) {
    fail('That link names two different tabs. Open the tab you mean and copy the link again.');
  }
  return fromQuery ?? fromHash ?? '0';
}

/**
 * Google's CSV export address for ONE tab, rebuilt from id + gid only. The
 * config may come back from the database, so it is re-validated here: a value
 * that does not match the patterns never reaches a URL.
 */
export function sheetExportUrl(cfg: Pick<GsheetSourceConfig, 'sheetId' | 'gid'>): string {
  if (!SHEET_ID_RE.test(String(cfg.sheetId ?? ''))) throw new IntegrationInputError('Stored sheet id is not valid.', 'link');
  if (!GID_RE.test(String(cfg.gid ?? ''))) throw new IntegrationInputError('Stored tab id (gid) is not valid.', 'link');
  return `https://${SHEETS_EXPORT_HOST}/spreadsheets/d/${cfg.sheetId}/export?format=csv&gid=${cfg.gid}`;
}
