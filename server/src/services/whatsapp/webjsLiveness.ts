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
import { normalizeWid } from './waIdentity';

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
  /**
   * REQ-009: EVERY id that denotes this account — its phone Wid and its
   * LID Wid (see waIdentity.resolveSelfIds). WhatsApp may stamp the echo
   * of a self-chat send with either one, so matching a single id is what
   * made every §34 probe fail and wedged the channel `degraded`.
   *
   * The self-chat requirement of lock 2 is UNCHANGED in strength: the
   * echo must still be in this account's own chat. What widens is only
   * the set of spellings that count as "this account". Absent/empty →
   * falls back to `selfId`, so existing callers keep prior behaviour.
   */
  selfIds?: string[] | null;
  body: string;
  providerId: string | null;
  generation: string;
  clientNumber: string;
}

export type ProbeMatch = 'matched' | 'buffered' | 'rejected';

/**
 * Is this echo in the account's OWN chat? (lock 2, @lid-aware.)
 *
 * Compares the event's chat id against every known spelling of this
 * account, normalized for multi-device suffix and case. A chat belonging
 * to anyone else still fails, which is what the gate is there for.
 */
function isOwnChat(evt: ProbeEchoEvent): boolean {
  const chat = normalizeWid(evt.chatId);
  if (!chat) return false;
  const candidates = (evt.selfIds && evt.selfIds.length > 0 ? evt.selfIds : [evt.selfId])
    .map(normalizeWid)
    .filter((id) => id.length > 0);
  if (candidates.length === 0) return false;
  return candidates.includes(chat);
}

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
  if (!isOwnChat(evt)) return 'rejected';
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

/**
 * REQ-009 — real outbound traffic RE-ARMS the probe episode.
 *
 * THE DEADLOCK THIS BREAKS (production, 07-24 → 07-28):
 * Three flags withheld the channel — `statusMap='degraded'` (blocks
 * sends), `requiresRepair` (blocks re-init), and an exhausted episode cap
 * (blocks probes). Every one of them cleared ONLY via recordProbePass,
 * which needs a probe, which the cap forbade. A closed loop with no exit,
 * and the independent alert path (SMTP) was itself broken — so it sat
 * wedged for four days while the client was demonstrably alive and
 * answering the owner over the same transport.
 *
 * A user-visible outbound message that the provider ACCEPTED is direct,
 * unfaked evidence that outbound transport works. Discarding that while
 * trusting only a synthetic self-chat probe is what made the outage
 * unrecoverable. So real success re-opens the probe budget.
 *
 * DELIBERATELY NOT a promotion to `connected` (lock 6 intact): a real
 * send proves the transport limb, not the local-echo limb, and the probe
 * remains the sole authority on send-capability. This only restores the
 * system's RIGHT TO RETRY.
 *
 * Bounded by construction: re-arming needs a genuine accepted send, and
 * each re-arm buys at most EPISODE_PROBE_CAP probes with the normal
 * spacing restored after the first. Traffic cannot induce a probe storm.
 *
 * @returns true when this call actually restored an exhausted budget.
 */
export function recordOutboundProof(clientNumber: string): boolean {
  const c = counters(clientNumber);
  const wasExhausted = c.episodeProbeCount >= EPISODE_PROBE_CAP;
  c.episodeProbeCount = 0;
  c.episodeAlerted = false;
  // Let the next reprobe happen immediately rather than waiting out the
  // degraded spacing window — we have fresh evidence worth acting on.
  c.lastProbeAt = 0;
  // consecutiveFailures is left INTACT on purpose: the probe really did
  // fail that many times, and only a probe pass may erase probe history.
  if (wasExhausted) {
    log.info('probe budget re-armed by confirmed outbound traffic', {
      clientNumber, consecutiveFailures: c.consecutiveFailures,
    });
  }
  return wasExhausted;
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
