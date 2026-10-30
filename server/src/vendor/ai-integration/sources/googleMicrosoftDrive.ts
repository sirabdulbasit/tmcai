/**
 * Integration Sync — assigning a spreadsheet on Google Drive or OneDrive
 * =====================================================================
 * An administrator connects their Google or Microsoft account once, picks ONE
 * workbook, and the nightly sync reads it exactly as it would read an API.
 *
 * WHY THE NARROW GOOGLE SCOPE, since it shapes the whole flow: Google classes
 * `drive`, `drive.readonly` and even `drive.metadata.readonly` as RESTRICTED —
 * an app asking for them needs a security assessment before it may be used
 * outside its own project. `drive.file` is not restricted, and it grants access
 * only to files the user themselves hands over through Google's own picker.
 * That is a smaller thing to hold, it matches what was actually asked for
 * ("assign the file"), and it means one spreadsheet rather than everything the
 * person can see. Microsoft has no equivalent gate for `Files.Read`, so the
 * OneDrive side can list files itself.
 *
 * WHAT IS STORED, and where: the refresh token goes in the integration's
 * existing encrypted secret column — it is the long-lived credential, and it is
 * the one worth protecting. Our own client id and secret come from the
 * environment, shared with the login flow, because they belong to the product
 * rather than to a tenant. File identity (id, name, sheet) sits in `auth_extra`
 * beside the probe. No new table, no schema change.
 *
 * A refresh token here is a bigger object than an API key: it can be exchanged
 * for access repeatedly, and only the user can revoke it. It is never returned
 * to a browser and never enters a prompt.
 */

import crypto from 'crypto';

/**
 * The host application's OAuth clients and public address, set once at start-up
 * with configureOAuth. Nothing is read from the environment here, so the host
 * decides where its secrets live.
 */
export interface OAuthClient { clientId: string; clientSecret: string; authUrl: string; tokenUrl: string }
export interface OAuthSettings {
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string; clientSecret: string; tenantId?: string };
  /** e.g. "https://app.example.com" — Google and Microsoft send the person back here. */
  appBaseUrl: string;
  /** The path of the host's callback route, appended to appBaseUrl. */
  callbackPath?: string;
  /** Signs the consent state; at least 32 random bytes, kept secret. */
  stateSecret: string;
}
let settings: OAuthSettings | null = null;
export const configureOAuth = (s: OAuthSettings): void => {
  if (!s.stateSecret || s.stateSecret.length < 32) throw new Error('configureOAuth: stateSecret must be at least 32 characters.');
  settings = s;
};
const need = (): OAuthSettings => {
  if (!settings) throw new Error('OAuth is not configured — call configureOAuth() at start-up.');
  return settings;
};
const googleConfig = (): OAuthClient => ({
  clientId: settings?.google?.clientId ?? '', clientSecret: settings?.google?.clientSecret ?? '',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
});
const microsoftConfig = (): OAuthClient => {
  const t = settings?.microsoft?.tenantId || 'common';
  return {
    clientId: settings?.microsoft?.clientId ?? '', clientSecret: settings?.microsoft?.clientSecret ?? '',
    authUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
  };
};

export type DriveProvider = 'google' | 'microsoft';

/** How an integration records that it reads a file rather than an endpoint. */
/** A workbook on a drive the tenant connected… */
export type DriveKind = 'gdrive' | 'onedrive';
/** …or one an administrator uploaded directly, kept by us, or a Google Sheet read through its shared link. */
export type FileSourceKind = DriveKind | 'upload' | 'gsheet';

export const PROVIDER_BY_KIND: Record<DriveKind, DriveProvider> = {
  gdrive: 'google',
  onedrive: 'microsoft',
};

export const FILE_SOURCE_KINDS: FileSourceKind[] = ['gdrive', 'onedrive', 'upload', 'gsheet'];

export const isDriveKind = (k: FileSourceKind): k is DriveKind => k === 'gdrive' || k === 'onedrive';

/** Is this integration reading a file, and from where? */
export const fileSourceKindOf = (authExtra: Record<string, unknown> | null): FileSourceKind | null => {
  const k = String(authExtra?.sourceKind ?? '').trim() as FileSourceKind;
  return (FILE_SOURCE_KINDS as string[]).includes(k) ? k : null;
};

/**
 * `drive.file` — only what the user picks. `offline` + `consent` because a
 * nightly sync needs a refresh token, and Google issues one only when both are
 * asked for explicitly; without them the integration works until the first
 * access token expires and then quietly stops.
 */
export const DRIVE_SCOPES: Record<DriveProvider, string[]> = {
  google: ['https://www.googleapis.com/auth/drive.file'],
  microsoft: ['offline_access', 'Files.Read'],
};

/**
 * Spreadsheets in Google Drive read through a signed-in account (purpose
 * 'sheets'): read-only access to the files that account can open, so a PRIVATE
 * Google Sheet or an Excel file kept in Drive is read without sharing it with
 * anyone new. drive.readonly — every file the account can open, not one picked
 * — chosen because an Excel file in Drive is not reachable through the Sheets
 * API at all, and it needs no picker. spreadsheets.readonly keeps the Sheets
 * API read of native sheets explicit; openid + email name the account.
 */
