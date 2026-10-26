/**
 * DEF-354 — Integrations Stage 1: read one Google Sheet tab as records.
 *
 * Spec INTEGRATIONS_DESIGN.md §2.2. Ported from vm integrationSheetLink.ts
 * (downloadSheetLink / readCapped) and integrationSheetSource.ts
 * (readLinkedSheet), with Nexeo's account model:
 *
 *  - The address is ALWAYS sheetExportUrl(id, gid): host docs.google.com, the
 *    CSV export of exactly that tab. Redirects are followed by hand and only to
 *    Google hosts; the bearer token is sent to docs.google.com and nowhere else.
 *  - Private sheets are read through the tenant's designated Google account
 *    (system_config.google_drive_org_user_id — the account the admin chose,
 *    an active user of THIS tenant) and through nothing else. Unlike
 *    folderScribeService.pickTenantScribeUser there is NO fallback to "any
 *    user with a connected Google connector": that would read a private sheet
 *    with an employee's personal token. No new consent, no per-integration
 *    token. With no account, the read is anonymous ("anyone with the link").
 *  - The account is resolved OUTSIDE the request's user scope
 *    (userId: null): UserConnector is user-scoped, and under an admin's
 *    request the guard would hide the designated user's token — so the
 *    connection test, the proposal, a manual run and a scheduled run would use
 *    different credentials. Every path resolves the same account.
 *  - If the account's token cannot be obtained, an anonymous read is still
 *    tried (a public sheet needs no account); if THAT is refused, the run fails
 *    with the credential reason (CredentialUnreadableError). Nothing falls back
 *    to a different person's account.
 *  - Caps (behavior integrations.sheet_max_bytes / sheet_timeout_ms /
 *    max_rows): the body is streamed and never buffered past the byte cap —
 *    one tenant's sheet must not fill memory every tenant shares (vm readCapped).
 *    A cap reached is a TRUNCATED read (the run is PARTIAL), not a silent one.
 *  - Google answers an unshared sheet with its sign-in page, not an error code:
 *    an HTML answer (or a redirect to accounts.google.com) = "not shared".
 *  - testGsheet reads for real; a 200 with 0 data rows is NOT ok.
 *
 * No model is called here.
 */
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { runInTenantScope } from '../../../db/tenantContext';
import { getBehaviorValue } from '../../behaviorConfig';
import {
  CredentialUnreadableError,
  type GsheetReaderModule,
  type GsheetSourceConfig,
  type IntegrationSourceRef,
  type ReadResult,
  type SourceReader,
  type TestResult,
} from '../types';
import { csvToRecords } from './csv';
import { SHEETS_EXPORT_HOST, parseSheetLink as parseLink, sheetExportUrl } from './sheetLink';

const log = createLogger('integrations-gsheet');

const MAX_REDIRECTS = 5;

/** A read that could not produce records, in words the admin can act on.
 *  The run engine records `message` as the run error; testGsheet as `reason`. */
export class GsheetReadError extends Error {
  readonly code = 'GSHEET_READ';
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GsheetReadError';
  }
}

const NOT_SHARED_PUBLIC = 'Google did not hand over the sheet — it is not shared with everyone who has the link, '
  + 'and no Google account is designated for this workspace. Either share it (Share → General access → '
  + '"Anyone with the link" → Viewer), or designate a Google account under Admin → Client Connectors and share the sheet with it.';
const NOT_SHARED_ACCOUNT = 'Google did not hand over the sheet — the workspace\'s designated Google account cannot open it '
  + '(sign-in needed or no access). Share the sheet with that account, or as "Anyone with the link" → Viewer.';

/** Hosts a Google export may redirect to. Anything else is refused. */
const isGoogleContentHost = (host: string): boolean =>
  host === SHEETS_EXPORT_HOST || host.endsWith('.googleusercontent.com');
const isSignInHost = (host: string): boolean => host === 'accounts.google.com';

/**
 * The tenant's designated Google account, as a bearer token.
 *  - { token: null, userId: null }  — no account designated: read anonymously.
 *  - { token: null, userId, error }  — designated but unreadable.
 */
export async function designatedGoogleUserId(cn: string): Promise<number | null> {
  const cfg = await prisma.systemConfig.findFirst({
    where: { clientNumber: cn, key: 'google_drive_org_user_id' }, select: { value: true },
  });
  const id = cfg?.value ? parseInt(cfg.value, 10) : NaN;
  if (!Number.isFinite(id)) return null;
  const u = await prisma.user.findFirst({ where: { id, clientNumber: cn, isActive: true }, select: { id: true } });
  return u?.id ?? null;
}

