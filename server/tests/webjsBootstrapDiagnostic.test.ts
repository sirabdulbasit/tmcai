import { describe, expect, it } from 'vitest';
import {
  boundedDiagnosticText,
  getWebjsBootstrapDiagnosticPolicy,
} from '../src/scripts/diagnoseWebjsBootstrap';

describe('manual Web.js bootstrap diagnostic policy', () => {
  it('uses bounded one-attempt defaults', () => {
    expect(getWebjsBootstrapDiagnosticPolicy({} as NodeJS.ProcessEnv)).toEqual({
      timeoutMs: 120_000,
      errorCap: 50,
      textCap: 8_000,
    });
  });

  it('clamps every manual diagnostic override', () => {
    expect(getWebjsBootstrapDiagnosticPolicy({
      WHATSAPP_WEBJS_DIAGNOSTIC_TIMEOUT_MS: '9999999',
      WHATSAPP_WEBJS_DIAGNOSTIC_ERROR_CAP: '0',
      WHATSAPP_WEBJS_DIAGNOSTIC_TEXT_CAP: '1',
    } as NodeJS.ProcessEnv)).toEqual({
      timeoutMs: 300_000,
      errorCap: 1,
      textCap: 500,
    });
  });

  it('truncates stdout error fields deterministically', () => {
    expect(boundedDiagnosticText('123456789', 5)).toBe('12345…[truncated]');
    expect(boundedDiagnosticText('short', 10)).toBe('short');
  });
});

// ── Section 29 (2026-07-21, Codex-approved): network observer ───────
import {
  safeSocketUrl,
  wsPayloadByteLength,
  classifyZeroSocket,
  newNetworkTally,
  noteNetworkEvent,
  NETWORK_LINE_CAPS,
  type NetworkEventClass,
} from '../src/scripts/diagnoseWebjsBootstrap';

describe('safeSocketUrl — WS-capable sanitizer', () => {
  it('accepts wss/ws and strips query strings and fragments', () => {
    expect(safeSocketUrl('wss://web.whatsapp.com/ws/chat?token=SECRET#frag'))
      .toBe('wss://web.whatsapp.com/ws/chat');
    expect(safeSocketUrl('ws://example.com/a/b?x=1')).toBe('ws://example.com/a/b');
  });
  it('accepts http/https with the same stripping', () => {
    expect(safeSocketUrl('https://static.whatsapp.net/rsrc.php/v4/x.js?cred=NO'))
      .toBe('https://static.whatsapp.net/rsrc.php/v4/x.js');
  });
  it('rejects other schemes and junk', () => {
    expect(safeSocketUrl('chrome-extension://abc/x')).toBeNull();
    expect(safeSocketUrl('about:blank')).toBeNull();
    expect(safeSocketUrl(undefined)).toBeNull();
    expect(safeSocketUrl('not a url')).toBeNull();
  });
  it('caps length at 160', () => {
    const long = `wss://web.whatsapp.com/${'a'.repeat(400)}`;
    expect(safeSocketUrl(long)!.length).toBe(160);
  });
});

describe('wsPayloadByteLength — length only, never content', () => {
  it('opcode 1: UTF-8 byte length (unicode counted in bytes, not chars)', () => {
    expect(wsPayloadByteLength(1, 'abc')).toBe(3);
    expect(wsPayloadByteLength(1, 'héllo')).toBe(6);      // é = 2 bytes
    expect(wsPayloadByteLength(1, '🎙️')).toBeGreaterThan(4); // emoji + VS16
  });
  it('other opcodes: decoded base64 byte length', () => {
    const bin = Buffer.from([1, 2, 3, 4, 5]);
    expect(wsPayloadByteLength(2, bin.toString('base64'))).toBe(5);
    expect(wsPayloadByteLength(8, '')).toBe(0);
    expect(wsPayloadByteLength(undefined, Buffer.from('xyz').toString('base64'))).toBe(3);
  });
});

describe('classifyZeroSocket — coverage-gated, no host attribution', () => {
  it('full coverage + zero sockets is the ONLY conclusive class', () => {
    expect(classifyZeroSocket('full')).toBe('no_socket_attempted');
  });
  it('late observer can never claim no-socket', () => {
    expect(classifyZeroSocket('late')).toBe('observer_late_or_inconclusive');
  });
  it('unobserved navigation stays inconclusive', () => {
    expect(classifyZeroSocket('pending')).toBe('navigation_not_observed');
  });
});

describe('noteNetworkEvent — complete tallies, capped lines', () => {
  it('emits up to the per-class cap then suppresses while still counting totals', () => {
    const tally = newNetworkTally();
    const caps = { ...NETWORK_LINE_CAPS, ws_frame_sent: 2 };
    const emits = [1, 2, 3, 4].map(() => noteNetworkEvent(tally, 'ws_frame_sent', caps));
    expect(emits).toEqual([true, true, false, false]);
    expect(tally.totals.ws_frame_sent).toBe(4);
    expect(tally.emitted.ws_frame_sent).toBe(2);
    expect(tally.suppressed.ws_frame_sent).toBe(2);
  });
  it('classes are independent and every class has a positive default cap', () => {
    const tally = newNetworkTally();
    for (const cls of Object.keys(NETWORK_LINE_CAPS) as NetworkEventClass[]) {
      expect(NETWORK_LINE_CAPS[cls]).toBeGreaterThan(0);
      expect(noteNetworkEvent(tally, cls)).toBe(true);
      expect(tally.totals[cls]).toBe(1);
    }
  });
  it('summary inputs (totals/emitted/suppressed) always reconcile', () => {
    const tally = newNetworkTally();
    const caps = { ...NETWORK_LINE_CAPS, ws_created: 1 };
    for (let i = 0; i < 7; i++) noteNetworkEvent(tally, 'ws_created', caps);
    expect(tally.emitted.ws_created + tally.suppressed.ws_created).toBe(tally.totals.ws_created);
  });
});