export const SHEETS_SCOPES: string[] = [
  'openid', 'email',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

export const isDriveConfigured = (provider: DriveProvider): boolean => (provider === 'google'
  ? !!(googleConfig().clientId && googleConfig().clientSecret)
  : !!(microsoftConfig().clientId && microsoftConfig().clientSecret));

const cfg = (provider: DriveProvider): OAuthClient => (provider === 'google' ? googleConfig() : microsoftConfig());

/** Where the administrator is sent to grant access. `state` ties it to this integration. */
export const buildConsentUrl = (
  provider: DriveProvider,
  state: string,
  redirectUri: string,
  scopes: string[] = DRIVE_SCOPES[provider],
): string => {
  const c = cfg(provider);
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
  });
  if (provider === 'google') {
    // Both are required for a refresh token, and "consent" must be forced or a
    // returning user is sent back with an access token only.
    p.set('access_type', 'offline');
    p.set('prompt', 'consent');
  }
  return `${c.authUrl}?${p.toString()}`;
};

interface TokenReply { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }

const postToken = async (provider: DriveProvider, body: URLSearchParams): Promise<TokenReply> => {
  const res = await fetch(cfg(provider).tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // The provider's own error names the cause — a redirect URI that does not
    // match the registration, a scope not enabled on the app — and guessing at
    // it costs an afternoon.
    throw new Error(
      `${provider === 'google' ? 'Google' : 'Microsoft'} refused the sign-in: `
      + `${res.status} ${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`,
    );
  }
  try { return JSON.parse(text) as TokenReply; } catch { throw new Error('The sign-in reply could not be read.'); }
};

/**
 * Trade the one-time code for a REFRESH token. Returning without one is a hard
 * failure rather than a warning: an integration that syncs today and stops
 * tomorrow, when the access token expires, is worse than one that never
 * connected — the first is discovered by someone noticing stale numbers.
 */
export const exchangeCodeForRefreshToken = async (
  provider: DriveProvider,
  code: string,
  redirectUri: string,
): Promise<string> => {
  const c = cfg(provider);
  const j = await postToken(provider, new URLSearchParams({
    code,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }));
  const refresh = j.refresh_token != null ? String(j.refresh_token) : '';
  if (!refresh) {
    throw new Error(
      'The sign-in did not return a lasting permission, so the nightly sync would stop working '
      + 'within the hour. Remove this app from your account\'s connected apps and connect again.',
    );
  }
  return refresh;
};

/** Access tokens are short-lived and cheap to re-mint; cache per integration. */
const accessCache = new Map<number, { token: string; expiresAt: number }>();

export const accessTokenFor = async (
  integrationId: number,
  provider: DriveProvider,
  refreshToken: string,
): Promise<string> => {
  const hit = accessCache.get(integrationId);
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit.token;

  const c = cfg(provider);
  const j = await postToken(provider, new URLSearchParams({
    refresh_token: refreshToken,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: 'refresh_token',
  }));
  const token = j.access_token != null ? String(j.access_token) : '';
  if (!token) throw new Error('The stored permission is no longer accepted — reconnect the account.');
  accessCache.set(integrationId, {
    token,
    expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000,
  });
  return token;
};

/** Forget a cached access token — used when a refresh token is replaced. */
export const forgetAccessToken = (integrationId: number): void => { accessCache.delete(integrationId); };

/** The signed-in Google account's email, shown as "Connected as …". Null when Google will not say. */
export const googleAccountEmail = async (accessToken: string): Promise<string | null> => {
  try {
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { email?: unknown };
    return typeof j.email === 'string' && j.email ? j.email : null;
  } catch { return null; }
};

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 25 MB — above the extractor's own 20 MB ceiling, so the clearer error wins. */
const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024;

const graphRoot = 'https://graph.microsoft.com/v1.0';

const callJson = async (url: string, token: string): Promise<Record<string, unknown>> => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) {
    const detail = await res.text().then((t) => t.replace(/\s+/g, ' ').trim().slice(0, 200), () => '');
    throw new Error(`The file could not be read (${res.status})${detail ? ` — ${detail}` : ''}`);
  }
  return (await res.json()) as Record<string, unknown>;
};

/**
 * What the administrator can choose from.
 *
 * Microsoft lists from the account. Google deliberately cannot: `drive.file`
 * shows only what has already been handed over, so the choosing happens in
 * Google's own picker on the page and we are given an id. Returning an empty
 * list here is therefore correct for Google, not a failure.
 */
export const listWorkbooks = async (provider: DriveProvider, token: string): Promise<DriveFile[]> => {
  if (provider === 'google') return [];
  const j = await callJson(
    `${graphRoot}/me/drive/root/search(q='.xlsx')?$select=id,name,file&$top=50`,
    token,
  );
  const items = Array.isArray(j.value) ? j.value : [];
  return items
    .map((raw) => {
      const it = raw as Record<string, unknown>;
      const file = it.file as Record<string, unknown> | undefined;
      return {
        id: String(it.id ?? ''),
        name: String(it.name ?? ''),
        mimeType: String(file?.mimeType ?? XLSX_MIME),
      };
    })
    .filter((f) => f.id && /\.(xlsx|xls|csv)$/i.test(f.name));
};

