/**
 * Shared Web.js Chrome display-mode policy (Section 31).
 *
 * Root cause, established 2026-07-21 by matched experiment: WhatsApp
 * Web's bootstrap stalls indefinitely in headless Chrome on the
 * production host (zero WebSockets attempted), while the identical
 * launch headful under Xvfb emits the QR within seconds. Production
 * opts into headful via WHATSAPP_WEBJS_HEADFUL=1 with DISPLAY served
 * by nexeo-xvfb.service; every other environment keeps the headless
 * default.
 *
 * BOTH QR-pairing providers (WebjsProvider, UserWebjsProvider) consume
 * this helper — launch sites must not hardcode a headless flag (a
 * source-level test enforces this).
 */
import fs from 'fs';

/** headless=false ONLY on the exact value '1'; default and every other
 *  value stay headless. Bounded protocol/ops constant (AGENTS.md §2.8
 *  clarification) — not business policy, so not behaviorConfig. */
export function resolveWebjsHeadlessMode(
  env: NodeJS.ProcessEnv = process.env,
): { headless: boolean } {
  return { headless: env.WHATSAPP_WEBJS_HEADFUL === '1' ? false : true };
}

export type WebjsDisplayFailure = 'headful_display_missing' | 'headful_display_unavailable';

export class WebjsDisplayError extends Error {
  readonly code: WebjsDisplayFailure;
  constructor(code: WebjsDisplayFailure, detail: string) {
    super(`${code}: ${detail}`.slice(0, 300));
    this.name = 'WebjsDisplayError';
    this.code = code;
  }
}

/** Fail closed BEFORE client construction when headful is requested
 *  without a usable display — a missing display must surface as a
 *  typed, bounded operational error, never as another silent bootstrap
 *  timeout. Local displays (":N") are additionally verified against
 *  their X11 socket; non-local DISPLAY forms are accepted as-is (not
 *  verifiable from here). No-op in headless mode. */
export function assertHeadfulDisplayAvailable(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (resolveWebjsHeadlessMode(env).headless) return;
  const display = String(env.DISPLAY ?? '').trim();
  if (!display) {
    throw new WebjsDisplayError(
      'headful_display_missing',
      'WHATSAPP_WEBJS_HEADFUL=1 requires DISPLAY (is nexeo-xvfb.service running?)',
    );
  }
  const local = /^:(\d+)(?:\.\d+)?$/.exec(display);
  if (local && !fs.existsSync(`/tmp/.X11-unix/X${local[1]}`)) {
    throw new WebjsDisplayError(
      'headful_display_unavailable',
      `DISPLAY=${display} has no X11 socket at /tmp/.X11-unix/X${local[1]} (is nexeo-xvfb.service running?)`,
    );
  }
}
