/**
 * DEF-286 — a recent pass survives a fast restart.
 *
 * One probe per `ready` means one `[nexeo-liveness …]` in the owner's own chat per restart, and
 * nine on 2026-09-02 were mine, deploying fixes minutes apart. They cannot be removed afterwards:
 * DEF-276 established over seven attempts that `whatsapp-web.js@1.34.7` cannot address a sent
 * message against WA Web 2.3000.x, and the npm registry is unreachable from this box so there is
 * no upgrade available. So the remedy is to stop making the ones that add nothing.
 *
 * A restart minutes after a pass restarts the PROCESS, not WhatsApp — same session, same pairing,
 * same transport as the pass just verified.
 *
 * **What it trades, and the tests that hold the line on it:** for up to the trust window, a
 * restart believes the previous pass instead of re-proving the channel. That is only acceptable
 * because the trust is refused in every case where the channel was not already known good — and
 * because an unreadable or absent record probes rather than skips. The fail-safe direction is to
 * SEND a probe, never to skip one.
 */
import { describe, it, expect } from 'vitest';
import {
  mayTrustRecentPass, PROBE_TRUST_WINDOW_MS, PROBE_LAST_PASS_KEY,
} from '../src/services/whatsapp/webjsLiveness';

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe('DEF-286 — when a previous pass may be trusted', () => {
  it('trusts a pass from minutes ago on a previously connected channel', () => {
    const v = mayTrustRecentPass('connected', iso(60_000));
    expect(v.trust).toBe(true);
    expect(v.ageMs).toBeGreaterThan(0);
  });

  it('refuses a pass older than the window', () => {
    const v = mayTrustRecentPass('connected', iso(PROBE_TRUST_WINDOW_MS + 60_000));
    expect(v.trust).toBe(false);
    expect(v.reason).toContain('old');
  });

  it('THE SAFETY PROPERTY: never trusts a channel that was not already good', () => {
    // This is the entire population the change could hurt. A degraded or failed channel must be
    // re-proved on every single restart, however recent the last pass looks.
    for (const status of ['degraded', 'liveness_failed', 'connected_unverified', 'connecting', null, undefined]) {
      const v = mayTrustRecentPass(status as any, iso(1_000));
      expect(v.trust, String(status)).toBe(false);
    }
  });

  it('probes when there is no record at all', () => {
    expect(mayTrustRecentPass('connected', null).trust).toBe(false);
    expect(mayTrustRecentPass('connected', undefined).trust).toBe(false);
  });

  it('probes when the record is unreadable rather than trusting it', () => {
    // Fail-safe direction: garbage must never be read as "recently verified".
    expect(mayTrustRecentPass('connected', 'not-a-date').trust).toBe(false);
    expect(mayTrustRecentPass('connected', '').trust).toBe(false);
  });

  it('refuses a timestamp from the future — that is a clock fault, not a verification', () => {
    const v = mayTrustRecentPass('connected', new Date(Date.now() + 600_000).toISOString());
    expect(v.trust).toBe(false);
    expect(v.reason).toContain('future');
  });

  it('is bounded by a window measured in minutes, not hours', () => {
    // A long window would quietly turn "verified channel" into "verified once, some time ago".
    expect(PROBE_TRUST_WINDOW_MS).toBeLessThanOrEqual(30 * 60_000);
    expect(PROBE_TRUST_WINDOW_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('exactly at the window boundary it still trusts, and just past it does not', () => {
    expect(mayTrustRecentPass('connected', iso(PROBE_TRUST_WINDOW_MS - 1_000)).trust).toBe(true);
    expect(mayTrustRecentPass('connected', iso(PROBE_TRUST_WINDOW_MS + 1_000)).trust).toBe(false);
  });

  it('stores the pass under a namespaced key, not a bare word', () => {
    expect(PROBE_LAST_PASS_KEY).toContain('whatsapp');
    expect(PROBE_LAST_PASS_KEY).toContain('liveness');
  });
});
