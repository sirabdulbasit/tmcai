import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';

/**
 * Outbound network hardening, applied once at boot.
 * =================================================
 *
 * On 27 Aug 2026 every AI feature in production failed with
 *   "request to https://oauth2.googleapis.com/token failed, reason:"
 * and nothing after the colon. The host has no IPv6 address and no v6 route,
 * yet its resolver returns AAAA records for Google's endpoints. `node-fetch` —
 * which google-auth-library and gaxios use — dialled one and hung until
 * ETIMEDOUT.
 *
 * What made it hard to find, and why this lives in code rather than in an
 * environment variable:
 *
 *   • `curl` implements happy-eyeballs and silently falls back to IPv4, so
 *     every manual connectivity check passed while the application was broken.
 *   • Native `fetch` and `https.request` both succeeded against the same URL in
 *     the same second. ONLY `node-fetch` failed.
 *   • NODE_OPTIONS=--dns-result-order=ipv4first did NOT help: that governs
 *     dns.lookup, and node-fetch's default agent does not consult it.
 *
 * Hence three settings, covering different clients:
 *   1. dns.setDefaultResultOrder  → native fetch, https.request
 *   2. globalAgent.options.family → node-fetch (the one that actually broke)
 *   3. net.setDefaultAutoSelectFamily(false) → native fetch. Node 20 races
 *      the addresses ("happy eyeballs") and abandons each attempt after
 *      250 ms; a TCP connect to Google from this host takes ~257 ms, so the
 *      IPv4 attempt was abandoned for the unroutable IPv6 one and ~1 call in 5
 *      failed with ETIMEDOUT — the Google Sheets sign-in among them. With
 *      ipv4first and no race, the IPv4 address is dialled and simply waited for.
 *
 * Safe where IPv6 works: those hosts simply prefer IPv4. Revisit only if this
 * service ever needs to reach a v6-only endpoint.
 */
export const applyOutboundNetworkPolicy = (): void => {
  dns.setDefaultResultOrder('ipv4first');
  net.setDefaultAutoSelectFamily(false);
  // `options` is untyped on Agent but is where the family setting lives, and is
  // what node-fetch's default agent reads.
  (https.globalAgent as unknown as { options: Record<string, unknown> }).options.family = 4;
  (http.globalAgent as unknown as { options: Record<string, unknown> }).options.family = 4;
};

/** What the policy currently is — so a test can assert it, and boot can log it. */
export const outboundNetworkPolicy = (): { dnsOrder: string; agentFamily: unknown; autoSelectFamily: boolean } => ({
  dnsOrder: dns.getDefaultResultOrder(),
  autoSelectFamily: net.getDefaultAutoSelectFamily(),
  agentFamily: (https.globalAgent as unknown as { options: Record<string, unknown> }).options.family,
});
