/**
 * REQ-007 — WhatsApp channel liveness self-verification (Codex build
 * clearance 2026-07-23, with implementation locks).
 *
 * CLAIM BOUNDARY: a passed probe verifies Web.js OUTBOUND TRANSPORT +
 * LOCAL MESSAGE-EVENT ECHO liveness. It does not prove that a remote
 * sender's inbound event will fire; an external canary is out of scope
 * unless the owner authorizes one.
 *
 * The probe is operational self-chat traffic — visible on the tenant
 * phone/linked devices — carrying an opaque marker with no business or
 * user data; its content is never persisted.
 */
import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:liveness');

export type LivenessStatus = 'connected_unverified' | 'connected' | 'liveness_failed' | 'degraded';

// Protocol constants (bounded, documented; env overrides deliberately
// omitted until production evidence justifies tuning).
export const PROBE_TIMEOUT_MS = 20_000;
export const PROBE_MARKER_PREFIX = '[nexeo-liveness ';
/** Total probe attempts per DEGRADATION EPISODE (lock 4): after this,
 *  no more self-messages until manual repair or a probe pass opens a
 *  new episode. */
export const EPISODE_PROBE_CAP = 6;
/** Minimum spacing between degraded reprobes. */
export const DEGRADED_REPROBE_SPACING_MS = 30 * 60_000;

export function buildProbeMarker(nonce: string): string {
  return `${PROBE_MARKER_PREFIX}${nonce}]`;
}

