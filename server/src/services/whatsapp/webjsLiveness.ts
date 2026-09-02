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
/** DEF-276d — waits before each delete attempt. Off the critical path, so patience is free. */
/**
 * DEF-276e — ONE attempt, not a backoff. The retries were added for a store-race hypothesis
 * that the evidence then disproved: with `[0, 500, 1500, 4000]` every attempt failed
 * identically, so the failure is deterministic and retrying only wrote eight warn lines and
 * held a promise for six seconds per reconnect.
 */
export const PROBE_CLEANUP_BACKOFF_MS = [0];
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

/**
 * DEF-276b — remove the probe's own message, correctly, after a pass.
 *
 * The first version of this read a `sentProbeMessage` variable assigned when `client.sendMessage`
 * resolved — and then did nothing at all in production. The probe passes on the EARLY ECHO,
 * which on a healthy connection beats the send promise: the observed pass took 162ms and the
 * cleanup branch found `null`, silently. `probe_pass` with no `probe_cleaned` and no error was
 * the only trace.
 *
 * So cleanup takes the send PROMISE, not its result, and waits for it here — off the critical
 * path, where waiting costs nothing. The verdict has already been reached and recorded before
 * this runs, so the claim boundary is untouched either way.
 *
 * Returns what it did rather than throwing, because a probe must never fail on cosmetics — and
 * because "skipped" has to be observable. A cleanup that silently does nothing is how this
 * defect survived its own tests.
 */
export async function cleanUpProbeMessage(
  sendPromise: Promise<any> | null | undefined,
  timeoutMs = 10_000,
  echoed?: any,
  /** Re-fetch the sent message by id — see DEF-276f. */
  refetch?: () => Promise<any>,
): Promise<'deleted' | 'skipped_no_message' | 'skipped_undeletable' | 'failed'> {
  // PREFER THE ECHO. DEF-276c, found live: the first promise-based version logged
  // `skipped_no_message` because `client.sendMessage()` resolves with a falsy value on this
  // client — the surrounding code has always written `sent?.id?._serialized`, which was the hint
  // I should have read. The echoed message, by contrast, is a real Message object AND is
  // guaranteed to exist whenever the probe passed, because the echo is what makes it a pass.
  if (echoed && typeof echoed.delete === 'function') {
    // DEF-276d — RETRY, and say why it failed.
    //
    // The echo fires ~50ms after the send and `Message.delete()` runs inside the page, looking
    // the message up by id in WhatsApp Web's own collections (`Msg.get(msgId) || …`) and then
    // reading `msg.id.remote`. That early, the message is often not in that store yet, so the
    // lookup returns undefined and the property read throws. Observed live: `probe_cleaned
    // outcome=failed`, 43ms after the pass.
    //
    // Retrying is the right shape rather than a longer single wait: this runs entirely off the
    // critical path — the verdict is already recorded — so a few hundred milliseconds cost
    // nothing, and the store either catches up quickly or the message is genuinely gone.
    //
    // The reason is LOGGED now. Both earlier versions of this fix failed silently in production
    // and were caught only because the outcome was named; a bare 'failed' repeats that mistake
    // one level down.
    // TWO STRATEGIES, and the second is the semantically correct one for a self-chat.
    // `delete(true)` revokes for everyone, which needs `canSenderRevokeMsg` to hold; in the
    // account's OWN chat there is no one else to revoke for, and the goal here is only to remove
    // it from the owner's view — which is exactly `delete(false)`, delete-for-me.
    //
    // The reason is logged at WARN. It was at `debug` for one deploy and therefore invisible:
    // production filters debug out, so the third version of this fix diagnosed nothing either.
    // Three silent failures in a row is enough — this line has to be readable.
    // DEF-276f — DIAGNOSE, then fix. Four attempts have failed and the only evidence any of
    // them produced was `error: "r"`, a minified page-side throw naming nothing — because
    // `err.message` is the wrong field to read on a Puppeteer page error. The NAME and the first
    // stack frame say whether the page threw a TypeError (our id did not resolve in WhatsApp
    // Web's collections) or an internal WA error (the delete was genuinely refused). Those need
    // opposite fixes, and this is what tells them apart.
    //
    // A re-fetched message is tested alongside the echo, because `delete()` looks the id up in
    // the page's own collections first, and a message fetched by id is the row the library
    // builds for itself rather than a raw `message_create` payload.
    const attempts: Array<{ label: string; get: () => Promise<any> }> = [
      { label: 'echo', get: async () => echoed },
    ];
    if (refetch) attempts.push({ label: 'refetched', get: refetch });

    for (const waitMs of PROBE_CLEANUP_BACKOFF_MS) {
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      for (const attempt of attempts) {
        for (const everyone of [true, false]) {
          try {
            const target = await attempt.get();
            if (!target || typeof target.delete !== 'function') continue;
            await target.delete(everyone);
            log.info('probe message deleted', { via: attempt.label, everyone, afterMs: waitMs });
            return 'deleted';
          } catch (err: any) {
            log.warn('probe message delete attempt failed', {
              via: attempt.label, afterMs: waitMs, everyone,
              name: err?.name ?? null,
              error: String(err?.message ?? err).slice(0, 200),
              stack: String(err?.stack ?? '').split('\n')[1]?.trim().slice(0, 160) ?? null,
            });
          }
        }
      }
    }
    return 'failed';
  }
  if (!sendPromise) return 'skipped_no_message';
  try {
    const sent = await Promise.race([
      sendPromise,
      new Promise((_r, reject) => setTimeout(() => reject(new Error('send did not resolve')), timeoutMs)),
    ]);
    if (!sent) return 'skipped_no_message';
    if (typeof (sent as any).delete !== 'function') return 'skipped_undeletable';
    await (sent as any).delete(true);   // true = for everyone, including the owner's devices
    return 'deleted';
  } catch {
    return 'failed';
  }
}
