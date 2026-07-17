export type WebjsInitStage =
  | 'flight_claimed'
  | 'client_created'
  | 'browser_started'
  | 'page_created'
  | 'page_reached'
  | 'provider_qr_listener_registered'
  | 'loading_screen'
  | 'qr_emitted'
  | 'authenticated'
  | 'ready';

export type BrowserErrorFingerprint =
  | 'runtime_call_timeout'
  | 'passkey_required'
  | 'missing_wa_module'
  | 'execution_context_lost'
  | 'browser_target_closed'
  | 'network_failure'
  | 'csp_violation'
  | 'javascript_type_error'
  | 'wa_bundle_boot_exception'
  | 'unknown_browser_error';

export interface WebjsInitTelemetrySnapshot {
  stage: WebjsInitStage;
  pageUrl: string | null;
  wwebVersion: string | null;
  qrListenerRegistered: boolean;
  qrEmitted: boolean;
  authenticated: boolean;
  loadingPercent: number | null;
  consoleErrors: Array<{
    at: number;
    source: 'console' | 'pageerror';
    fingerprint: BrowserErrorFingerprint;
    exceptionName?: string;
    location?: string;
  }>;
  timeline: Array<{ stage: WebjsInitStage; at: number }>;
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function getInitConsoleErrorCap(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInteger(env.WHATSAPP_WEBJS_INIT_CONSOLE_ERROR_CAP, 8, 1, 20);
}

/** Keep only origin/path. Query strings and fragments can contain auth data. */
export function safeBrowserUrl(raw: unknown): string | null {
  try {
    const parsed = new URL(String(raw));
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return `${parsed.origin}${parsed.pathname}`.slice(0, 160);
  } catch {
    return null;
  }
}

export function safeWwebVersion(raw: unknown): string | null {
  const value = String(raw ?? '');
  return /^\d+(?:\.\d+){2,3}(?:-[a-z]+)?$/i.test(value) ? value.slice(0, 80) : null;
}

/** Exception class/name only. Message and stack are intentionally discarded. */
export function safeBrowserExceptionName(raw: unknown): string | null {
  const objectName = typeof raw === 'object' && raw !== null
    ? String((raw as any).name ?? '')
    : '';
  if (/^[A-Za-z_$][A-Za-z0-9_$]{0,47}$/.test(objectName)) return objectName;
  const text = String(raw ?? '').trim();
  const match = /^(?:Uncaught(?: \(in promise\))?\s+)?([A-Za-z_$][A-Za-z0-9_$]{0,47})(?=\s*:)/.exec(text);
  return match?.[1] ?? null;
}

/**
 * Converts browser text into a fixed operational category. Raw console/page
 * error text is never retained because it may contain user content or tokens.
 */
export function fingerprintBrowserError(raw: unknown, location?: unknown): BrowserErrorFingerprint {
  const text = String((raw as any)?.message ?? raw ?? '').toLowerCase();
  if (/runtime\.callfunctionon|protocol.*tim(?:e|ed) out/.test(text)) return 'runtime_call_timeout';
  if (/passkey|webauthn|authenticator/.test(text)) return 'passkey_required';
  if (/module not found|cannot find module|waweb\w+.*undefined|window\.require/.test(text)) return 'missing_wa_module';
  if (/execution context|context.*destroyed|frame.*detached/.test(text)) return 'execution_context_lost';
  if (/target.*closed|browser.*closed|session closed/.test(text)) return 'browser_target_closed';
  if (/net::|networkerror|failed to fetch|err_(?:connection|name|internet)/.test(text)) return 'network_failure';
  if (/content security policy|refused to (?:load|execute)|csp/.test(text)) return 'csp_violation';
  if (/typeerror|referenceerror|syntaxerror/.test(text)) return 'javascript_type_error';
  const safeLocation = safeBrowserUrl(location);
  if (safeLocation?.startsWith('https://static.whatsapp.net/rsrc.php')) {
    return 'wa_bundle_boot_exception';
  }
  return 'unknown_browser_error';
}

export class WebjsInitTelemetry {
  private readonly data: WebjsInitTelemetrySnapshot;
  private readonly consoleCap: number;

  constructor(now: number = Date.now(), consoleCap: number = getInitConsoleErrorCap()) {
    this.consoleCap = Math.min(20, Math.max(1, consoleCap));
    this.data = {
      stage: 'flight_claimed', pageUrl: null, wwebVersion: null,
      qrListenerRegistered: false, qrEmitted: false, authenticated: false,
      loadingPercent: null, consoleErrors: [],
      timeline: [{ stage: 'flight_claimed', at: now }],
    };
  }

  mark(stage: WebjsInitStage, at: number = Date.now()): void {
    this.data.stage = stage;
    if (stage === 'provider_qr_listener_registered') this.data.qrListenerRegistered = true;
    if (stage === 'qr_emitted') this.data.qrEmitted = true;
    if (stage === 'authenticated') this.data.authenticated = true;
    if (this.data.timeline[this.data.timeline.length - 1]?.stage !== stage) {
      this.data.timeline.push({ stage, at });
      if (this.data.timeline.length > 16) this.data.timeline.splice(0, this.data.timeline.length - 16);
    }
  }

  setPageUrl(raw: unknown, at: number = Date.now()): void {
    const safe = safeBrowserUrl(raw);
    if (!safe) return;
    if (this.data.pageUrl === safe) return;
    this.data.pageUrl = safe;
    this.mark(safe.startsWith('https://web.whatsapp.com/') ? 'page_reached' : 'page_created', at);
  }

  setWwebVersion(raw: unknown): void {
    const safe = safeWwebVersion(raw);
    if (safe) this.data.wwebVersion = safe;
  }

  setLoadingPercent(raw: unknown, at: number = Date.now()): void {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    this.data.loadingPercent = Math.min(100, Math.max(0, Math.round(value)));
    this.mark('loading_screen', at);
  }

  recordBrowserError(
    source: 'console' | 'pageerror',
    raw: unknown,
    location?: unknown,
    at: number = Date.now(),
  ): void {
    const entry = {
      at, source, fingerprint: fingerprintBrowserError(raw, location),
      ...(safeBrowserExceptionName(raw) ? { exceptionName: safeBrowserExceptionName(raw)! } : {}),
      ...(safeBrowserUrl(location) ? { location: safeBrowserUrl(location)! } : {}),
    };
    this.data.consoleErrors.push(entry);
    if (this.data.consoleErrors.length > this.consoleCap) {
      this.data.consoleErrors.splice(0, this.data.consoleErrors.length - this.consoleCap);
    }
  }

  snapshot(): WebjsInitTelemetrySnapshot {
    return {
      ...this.data,
      consoleErrors: this.data.consoleErrors.map((entry) => ({ ...entry })),
      timeline: this.data.timeline.map((entry) => ({ ...entry })),
    };
  }
}