export function generateProbeNonce(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

// ── Probe session: strict identity matching (lock 2) + early-echo
//    buffering with provider-id reconciliation (lock 3) ──────────────

export interface ProbeSession {
  clientNumber: string;
  generation: string;         // client-generation token — fences events only
  nonce: string;
  expectedProviderId: string | null; // set after sendMessage returns
  buffered: { providerId: string | null } | null;
  settled: boolean;
}

export function newProbeSession(clientNumber: string, generation: string, nonce: string): ProbeSession {
  return { clientNumber, generation, nonce, expectedProviderId: null, buffered: null, settled: false };
}

export interface ProbeEchoEvent {
  fromMe: boolean;
  /** Chat id of the event; self-chat means it equals the account's own id. */
  chatId: string | null;
  selfId: string | null;
  body: string;
  providerId: string | null;
  generation: string;
  clientNumber: string;
}

export type ProbeMatch = 'matched' | 'buffered' | 'rejected';

/** ALL identity evidence required (lock 2): active probe, current
 *  generation, fromMe, self-chat, exact nonce. A remote inbound whose
 *  body happens to contain the marker must never be intercepted
 *  (fromMe + self-chat gates). Provider-id reconciliation happens in
 *  reconcileProbeProviderId when the id is not yet known (lock 3). */
export function matchProbeEcho(session: ProbeSession | null, evt: ProbeEchoEvent): ProbeMatch {
  if (!session || session.settled) return 'rejected';
  if (evt.clientNumber !== session.clientNumber) return 'rejected';
  if (evt.generation !== session.generation) return 'rejected';
  if (evt.fromMe !== true) return 'rejected';
  if (!evt.selfId || !evt.chatId || evt.chatId !== evt.selfId) return 'rejected';
  if (evt.body !== buildProbeMarker(session.nonce)) return 'rejected';
  if (session.expectedProviderId != null) {
    return evt.providerId === session.expectedProviderId ? 'matched' : 'rejected';
  }
  // Early echo: sendMessage() has not returned its id yet — buffer and
  // reconcile later; never reject solely for the unknown id.
  session.buffered = { providerId: evt.providerId };
  return 'buffered';
}

/** Called when sendMessage() returns. Resolves a buffered early echo:
 *  matching (or absent) provider id passes; a MISMATCHED id fails. */
export function reconcileProbeProviderId(session: ProbeSession, providerId: string | null): 'matched' | 'pending' | 'failed' {
  session.expectedProviderId = providerId;
  if (!session.buffered) return 'pending';
  const buffered = session.buffered.providerId;
  if (providerId == null || buffered == null || buffered === providerId) return 'matched';
  return 'failed';
}

// ── Tenant-scoped counters (lock 1): generation never owns them ─────

interface TenantLiveness {
  consecutiveFailures: number;
  episodeProbeCount: number;
  episodeAlerted: boolean;
  lastProbeAt: number;
}

const tenantLiveness = new Map<string, TenantLiveness>();

function counters(clientNumber: string): TenantLiveness {
  const existing = tenantLiveness.get(clientNumber);
  if (existing) return existing;
  const fresh: TenantLiveness = { consecutiveFailures: 0, episodeProbeCount: 0, episodeAlerted: false, lastProbeAt: 0 };
  tenantLiveness.set(clientNumber, fresh);
  return fresh;
}

export function recordProbePass(clientNumber: string): void {
  // A pass starts a new healthy episode: counter reset + episode cap reset.
  tenantLiveness.set(clientNumber, { consecutiveFailures: 0, episodeProbeCount: 0, episodeAlerted: false, lastProbeAt: Date.now() });
}

export type ProbeFailureAction = 'bounded_reinit' | 'degrade' | 'hold_degraded';

/** Tenant-scoped, generation-independent (lock 1): a new client
 *  generation INHERITS the count; only recordProbePass resets it. */
export function recordProbeFailure(clientNumber: string): ProbeFailureAction {
  const c = counters(clientNumber);
  c.consecutiveFailures += 1;
  c.lastProbeAt = Date.now();
  if (c.consecutiveFailures === 1) return 'bounded_reinit';
  if (c.consecutiveFailures === 2) return 'degrade';
  return 'hold_degraded';
}

export function getConsecutiveLivenessFailures(clientNumber: string): number {
  return counters(clientNumber).consecutiveFailures;
}

/** Degraded reprobe governor (lock 4): spacing + a TOTAL episode cap.
 *  Exhausted cap ⇒ no more self-messages; manual repair or an
 *  authorized recovery action required. */
export function mayReprobe(clientNumber: string, now = Date.now()): { allowed: boolean; reason?: 'episode_cap_exhausted' | 'too_soon' } {
  const c = counters(clientNumber);
  if (c.episodeProbeCount >= EPISODE_PROBE_CAP) return { allowed: false, reason: 'episode_cap_exhausted' };
  if (now - c.lastProbeAt < DEGRADED_REPROBE_SPACING_MS && c.consecutiveFailures >= 2) {
    return { allowed: false, reason: 'too_soon' };
  }
  return { allowed: true };
}

export function noteProbeAttempt(clientNumber: string): void {
  counters(clientNumber).episodeProbeCount += 1;
}

/** One primary alert per degradation episode (lock 4). Returns true
 *  exactly once per episode. */
export function shouldAlertDegradation(clientNumber: string): boolean {
  const c = counters(clientNumber);
  if (c.episodeAlerted) return false;
  c.episodeAlerted = true;
  return true;
}

/** Test hook: never used by runtime code. */
export function __resetTenantLivenessForTests(): void {
  tenantLiveness.clear();
}

// ── Watchdog/startup decision table (lock 6) ─────────────────────────

export type LivenessDecision =
  | 'wait_for_probe' | 'bounded_reinit' | 'capped_reprobe'
  | 'withhold_for_repair' | 'none';

export function decideWatchdogAction(input: {
  status: string;
  probeInFlight: boolean;
  reprobeAllowed: boolean;
}): LivenessDecision {
  switch (input.status) {
    case 'connected_unverified':
      return input.probeInFlight ? 'wait_for_probe' : 'capped_reprobe';
    case 'liveness_failed':
      return 'bounded_reinit';
    case 'degraded':
      return input.reprobeAllowed ? 'capped_reprobe' : 'withhold_for_repair';
    case 'connected':
      return 'none';
    default:
      return 'none';
  }
}

/** Never send-capable unless exactly 'connected' (lock 6). */
export function isSendCapableStatus(status: string): boolean {
  return status === 'connected';
}

export function logLivenessTransition(clientNumber: string, detail: Record<string, unknown>): void {
  log.info('liveness transition', { clientNumber, ...detail });
}
