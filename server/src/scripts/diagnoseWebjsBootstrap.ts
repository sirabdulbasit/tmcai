/**
 * Manual, one-attempt WhatsApp Web bootstrap diagnostic.
 *
 * Usage (from server/ after build):
 *   node -r dotenv/config dist/scripts/diagnoseWebjsBootstrap.js
 *
 * This script is deliberately not scheduled and does not import Prisma or the
 * application logger. Full browser console/page errors go only to the invoking
 * operator's stdout, are bounded in count/length, and are never persisted.
 *
 * Section 29 (2026-07-21, Codex-approved proposal): CDP network observer.
 * Production evidence: the page boots, one nonfatal storage warning, then
 * silence to timeout — while a raw curl WS upgrade to web.whatsapp.com/ws/chat
 * returns 101 from the same host. The discriminator is whether the PAGE opens
 * its WebSocket and whether the server answers on it. Classification is
 * coverage-gated (document-request-based) so a late observer can never be
 * mistaken for "no socket attempted":
 *   coverage='full'    ∧ wsCreated=0 → no_socket_attempted (conclusive)
 *   coverage='late'    ∧ wsCreated=0 → observer_late_or_inconclusive
 *   coverage='pending' ∧ wsCreated=0 → navigation_not_observed
 * Sent-frames-without-received proves DOWNSTREAM SILENCE only — host/egress
 * attribution additionally requires the matched Mac control (same webjs
 * version, timeout, and diagnostic build). Frame payload content is never
 * printed; URLs are sanitized to origin/path.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { prepareVerifiedWebjsVersionCache } from '../services/whatsapp/webjsVersionCache';
import { safeWwebVersion } from '../services/whatsapp/webjsInitTelemetry';

export interface WebjsBootstrapDiagnosticPolicy {
  timeoutMs: number;
  errorCap: number;
  textCap: number;
  /** Matched headless-vs-headful comparison (Codex-approved Xvfb
   *  experiment): '1' launches Chrome headful — requires a DISPLAY
   *  (e.g. under xvfb-run). Everything else stays identical. */
  headful: boolean;
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function getWebjsBootstrapDiagnosticPolicy(
  env: NodeJS.ProcessEnv = process.env,
): WebjsBootstrapDiagnosticPolicy {
  return {
    timeoutMs: boundedInteger(env.WHATSAPP_WEBJS_DIAGNOSTIC_TIMEOUT_MS, 120_000, 30_000, 300_000),
    errorCap: boundedInteger(env.WHATSAPP_WEBJS_DIAGNOSTIC_ERROR_CAP, 50, 1, 100),
    textCap: boundedInteger(env.WHATSAPP_WEBJS_DIAGNOSTIC_TEXT_CAP, 8_000, 500, 20_000),
    headful: env.WHATSAPP_WEBJS_DIAGNOSTIC_HEADFUL === '1',
  };
}

export function boundedDiagnosticText(raw: unknown, cap: number): string {
  const value = String(raw ?? '');
  return value.length <= cap ? value : `${value.slice(0, cap)}…[truncated]`;
}

// ── Section 29 pure helpers (exported for tests) ────────────────────

/** Sanitizer for network-observer URLs: http/https/ws/wss accepted,
 *  query strings and fragments stripped, origin+path only, 160 cap.
 *  (safeBrowserUrl in webjsInitTelemetry stays http(s)-only for its
 *  existing call sites — WS URLs need this wider one.) */
export function safeSocketUrl(raw: unknown): string | null {
  try {
    const parsed = new URL(String(raw));
    if (!/^(https?|wss?):$/.test(parsed.protocol)) return null;
    return `${parsed.origin}${parsed.pathname}`.slice(0, 160);
  } catch {
    return null;
  }
}

/** Payload BYTE length only — content is never surfaced. CDP delivers
 *  text frames (opcode 1) as UTF-8 strings and every other opcode as
 *  base64. */
export function wsPayloadByteLength(opcode: number | undefined, payloadData: unknown): number {
  const data = String(payloadData ?? '');
  if (opcode === 1) return Buffer.byteLength(data, 'utf8');
  try {
    return Buffer.from(data, 'base64').length;
  } catch {
    return 0;
  }
}

export type ObserverCoverage = 'pending' | 'full' | 'late';

export type VersionProbeStatus =
  | 'ok' | 'invalid_value' | 'page_unavailable'
  | 'probe_timeout' | 'probe_error' | 'not_attempted';

