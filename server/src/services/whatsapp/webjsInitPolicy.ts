export type WebjsInitFailureClass = 'init_timeout' | 'init_failed';

export interface WebjsInitPolicy {
  protocolTimeoutMs: number;
  initDeadlineMs: number;
  timeoutEscalationCount: number;
}

const DEFAULT_PROTOCOL_TIMEOUT_MS = 240_000;
const DEFAULT_INIT_DEADLINE_MS = 270_000;
const DEFAULT_TIMEOUT_ESCALATION_COUNT = 3;

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * Production-safe Web.js initialization limits. Environment overrides are
 * intentionally bounded so a typo cannot create an unending Chromium init or
 * an aggressive restart loop.
 */
export function getWebjsInitPolicy(env: NodeJS.ProcessEnv = process.env): WebjsInitPolicy {
  const protocolTimeoutMs = boundedInteger(
    env.WHATSAPP_WEBJS_PROTOCOL_TIMEOUT_MS,
    DEFAULT_PROTOCOL_TIMEOUT_MS,
    60_000,
    600_000,
  );
  const configuredDeadline = boundedInteger(
    env.WHATSAPP_WEBJS_INIT_DEADLINE_MS,
    DEFAULT_INIT_DEADLINE_MS,
    90_000,
    660_000,
  );
  return {
    protocolTimeoutMs,
    // The lifecycle deadline must outlive Puppeteer's own timeout so its
    // classified error normally wins before the watchdog may replace it.
    initDeadlineMs: Math.max(configuredDeadline, protocolTimeoutMs + 30_000),
    timeoutEscalationCount: boundedInteger(
      env.WHATSAPP_WEBJS_TIMEOUT_ESCALATION_COUNT,
      DEFAULT_TIMEOUT_ESCALATION_COUNT,
      2,
      5,
    ),
  };
}

export function classifyWebjsInitFailure(error: unknown): WebjsInitFailureClass {
  const message = String((error as any)?.message ?? error ?? '').toLowerCase();
  return /protocoltimeout|protocol timeout|runtime\.callfunctionon timed out|timed out.*protocol|protocol.*timed out/.test(message)
    ? 'init_timeout'
    : 'init_failed';
}

/** Bounded retry delay for protocol timeouts: 30s, 2m, then 5m. */
export function initTimeoutRetryDelayMs(consecutiveTimeouts: number): number {
  const delays = [30_000, 120_000, 300_000];
  return delays[Math.min(Math.max(1, consecutiveTimeouts), delays.length) - 1];
}

export function watchdogInitDeferral(
  status: string,
  init: { deadlineAt?: number | null; retryAt?: number | null; requiresRepair?: boolean } | undefined,
  now: number = Date.now(),
): 'connecting' | 'backoff' | 'repair_required' | null {
  if (status === 'connecting' && init?.deadlineAt && now < init.deadlineAt) return 'connecting';
  if (status === 'init_timeout' && init?.requiresRepair) return 'repair_required';
  if (status === 'init_timeout' && init?.retryAt && now < init.retryAt) return 'backoff';
  return null;
}
