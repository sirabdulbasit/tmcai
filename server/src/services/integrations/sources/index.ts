/**
 * DEF-362 — Integrations Stage 1b: the source router.
 *
 * The run engine, the proposer and the Connect step read "this integration's
 * source" without knowing what kind it is: readSource / testSource dispatch on
 * source_kind to the Google Sheet reader (Stage 1, unchanged) or the API
 * reader (Stage 1b), or the uploaded-file reader (DEF-368). One dispatch point, so a new kind (Stage 4: Qlik, Odoo)
 * is added here and nowhere else, and no caller can pick the wrong reader.
 *
 * Model-free (the engine imports it).
 */
import { readGsheet, testGsheet } from './gsheetReader';
import { readApi, readApiConfig, testApi } from './apiReader';
import { readFile, readFileConfig, testFile } from './fileReader';
import { IntegrationInputError, type GsheetSourceConfig, type ReadResult, type TestResult } from '../types';

/** The columns of an integration row (or its DTO) a reader needs. */
export interface SourceRow {
  id: string;
  /** Absent ⇒ 'gsheet', the column's default (every Stage 1 row). */
  sourceKind?: string;
  sourceConfig: unknown;
  apiConfig?: unknown;
}

/** Which input field the admin must fill in when the source is not set up. */
export type SourceField = 'link' | 'apiConfig' | 'sourceKind' | 'file';

/** The stored sheet config, or null. Same rule as integrationStore.readSourceConfig
 *  (sheetId + explicit gid); kept here so the router depends on the readers
 *  only, never on the store that itself imports the sheet link parser. */
function sheetConfigOf(raw: unknown): GsheetSourceConfig | null {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (typeof c.sheetId !== 'string' || !c.sheetId || typeof c.gid !== 'string') return null;
  return {
    sheetId: c.sheetId,
    gid: c.gid,
    link: typeof c.link === 'string' ? c.link : '',
    ...(typeof c.tabLabel === 'string' && c.tabLabel ? { tabLabel: c.tabLabel } : {}),
  };
}

const kindOf = (row: SourceRow): string => row.sourceKind ?? 'gsheet';

/**
 * Null when the row has a usable source; otherwise what is missing, in admin
 * words, and the field to point at. Checked before any read so a half-set-up
 * integration fails with "connect X first", never with a reader crash.
 */
export function sourceProblem(row: SourceRow): { message: string; field: SourceField } | null {
  const kind = kindOf(row);
  if (kind === 'gsheet') {
    return sheetConfigOf(row.sourceConfig) ? null : { message: 'Paste the Google Sheet link first.', field: 'link' };
  }
  if (kind === 'api') {
    return readApiConfig(row.apiConfig)
      ? null
      : { message: 'Set up the API connection (an https base URL, endpoint and records path) first.', field: 'apiConfig' };
  }
  if (kind === 'file') {
    return readFileConfig(row.sourceConfig)
      ? null
      : { message: 'Upload the spreadsheet (.xlsx, .xls or .csv) first.', field: 'file' };
  }
  return { message: `Unknown source kind "${kind}".`, field: 'sourceKind' };
}

function requireSource(row: SourceRow): void {
  const p = sourceProblem(row);
  if (p) throw new IntegrationInputError(p.message, p.field);
}

/** Every record of the source (caps apply). Throws on a failed read — the
 *  caller turns that into a FAILED run / a proposal error. */
export async function readSource(cn: string, row: SourceRow): Promise<ReadResult> {
  requireSource(row);
  if (kindOf(row) === 'api') {
    return readApi(cn, { id: row.id, sourceKind: 'api', apiConfig: readApiConfig(row.apiConfig)! });
  }
  if (kindOf(row) === 'file') return readFile(cn, { id: row.id, sourceConfig: readFileConfig(row.sourceConfig)! });
  return readGsheet(cn, sheetConfigOf(row.sourceConfig)!);
}

/** The Connect-step test. Never throws for a bad connection (ok:false + reason);
 *  throws IntegrationInputError when no source is set up at all. */
export async function testSource(cn: string, row: SourceRow): Promise<TestResult> {
  requireSource(row);
  if (kindOf(row) === 'api') {
    return testApi(cn, { id: row.id, sourceKind: 'api', apiConfig: readApiConfig(row.apiConfig)! });
  }
  if (kindOf(row) === 'file') return testFile(cn, { id: row.id, sourceConfig: readFileConfig(row.sourceConfig)! });
  return testGsheet(cn, sheetConfigOf(row.sourceConfig)!);
}