/** Page-controlled Debug.VERSION goes through the strict version
 *  validator — arbitrary page text is never printed; invalid → null
 *  with a classified status. */
export function classifyVersionProbe(input: {
  pageAvailable: boolean; timedOut?: boolean; errored?: boolean; value?: unknown;
}): { pageReportedVersion: string | null; probeStatus: VersionProbeStatus } {
  if (!input.pageAvailable) return { pageReportedVersion: null, probeStatus: 'page_unavailable' };
  if (input.errored) return { pageReportedVersion: null, probeStatus: 'probe_error' };
  if (input.timedOut) return { pageReportedVersion: null, probeStatus: 'probe_timeout' };
  const safe = safeWwebVersion(input.value);
  return safe
    ? { pageReportedVersion: safe, probeStatus: 'ok' }
    : { pageReportedVersion: null, probeStatus: 'invalid_value' };
}

/** One wweb_version_evidence line per execution, unconditional —
 *  page-unavailable and early-fatal paths emit nulls with a status
 *  instead of omitting the line. Returns whether this call emitted. */
export function makeVersionEvidenceFinalizer(
  emitFn: (kind: string, detail: Record<string, unknown>) => void,
): (evidence: {
  pinnedCacheVersion: string | null;
  pageReportedVersion: string | null;
  probeStatus: VersionProbeStatus;
}) => boolean {
  let emitted = false;
  return (evidence) => {
    if (emitted) return false;
    emitted = true;
    emitFn('wweb_version_evidence', { ...evidence });
    return true;
  };
}

export function classifyZeroSocket(coverage: ObserverCoverage):
  'no_socket_attempted' | 'observer_late_or_inconclusive' | 'navigation_not_observed' {
  if (coverage === 'full') return 'no_socket_attempted';
  if (coverage === 'late') return 'observer_late_or_inconclusive';
  return 'navigation_not_observed';
}

export type NetworkEventClass =
  | 'ws_created' | 'ws_handshake_response' | 'ws_frame_sent'
  | 'ws_frame_received' | 'ws_frame_error' | 'ws_closed' | 'request_failed';

/** Per-class stdout line caps. Tallies always count EVERY event; caps
 *  only bound the emitted lines (suppressed counts go to the summary). */
export const NETWORK_LINE_CAPS: Record<NetworkEventClass, number> = {
  ws_created: 10,
  ws_handshake_response: 10,
  ws_frame_sent: 5,
  ws_frame_received: 5,
  ws_frame_error: 10,
  ws_closed: 10,
  request_failed: 50, // replaced by policy.errorCap at runtime
};

export interface NetworkTally {
  totals: Record<NetworkEventClass, number>;
  emitted: Record<NetworkEventClass, number>;
  suppressed: Record<NetworkEventClass, number>;
}

export function newNetworkTally(): NetworkTally {
  const zero = (): Record<NetworkEventClass, number> => ({
    ws_created: 0, ws_handshake_response: 0, ws_frame_sent: 0,
    ws_frame_received: 0, ws_frame_error: 0, ws_closed: 0, request_failed: 0,
  });
  return { totals: zero(), emitted: zero(), suppressed: zero() };
}

/** Count an event; returns true when a stdout line is still allowed
 *  under that class's cap. */
export function noteNetworkEvent(
  tally: NetworkTally,
  cls: NetworkEventClass,
  caps: Record<NetworkEventClass, number> = NETWORK_LINE_CAPS,
): boolean {
  tally.totals[cls] += 1;
  if (tally.emitted[cls] < caps[cls]) {
    tally.emitted[cls] += 1;
    return true;
  }
  tally.suppressed[cls] += 1;
  return false;
}

