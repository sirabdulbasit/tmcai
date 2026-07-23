/**
 * REQ-007 — WhatsApp liveness self-verification (Codex matrix + locks).
 * Pure-core tests over webjsLiveness plus source-level wiring proofs.
 * CLAIM BOUNDARY under test: outbound transport + local echo only.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  newProbeSession, matchProbeEcho, reconcileProbeProviderId, buildProbeMarker,
  recordProbePass, recordProbeFailure, mayReprobe, noteProbeAttempt,
  shouldAlertDegradation, getConsecutiveLivenessFailures,
  decideWatchdogAction, isSendCapableStatus, EPISODE_PROBE_CAP,
  __resetTenantLivenessForTests,
} from '../src/services/whatsapp/webjsLiveness';

const SRC = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', rel), 'utf8');
const TENANT = 'TMC-0001';
const SELF = '923274572102@c.us';

const echo = (session: any, over: Partial<any> = {}) => matchProbeEcho(session, {
  fromMe: true, chatId: SELF, selfId: SELF,
  body: buildProbeMarker(session.nonce), providerId: 'prov_1',
  generation: session.generation, clientNumber: TENANT, ...over,
});

beforeEach(() => __resetTenantLivenessForTests());

describe('probe identity matching (lock 2)', () => {
  it('full identity evidence matches once provider id is known', () => {
    const s = newProbeSession(TENANT, 'gen1', 'nonceA');
    s.expectedProviderId = 'prov_1';
    expect(echo(s)).toBe('matched');
  });
  it('nonce match WITHOUT fromMe is never intercepted', () => {
    const s = newProbeSession(TENANT, 'gen1', 'nonceA');
    s.expectedProviderId = 'prov_1';
    expect(echo(s, { fromMe: false })).toBe('rejected');
  });
  it('nonce match from a NON-self chat is never intercepted', () => {
    const s = newProbeSession(TENANT, 'gen1', 'nonceA');
    s.expectedProviderId = 'prov_1';
    expect(echo(s, { chatId: '92300111@c.us' })).toBe('rejected');
  });
  it('stale generation, wrong tenant, wrong nonce all reject', () => {
    const s = newProbeSession(TENANT, 'gen1', 'nonceA');
    s.expectedProviderId = 'prov_1';
    expect(echo(s, { generation: 'gen0' })).toBe('rejected');
    expect(echo(s, { clientNumber: 'OTHER-01' })).toBe('rejected');
    expect(echo(s, { body: buildProbeMarker('nonceB') })).toBe('rejected');
  });
  it('duplicate echo after settle is idempotent (rejected)', () => {
    const s = newProbeSession(TENANT, 'gen1', 'nonceA');
    s.expectedProviderId = 'prov_1';
    expect(echo(s)).toBe('matched');
    s.settled = true;
    expect(echo(s)).toBe('rejected');
  });
});

describe('early echo / provider-id reconciliation (lock 3)', () => {
  it('early echo (send() not yet returned) is BUFFERED, not rejected', () => {
    const s = newProbeSession(TENANT, 'gen1', 'nonceA');
    expect(echo(s)).toBe('buffered');
  });
  it('buffered echo passes when the returned provider id matches', () => {
    const s = newProbeSession(TENANT, 'gen1', 'nonceA');
    echo(s);
    expect(reconcileProbeProviderId(s, 'prov_1')).toBe('matched');
  });
  it('provider-id MISMATCH cannot pass', () => {
    const s = newProbeSession(TENANT, 'gen1', 'nonceA');
    echo(s);
    expect(reconcileProbeProviderId(s, 'prov_OTHER')).toBe('failed');
  });
  it('no echo yet → reconcile stays pending for the live listener', () => {
    const s = newProbeSession(TENANT, 'gen1', 'nonceA');
    expect(reconcileProbeProviderId(s, 'prov_1')).toBe('pending');
    expect(echo(s)).toBe('matched'); // live listener now matches on exact id
  });
});

describe('tenant-scoped failure counters (lock 1)', () => {
  it('failure count survives generation replacement (tenant-owned)', () => {
    expect(recordProbeFailure(TENANT)).toBe('bounded_reinit');
    // a NEW generation inherits the count: next failure degrades
    expect(recordProbeFailure(TENANT)).toBe('degrade');
    expect(getConsecutiveLivenessFailures(TENANT)).toBe(2);
  });
  it('only a passed probe resets; further failures hold degraded', () => {
    recordProbeFailure(TENANT); recordProbeFailure(TENANT);
    expect(recordProbeFailure(TENANT)).toBe('hold_degraded');
    recordProbePass(TENANT);
    expect(getConsecutiveLivenessFailures(TENANT)).toBe(0);
    expect(recordProbeFailure(TENANT)).toBe('bounded_reinit'); // fresh episode
  });
});

describe('degraded reprobe episode cap (lock 4)', () => {
  it('probes stop after the total episode cap and resume only on pass', () => {
    for (let i = 0; i < EPISODE_PROBE_CAP; i++) noteProbeAttempt(TENANT);
    expect(mayReprobe(TENANT)).toEqual({ allowed: false, reason: 'episode_cap_exhausted' });
    recordProbePass(TENANT); // new healthy episode
    expect(mayReprobe(TENANT).allowed).toBe(true);
  });
  it('degradation alert fires exactly once per episode', () => {
    recordProbeFailure(TENANT); recordProbeFailure(TENANT);
    expect(shouldAlertDegradation(TENANT)).toBe(true);
    expect(shouldAlertDegradation(TENANT)).toBe(false);
    recordProbePass(TENANT);
    recordProbeFailure(TENANT); recordProbeFailure(TENANT);
    expect(shouldAlertDegradation(TENANT)).toBe(true); // new episode, new primary alert
  });
});

describe('status semantics + watchdog table (locks 5-6)', () => {
  it('only exactly "connected" is send-capable', () => {
    expect(isSendCapableStatus('connected')).toBe(true);
    for (const s of ['connected_unverified', 'liveness_failed', 'degraded', 'connecting', 'ready']) {
      expect(isSendCapableStatus(s), s).toBe(false);
    }
  });
  it('decision table: wait / reprobe / reinit / withhold', () => {
    expect(decideWatchdogAction({ status: 'connected_unverified', probeInFlight: true, reprobeAllowed: true })).toBe('wait_for_probe');
    expect(decideWatchdogAction({ status: 'connected_unverified', probeInFlight: false, reprobeAllowed: true })).toBe('capped_reprobe');
    expect(decideWatchdogAction({ status: 'liveness_failed', probeInFlight: false, reprobeAllowed: true })).toBe('bounded_reinit');
    expect(decideWatchdogAction({ status: 'degraded', probeInFlight: false, reprobeAllowed: true })).toBe('capped_reprobe');
    expect(decideWatchdogAction({ status: 'degraded', probeInFlight: false, reprobeAllowed: false })).toBe('withhold_for_repair');
    expect(decideWatchdogAction({ status: 'connected', probeInFlight: false, reprobeAllowed: true })).toBe('none');
  });
});

describe('wiring proofs (source-level)', () => {
  const provider = () => SRC('WebjsProvider.ts');
  it('ready produces connected_unverified, never connected, and starts the probe', () => {
    const src = provider();
    const readyIdx = src.indexOf("client.on('ready'");
    const readyBlock = src.slice(readyIdx, src.indexOf('});', src.indexOf('runLivenessProbe', readyIdx)));
    expect(readyBlock).toContain("'connected_unverified'");
    expect(readyBlock).not.toMatch(/status = 'connected'[^_]/);
    expect(readyBlock).toContain('runLivenessProbe');
  });
  it('backoff reset moved off ready to probe pass (lock 5)', () => {
    const src = provider();
    const readyIdx = src.indexOf("client.on('ready'");
    const readyBlock = src.slice(readyIdx, readyIdx + 1600);
    expect(readyBlock).not.toContain('reconnectAttempts.delete');
    const passIdx = src.indexOf("recordProbePass(clientNumber)");
    expect(src.slice(passIdx, passIdx + 300)).toContain('reconnectAttempts.delete');
  });
  it('probe promotion is the only write of status=connected on the webjs path', () => {
    const src = provider();
    const writes = [...src.matchAll(/SET status = 'connected'[^_]/g)];
    expect(writes.length).toBe(1); // the probe-pass update only
  });
  it('observer registered before the probe send', () => {
    const src = provider();
    const onIdx = src.indexOf("client.on('message_create', listener)");
    const sendIdx = src.indexOf('client.sendMessage(selfId, buildProbeMarker');
    expect(onIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(onIdx);
  });
  it('expired-flight replacement classifies + counts before disposal (silent-recycle fix)', () => {
    const src = provider();
    const idx = src.indexOf('expired_flight');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx - 1500, idx + 900);
    expect(block).toContain('consecutiveTimeouts');
    expect(block).toContain('requiresRepair');
    expect(block).toContain("failureClass: 'init_timeout'");
  });
  it('probe bypasses the normal pipeline: fromMe messages never reach handleInboundEvent', () => {
    const src = provider();
    const idx = src.indexOf('const handleInboundEvent');
    expect(src.slice(idx, idx + 200)).toContain('if (message.fromMe) return;');
  });
  it('watchdog handles all three liveness states without treating them as drift', () => {
    const wd = SRC('connectionWatchdog.ts');
    for (const s of ['connected_unverified', 'liveness_failed', 'degraded']) expect(wd).toContain(`'${s}'`);
    expect(wd).toContain('decideWatchdogAction');
    expect(wd).toContain('withhold_for_repair');
  });
  it('send gates require exactly connected (manager + tenant sender unchanged)', () => {
    const mgr = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'WhatsAppManager.ts'), 'utf8');
    expect(mgr).toContain("config.status !== 'connected'");
    const sender = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'notifications', 'tenantWhatsappSender.ts'), 'utf8');
    expect(sender).toContain("status === 'connected'");
  });
  it('probe content is an opaque marker persisted nowhere (no message-log insert in probe path)', () => {
    const src = provider();
    const probeIdx = src.indexOf('async function runLivenessProbe');
    const probeBlock = src.slice(probeIdx, src.indexOf('\n}', src.indexOf('bounded_reinit is executed', probeIdx)));
    expect(probeBlock).not.toContain('whatsapp_messages');
    expect(probeBlock).not.toContain('handleInboundMessage');
    expect(probeBlock).not.toContain('captureDelegationReply');
    expect(probeBlock).not.toContain('messages_today');
  });
  it('degradation alert goes through the independent path (system_logs), deduped per episode', () => {
    const src = provider();
    expect(src).toContain('shouldAlertDegradation');
    expect(src).toContain('system_logs');
  });
});