export const fileMetadata = async (
  provider: DriveProvider,
  token: string,
  fileId: string,
): Promise<DriveFile> => {
  const j = provider === 'google'
    ? await callJson(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`,
      token,
    )
    : await callJson(`${graphRoot}/me/drive/items/${encodeURIComponent(fileId)}?$select=id,name,file`, token);
  const file = j.file as Record<string, unknown> | undefined;
  return {
    id: String(j.id ?? fileId),
    name: String(j.name ?? ''),
    mimeType: String(j.mimeType ?? file?.mimeType ?? XLSX_MIME),
  };
};

/**
 * Download the workbook itself.
 *
 * A native Google Sheet has no bytes to fetch — it must be EXPORTED, and asking
 * for it with `alt=media` returns a 403 whose message is about the file being a
 * Google Doc, which reads like a permission problem and is not one.
 */
export const downloadWorkbook = async (
  provider: DriveProvider,
  token: string,
  file: DriveFile,
): Promise<Buffer> => {
  const id = encodeURIComponent(file.id);
  const url = provider === 'google'
    ? (file.mimeType === GOOGLE_SHEET_MIME
      ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`
      : `https://www.googleapis.com/drive/v3/files/${id}?alt=media`)
    : `${graphRoot}/me/drive/items/${id}/content`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = await res.text().then((t) => t.replace(/\s+/g, ' ').trim().slice(0, 200), () => '');
    throw new Error(`"${file.name}" could not be downloaded (${res.status})${detail ? ` — ${detail}` : ''}`);
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_WORKBOOK_BYTES) {
    throw new Error(`"${file.name}" is larger than 25 MB. Sync from a sheet with fewer rows.`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`"${file.name}" is empty.`);
  if (buf.length > MAX_WORKBOOK_BYTES) {
    throw new Error(`"${file.name}" is larger than 25 MB. Sync from a sheet with fewer rows.`);
  }
  return buf;
};

/** The name for this source in anything a person reads. */
export const describeFileSource = (kind: FileSourceKind, fileName?: string | null): string => {
  if (kind === 'upload') return fileName ? `${fileName} (uploaded)` : 'an uploaded spreadsheet';
  if (kind === 'gsheet') return fileName ? `${fileName} (Google Sheet link)` : 'a Google Sheet link';
  const where = kind === 'gdrive' ? 'Google Drive' : 'OneDrive';
  return fileName ? `${fileName} on ${where}` : where;
};

/* ── the round trip through the provider ──────────────────────────────────
 *
 * The administrator leaves this app, authenticates somewhere else, and comes
 * back with a code. `state` is the only thing that survives the journey, so it
 * has to say which integration the grant belongs to AND be impossible for
 * anyone else to write — otherwise a link could hand one tenant's integration a
 * refresh token for an account of the sender's choosing.
 *
 * Signed with the app's session secret, and short-lived: a consent screen left
 * open for an hour is an abandoned one, and the grant it returns is unwanted.
 */
const STATE_TTL_MS = 15 * 60 * 1000;

const sign = (payload: string): string => crypto
  .createHmac('sha256', need().stateSecret)
  .update(payload)
  .digest('base64url');

export interface ConsentState {
  integrationId: number;
  clientNumber: number;
  provider: DriveProvider;
  /** 'sheets': read Google Sheets through the account (SHEETS_SCOPES), not assign a Drive file. */
  purpose?: 'sheets';
}

export const signState = (s: ConsentState, now = Date.now()): string => {
  // The purpose rides inside the signed provider field ("google~sheets"), so
  // the format — and every state already issued — is unchanged.
  const prov = s.purpose ? `${s.provider}~${s.purpose}` : s.provider;
  const payload = [s.integrationId, s.clientNumber, prov, now + STATE_TTL_MS].join('.');
  return `${payload}.${sign(payload)}`;
};

/** Null for anything that was not signed here, or has expired. */
export const verifyState = (raw: string, now = Date.now()): ConsentState | null => {
  const parts = String(raw ?? '').split('.');
  if (parts.length !== 5) return null;
  const [id, client, provider, expiry, mac] = parts as [string, string, string, string, string];
  const payload = [id, client, provider, expiry].join('.');
  const expected = sign(payload);
  // Constant-time: a fast reject on the first wrong character leaks the signature.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  if (!Number.isFinite(Number(expiry)) || Number(expiry) < now) return null;
  if (provider === 'google~sheets') return { integrationId: Number(id), clientNumber: Number(client), provider: 'google', purpose: 'sheets' };
  if (provider !== 'google' && provider !== 'microsoft') return null;
  return { integrationId: Number(id), clientNumber: Number(client), provider };
};

/** Where the provider sends the administrator back to. Must match the registration. */
export const driveRedirectUri = (): string =>
  `${need().appBaseUrl.replace(/\/+$/, '')}${need().callbackPath ?? '/api/integrations/oauth/callback'}`;