function emit(kind: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), kind, ...detail })}\n`);
}

async function closeClient(client: any): Promise<void> {
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  await Promise.race([
    Promise.resolve(client.destroy()).catch(() => undefined),
    wait(5_000),
  ]);
  try {
    if (client.pupBrowser) {
      await Promise.race([Promise.resolve(client.pupBrowser.close()).catch(() => undefined), wait(3_000)]);
    }
  } catch { /* process exit is the final bound */ }
}

export async function runWebjsBootstrapDiagnostic(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const policy = getWebjsBootstrapDiagnosticPolicy(env);

  // Observer/tally state initialized BEFORE any fallible operation so a
  // fatal path can still emit a defined zero-state summary (approved
  // acceptance detail: exactly one summary per execution).
  const tally = newNetworkTally();
  const lineCaps: Record<NetworkEventClass, number> = { ...NETWORK_LINE_CAPS, request_failed: policy.errorCap };
  const observer: {
    attached: boolean;
    coverage: ObserverCoverage;
    evidence: { documentUrl: string; observedAt: string } | null;
  } = { attached: false, coverage: 'pending', evidence: null };
  let summaryEmitted = false;
  let outcomeReason = 'fatal_before_bootstrap';
  const versionEvidence: {
    pinnedCacheVersion: string | null;
    pageReportedVersion: string | null;
    probeStatus: VersionProbeStatus;
  } = { pinnedCacheVersion: null, pageReportedVersion: null, probeStatus: 'not_attempted' };
  const finalizeVersionEvidence = makeVersionEvidenceFinalizer(emit);
  const emitNetworkSummary = (): void => {
    if (summaryEmitted) return;
    summaryEmitted = true;
    emit('network_summary', {
      reason: outcomeReason,
      observerAttached: observer.attached,
      coverage: observer.coverage,
      coverageEvidence: observer.evidence,
      zeroSocketClass: tally.totals.ws_created === 0 ? classifyZeroSocket(observer.coverage) : null,
      totals: tally.totals,
      emittedLines: tally.emitted,
      suppressedLines: tally.suppressed,
    });
  };

  // Everything fallible — including temp-dir creation — happens inside
  // the protected lifecycle so the finalizers below fire on EVERY
  // operational path while stdout remains writable (stdout failure
  // cannot report through stdout).
  let sessionRoot: string | null = null;
  let client: any = null;
  let pagePoll: NodeJS.Timeout | null = null;
  let deadline: NodeJS.Timeout | null = null;
  let observedPage: any = null;
  let emittedErrors = 0;

  const attachNetworkObserver = async (page: any): Promise<void> => {
    try {
      const cdp = await page.target().createCDPSession();

      // requestId → sanitized URL so loadingFailed can name its victim.
      const urlById = new Map<string, string>();
      const remember = (id: unknown, url: unknown) => {
        if (typeof id !== 'string' || urlById.size >= 500) return;
        const safe = safeSocketUrl(url);
        if (safe) urlById.set(id, safe);
      };

      // Main-frame id arrives via Page.getFrameTree AFTER listener
      // registration; document events seen before it resolves are
      // buffered and re-evaluated (a document request must never be
      // missed in the gap).
      let mainFrameId: string | null = null;
      const pendingDocumentEvents: any[] = [];
      const evaluateDocumentEvent = (event: any): void => {
        if (observer.coverage !== 'pending' || !mainFrameId) return;
        if (event?.type !== 'Document' || event?.frameId !== mainFrameId) return;
        const safe = safeSocketUrl(event?.request?.url);
        if (safe && safe.startsWith('https://web.whatsapp.com')) {
          observer.coverage = 'full';
          observer.evidence = { documentUrl: safe, observedAt: new Date().toISOString() };
          emit('coverage_document_observed', { ...observer.evidence });
        }
      };

      // ALL listeners registered BEFORE Network.enable (approved
      // acceptance detail #1 — no event can slip between enablement
      // and registration).
      cdp.on('Network.requestWillBeSent', (e: any) => {
        remember(e?.requestId, e?.request?.url);
        if (mainFrameId === null) {
          if (pendingDocumentEvents.length < 50) pendingDocumentEvents.push(e);
          return;
        }
        evaluateDocumentEvent(e);
      });
      cdp.on('Network.webSocketCreated', (e: any) => {
        remember(e?.requestId, e?.url);
        if (noteNetworkEvent(tally, 'ws_created', lineCaps)) {
          emit('ws_created', { requestId: e?.requestId, url: safeSocketUrl(e?.url) });
        }
      });
      cdp.on('Network.webSocketHandshakeResponseReceived', (e: any) => {
        if (noteNetworkEvent(tally, 'ws_handshake_response', lineCaps)) {
          emit('ws_handshake_response', { requestId: e?.requestId, status: e?.response?.status });
        }
      });
      cdp.on('Network.webSocketFrameSent', (e: any) => {
        if (noteNetworkEvent(tally, 'ws_frame_sent', lineCaps)) {
          emit('ws_frame_sent', {
            requestId: e?.requestId,
            opcode: e?.response?.opcode,
            payloadBytes: wsPayloadByteLength(e?.response?.opcode, e?.response?.payloadData),
          });
        }
      });
      cdp.on('Network.webSocketFrameReceived', (e: any) => {
        if (noteNetworkEvent(tally, 'ws_frame_received', lineCaps)) {
          emit('ws_frame_received', {
            requestId: e?.requestId,
            opcode: e?.response?.opcode,
            payloadBytes: wsPayloadByteLength(e?.response?.opcode, e?.response?.payloadData),
          });
        }
      });
      cdp.on('Network.webSocketFrameError', (e: any) => {
        if (noteNetworkEvent(tally, 'ws_frame_error', lineCaps)) {
          emit('ws_frame_error', { requestId: e?.requestId, error: boundedDiagnosticText(e?.errorMessage, 300) });
        }
      });
      cdp.on('Network.webSocketClosed', (e: any) => {
        if (noteNetworkEvent(tally, 'ws_closed', lineCaps)) {
          emit('ws_closed', { requestId: e?.requestId });
        }
      });
      cdp.on('Network.loadingFailed', (e: any) => {
        if (noteNetworkEvent(tally, 'request_failed', lineCaps)) {
          emit('request_failed', {
            url: urlById.get(e?.requestId) ?? null,
            type: e?.type,
            errorText: boundedDiagnosticText(e?.errorText, 300),
            blockedReason: e?.blockedReason ?? null,
            canceled: e?.canceled === true,
          });
        }
      });

      await cdp.send('Network.enable');

      // Supported CDP surface for the main frame id (approved acceptance
      // detail #2 — no Puppeteer private fields).
      const frameTree: any = await cdp.send('Page.getFrameTree').catch(() => null);
      mainFrameId = frameTree?.frameTree?.frame?.id ?? null;
      for (const buffered of pendingDocumentEvents) evaluateDocumentEvent(buffered);
      pendingDocumentEvents.length = 0;

      // Late detection: page already navigated to WhatsApp without the
      // observer having seen the document request.
      if (observer.coverage === 'pending') {
        const current = safeSocketUrl(page.url?.());
        if (current && current.startsWith('https://web.whatsapp.com')) {
          observer.coverage = 'late';
          emit('coverage_late', { url: current });
        }
      }

      observer.attached = true;
      emit('network_observer_attached', { mainFrameKnown: mainFrameId !== null });
    } catch (error: any) {
      emit('network_observer_error', { message: boundedDiagnosticText(error?.message ?? error, 300) });
    }
  };

  try {
    sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexeo-webjs-diagnostic-'));
    emit('diagnostic_start', {
      timeoutMs: policy.timeoutMs,
      errorCap: policy.errorCap,
      headful: policy.headful,
      sessionRoot,
      persistence: 'stdout_only',
    });

    const cache = await prepareVerifiedWebjsVersionCache({ sessionPath: sessionRoot, env });
    versionEvidence.pinnedCacheVersion = cache.version;
    emit('verified_cache', {
      version: cache.version,
      sha256: cache.sha256,
      expiresAt: cache.expiresAt,
    });

    const imported: any = await import('whatsapp-web.js' as string);
    const Client = imported.Client || imported.default?.Client;
    const LocalAuth = imported.LocalAuth || imported.default?.LocalAuth;
    if (!Client || !LocalAuth) throw new Error('whatsapp-web.js Client/LocalAuth unavailable');

    const executablePath = env.PUPPETEER_EXECUTABLE_PATH
      || env.CHROME_PATH
      || (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : process.platform === 'win32'
          ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
          : '/usr/bin/google-chrome-stable');

    client = new Client({
      authStrategy: new LocalAuth({ clientId: 'bounded-bootstrap-diagnostic', dataPath: sessionRoot }),
      webVersion: cache.version,
      webVersionCache: cache.webVersionCache,
      puppeteer: {
        headless: !policy.headful,
        executablePath,
        protocolTimeout: policy.timeoutMs,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--no-first-run', '--no-zygote', '--disable-gpu'],
      },
    });

    let resolveOutcome!: (value: { outcome: string; exitCode: number }) => void;
    let outcomeSettled = false;
    const eventOutcome = new Promise<{ outcome: string; exitCode: number }>((resolve) => {
      resolveOutcome = resolve;
    });
    const settleOutcome = (value: { outcome: string; exitCode: number }) => {
      if (outcomeSettled) return;
      outcomeSettled = true;
      resolveOutcome(value);
    };
    client.on('loading_screen', (percent: number, message: string) => {
      emit('loading_screen', { percent, label: boundedDiagnosticText(message, 200) });
    });
    client.on('qr', () => {
      emit('qr_emitted', { qrContentPrinted: false });
      settleOutcome({ outcome: 'qr_emitted', exitCode: 0 });
    });
    client.on('authenticated', () => emit('authenticated'));
    client.on('ready', () => {
      emit('ready');
      settleOutcome({ outcome: 'ready', exitCode: 0 });
    });
    client.on('auth_failure', (error: unknown) => {
      emit('auth_failure', { error: boundedDiagnosticText(error, policy.textCap) });
      settleOutcome({ outcome: 'auth_failure', exitCode: 2 });
    });

    pagePoll = setInterval(() => {
      const page = client?.pupPage;
      if (!page || page === observedPage) return;
      observedPage = page;
      emit('page_attached', { url: page.url?.() });
      void attachNetworkObserver(page);
      page.on('console', (entry: any) => {
        if (entry?.type?.() !== 'error' || emittedErrors >= policy.errorCap) return;
        emittedErrors += 1;
        emit('browser_console_error', {
          index: emittedErrors,
          text: boundedDiagnosticText(entry.text?.(), policy.textCap),
          location: entry.location?.(),
        });
      });
      page.on('pageerror', (error: any) => {
        if (emittedErrors >= policy.errorCap) return;
        emittedErrors += 1;
        emit('browser_page_error', {
          index: emittedErrors,
          name: boundedDiagnosticText(error?.name, 100),
          message: boundedDiagnosticText(error?.message ?? error, policy.textCap),
          stack: boundedDiagnosticText(error?.stack, policy.textCap),
        });
      });
    }, 25);

    void Promise.resolve(client.initialize()).then(
      () => settleOutcome({ outcome: 'initialize_resolved', exitCode: 0 }),
      (error: any) => {
        if (outcomeSettled) return;
        emit('initialize_error', {
          name: boundedDiagnosticText(error?.name, 100),
          message: boundedDiagnosticText(error?.message ?? error, policy.textCap),
          stack: boundedDiagnosticText(error?.stack, policy.textCap),
        });
        settleOutcome({ outcome: 'initialize_error', exitCode: 2 });
      },
    );
    deadline = setTimeout(() => settleOutcome({ outcome: 'timeout', exitCode: 3 }), policy.timeoutMs);
    const outcome = await eventOutcome;
    outcomeReason = outcome.outcome;
    // Version evidence (Codex condition): pinned cache version vs the
    // page-reported live version, recorded EVERY run. A page-reported
    // version alone does NOT prove the pin was consumed.
    if (observedPage) {
      const timeoutMarker: unknown = Symbol('probe_timeout');
      let errored = false;
      let probeTimer: NodeJS.Timeout | null = null;
      const raced: unknown = await Promise.race([
        Promise.resolve(observedPage.evaluate(() => (globalThis as any).Debug?.VERSION ?? null))
          .catch(() => { errored = true; return null; }),
        new Promise((resolve) => { probeTimer = setTimeout(() => resolve(timeoutMarker), 3_000); }),
      ]).catch(() => { errored = true; return null; });
      if (probeTimer) clearTimeout(probeTimer);
      Object.assign(versionEvidence, classifyVersionProbe({
        pageAvailable: true,
        errored,
        timedOut: raced === timeoutMarker,
        value: raced === timeoutMarker ? null : raced,
      }));
    } else {
      Object.assign(versionEvidence, classifyVersionProbe({ pageAvailable: false }));
    }
    emit('diagnostic_complete', { ...outcome, capturedErrors: emittedErrors });
    return outcome.exitCode;
  } finally {
    // Exactly ONE summary + ONE version-evidence line per execution,
    // on every path (approved acceptance detail #3), emitted BEFORE
    // client destruction.
    finalizeVersionEvidence(versionEvidence);
    emitNetworkSummary();
    if (pagePoll) clearInterval(pagePoll);
    if (deadline) clearTimeout(deadline);
    if (client) await closeClient(client);
    if (sessionRoot) {
      try { fs.rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* bounded temp cleanup */ }
    }
  }
}

if (require.main === module) {
  runWebjsBootstrapDiagnostic().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: any) => {
    // The finally block above already emitted the single summary.
    emit('diagnostic_fatal', {
      name: boundedDiagnosticText(error?.name, 100),
      message: boundedDiagnosticText(error?.message ?? error, 8_000),
      stack: boundedDiagnosticText(error?.stack, 8_000),
    });
    process.exitCode = 1;
  });
}
