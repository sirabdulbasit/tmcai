/**
 * Manual, one-attempt WhatsApp Web bootstrap diagnostic.
 *
 * Usage (from server/ after build):
 *   node -r dotenv/config dist/scripts/diagnoseWebjsBootstrap.js
 *
 * This script is deliberately not scheduled and does not import Prisma or the
 * application logger. Full browser console/page errors go only to the invoking
 * operator's stdout, are bounded in count/length, and are never persisted.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { prepareVerifiedWebjsVersionCache } from '../services/whatsapp/webjsVersionCache';

export interface WebjsBootstrapDiagnosticPolicy {
  timeoutMs: number;
  errorCap: number;
  textCap: number;
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
  };
}

export function boundedDiagnosticText(raw: unknown, cap: number): string {
  const value = String(raw ?? '');
  return value.length <= cap ? value : `${value.slice(0, cap)}…[truncated]`;
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
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexeo-webjs-diagnostic-'));
  let client: any = null;
  let pagePoll: NodeJS.Timeout | null = null;
  let deadline: NodeJS.Timeout | null = null;
  let observedPage: any = null;
  let emittedErrors = 0;

  emit('diagnostic_start', {
    timeoutMs: policy.timeoutMs,
    errorCap: policy.errorCap,
    sessionRoot,
    persistence: 'stdout_only',
  });

  try {
    const cache = await prepareVerifiedWebjsVersionCache({ sessionPath: sessionRoot, env });
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
        headless: true,
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
    emit('diagnostic_complete', { ...outcome, capturedErrors: emittedErrors });
    return outcome.exitCode;
  } finally {
    if (pagePoll) clearInterval(pagePoll);
    if (deadline) clearTimeout(deadline);
    if (client) await closeClient(client);
    try { fs.rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* bounded temp cleanup */ }
  }
}

if (require.main === module) {
  runWebjsBootstrapDiagnostic().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: any) => {
    emit('diagnostic_fatal', {
      name: boundedDiagnosticText(error?.name, 100),
      message: boundedDiagnosticText(error?.message ?? error, 8_000),
      stack: boundedDiagnosticText(error?.stack, 8_000),
    });
    process.exitCode = 1;
  });
}