/** Tenant-scoped, user-unscoped: the same account whoever (or nothing) triggered the read. */
function resolveAccountToken(cn: string): Promise<{ token: string | null; userId: number | null; error?: string }> {
  return runInTenantScope({ clientNumber: cn, userId: null, bypass: false }, () => resolveAccountTokenUnscoped(cn));
}

async function resolveAccountTokenUnscoped(cn: string): Promise<{ token: string | null; userId: number | null; error?: string }> {
  let userId: number | null;
  try {
    userId = await designatedGoogleUserId(cn);
  } catch (err) {
    log.warn('designated Google account lookup failed', { clientNumber: cn, error: err instanceof Error ? err.message : String(err) });
    return { token: null, userId: null, error: 'The designated Google account could not be looked up just now. Try again in a moment.' };
  }
  if (userId == null) return { token: null, userId: null };
  try {
    const { getAuthenticatedClient } = await import('../../integrationService');
    const auth = await getAuthenticatedClient(userId);
    if (!auth.client) {
      return { token: null, userId, error: `The designated Google account could not be used: ${auth.error ?? 'no Google connection'}.` };
    }
    const at = await auth.client.getAccessToken();
    const token = typeof at === 'string' ? at : at?.token;
    if (!token) return { token: null, userId, error: 'The designated Google account has no usable sign-in. Reconnect it under Connectors.' };
    return { token, userId };
  } catch (err) {
    return {
      token: null,
      userId,
      error: `The designated Google account's sign-in could not be read (${err instanceof Error ? err.message : 'unknown error'}). Reconnect it under Connectors.`,
    };
  }
}

/**
 * Read a response body only up to `max` bytes — never the whole of a larger
 * body (vm readCapped). Returns the bytes read and whether the cap cut it.
 */
export async function readCapped(res: Response, max: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!res.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > max) {
      parts.push(value.subarray(0, max - n));
      n = max;
      await reader.cancel().catch(() => {});
      return { bytes: Buffer.concat(parts), truncated: true };
    }
    parts.push(value);
    n += value.length;
  }
  return { bytes: Buffer.concat(parts), truncated: false };
}

/** The file's name from Google's Content-Disposition (vm nameFromDisposition). */
export function nameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) { try { return decodeURIComponent(star[1]!.trim()); } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1]!.trim() : null;
}

type Fetched =
  | { kind: 'ok'; res: Response }
  | { kind: 'refused'; status: number }   // 401/403/HTML/sign-in redirect
  | { kind: 'error'; message: string; status?: number };

/** One export fetch, following at most MAX_REDIRECTS redirects by hand. */
async function fetchExport(url: string, token: string | null, timeoutMs: number): Promise<Fetched> {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = new URL(current).hostname.toLowerCase();
    const headers: Record<string, string> = { Accept: 'text/csv' };
    // The token goes to Google's sheet host only — never to a redirect target.
    if (token && host === SHEETS_EXPORT_HOST) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(current, { headers, redirect: 'manual', signal });
    } catch (err) {
      const timedOut = (err as { name?: string })?.name === 'TimeoutError' || signal.aborted;
      return {
        kind: 'error',
        message: timedOut
          ? `Google Sheets did not answer within ${Math.round(timeoutMs / 1000)} s.`
          : `Google Sheets could not be reached (${err instanceof Error ? err.message : 'no answer'}).`,
      };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!loc) return { kind: 'error', message: `Google Sheets answered ${res.status} without a destination.`, status: res.status };
      let next: URL;
      try { next = new URL(loc, current); } catch {
        return { kind: 'error', message: 'Google Sheets redirected to an address that is not valid.', status: res.status };
      }
      const nextHost = next.hostname.toLowerCase();
      if (isSignInHost(nextHost)) return { kind: 'refused', status: res.status };
      if (next.protocol !== 'https:' || !isGoogleContentHost(nextHost)) {
        return { kind: 'error', message: `Google Sheets redirected outside Google (${nextHost}); the read was stopped.`, status: res.status };
      }
      current = next.toString();
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      return { kind: 'refused', status: res.status };
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return { kind: 'error', message: 'That Google Sheet was not found — check the link.', status: 404 };
    }
    if (res.status === 400) {
      await res.body?.cancel().catch(() => {});
      return { kind: 'error', message: 'Google refused to export this tab — it may have been deleted. Copy the link again while the tab is open.', status: 400 };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { kind: 'error', message: `Google Sheets answered ${res.status} for this sheet.`, status: res.status };
    }
    if (/text\/html/i.test(res.headers.get('content-type') ?? '')) {
      await res.body?.cancel().catch(() => {});
      return { kind: 'refused', status: res.status };
    }
    return { kind: 'ok', res };
  }
  return { kind: 'error', message: 'Google Sheets redirected too many times; the read was stopped.' };
}

const looksLikeHtml = (text: string): boolean => /^\s*<(?:!doctype\s+html|html[\s>])/i.test(text.slice(0, 512));

function labelFor(cfg: GsheetSourceConfig, disposition: string | null): string {
  const file = nameFromDisposition(disposition)?.replace(/\.csv$/i, '').trim();
  const base = file || 'Google Sheet';
  if (cfg.tabLabel && !base.includes(cfg.tabLabel)) return `${base} › ${cfg.tabLabel}`;
  if (!file && !cfg.tabLabel) return `${base} (tab ${cfg.gid})`;
  return base;
}

export const readGsheet: GsheetReaderModule['readGsheet'] = async (cn, cfg) => {
  const ctx = { clientNumber: cn };
  const [maxBytes, timeoutMs, maxRows] = await Promise.all([
    getBehaviorValue('integrations.sheet_max_bytes', ctx),
    getBehaviorValue('integrations.sheet_timeout_ms', ctx),
    getBehaviorValue('integrations.max_rows', ctx),
  ]);
  const url = sheetExportUrl(cfg);
  const account = await resolveAccountToken(cn);

  let got = await fetchExport(url, account.token, timeoutMs);
  // Refused WITH a token: a stale/revoked token is answered 401 even for an
  // "anyone with the link" sheet, so try once anonymously — that is no
  // account at all, never somebody else's. Still refused ⇒ the account
  // cannot open it. A token we could not get was already an anonymous read.
  if (got.kind === 'refused' && account.token) {
    const anon = await fetchExport(url, null, timeoutMs);
    if (anon.kind === 'ok') got = anon;
  }
  if (got.kind === 'refused') {
    if (account.error) throw new CredentialUnreadableError(account.error);
    throw new GsheetReadError(account.token ? NOT_SHARED_ACCOUNT : NOT_SHARED_PUBLIC, got.status);
  }
  if (got.kind === 'error') throw new GsheetReadError(got.message, got.status);

  let bytes: Buffer;
  let cut: boolean;
  try {
    ({ bytes, truncated: cut } = await readCapped(got.res, maxBytes));
  } catch (err) {
    // The fetch's timeout signal also aborts the body stream: a slow sheet
    // fails here, mid-download, and must read as the same plain message.
    const timedOut = (err as { name?: string })?.name === 'TimeoutError' || (err as { name?: string })?.name === 'AbortError';
    throw new GsheetReadError(timedOut
      ? `Google Sheets did not finish sending the sheet within ${Math.round(timeoutMs / 1000)} s.`
      : `The sheet download was interrupted (${err instanceof Error ? err.message : 'no answer'}).`);
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  if (looksLikeHtml(text)) {
    if (account.error) throw new CredentialUnreadableError(account.error);
    throw new GsheetReadError(account.token ? NOT_SHARED_ACCOUNT : NOT_SHARED_PUBLIC);
  }

  const parsed = csvToRecords(text, {
    maxRows,
    cutByBytes: cut,
    bytesReason: `The sheet is larger than ${Math.round(maxBytes / (1024 * 1024) * 10) / 10} MB; only the first part was read.`,
  });
  const sourceLabel = labelFor(cfg, got.res.headers.get('content-disposition'));
  log.info('gsheet read', {
    clientNumber: cn, sheetId: cfg.sheetId, gid: cfg.gid, viaAccount: !!account.token,
    rows: parsed.rowCount, bytes: bytes.length, truncated: parsed.truncated,
  });
  return { ...parsed, sourceLabel } satisfies ReadResult;
};

export const testGsheet: GsheetReaderModule['testGsheet'] = async (cn, cfg) => {
  try {
    const r = await readGsheet(cn, cfg);
    if (!r.headers.length) {
      return { ok: false, rows: 0, columns: [], sampleRow: null, reason: 'The sheet tab is empty — it has no header row.' };
    }
    if (r.rowCount === 0) {
      return {
        ok: false, rows: 0, columns: r.headers, sampleRow: null,
        reason: 'The sheet tab has a header row but no data rows. Check the link points at the tab with the numbers.',
      };
    }
    return { ok: true, rows: r.rowCount, columns: r.headers, sampleRow: r.records[0] ?? null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'The sheet could not be read.';
    log.warn('gsheet test failed', { clientNumber: cn, sheetId: cfg.sheetId, gid: cfg.gid, reason });
    return { ok: false, rows: 0, columns: [], sampleRow: null, reason } satisfies TestResult;
  }
};

export const parseSheetLink: GsheetReaderModule['parseSheetLink'] = parseLink;

/** The SourceReader the engine and the Connect step use for `gsheet`. */
export const gsheetSource: SourceReader = {
  test: (cn: string, integ: IntegrationSourceRef) => testGsheet(cn, integ.sourceConfig),
  read: (cn: string, integ: IntegrationSourceRef) => readGsheet(cn, integ.sourceConfig),
};
