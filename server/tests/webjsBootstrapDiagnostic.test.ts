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
      headful: false,
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
      headful: false,
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

describe('headful toggle — matched Xvfb experiment (Codex-approved)', () => {
  it('defaults to headless', () => {
    expect(getWebjsBootstrapDiagnosticPolicy({} as NodeJS.ProcessEnv).headful).toBe(false);
  });
  it('enables headful only on the exact value "1"', () => {
    expect(getWebjsBootstrapDiagnosticPolicy({
      WHATSAPP_WEBJS_DIAGNOSTIC_HEADFUL: '1',
    } as NodeJS.ProcessEnv).headful).toBe(true);
    for (const v of ['true', 'yes', '0', '']) {
      expect(getWebjsBootstrapDiagnosticPolicy({
        WHATSAPP_WEBJS_DIAGNOSTIC_HEADFUL: v,
      } as NodeJS.ProcessEnv).headful).toBe(false);
    }
  });
});

// ── Section 29c corrections (Codex review of 5fe4c41) ───────────────
import {
  classifyVersionProbe,
  makeVersionEvidenceFinalizer,
} from '../src/scripts/diagnoseWebjsBootstrap';

describe('classifyVersionProbe — strict, page-controlled input never printed raw', () => {
  it('valid version passes the strict validator', () => {
    expect(classifyVersionProbe({ pageAvailable: true, value: '2.3000.1043549335' }))
      .toEqual({ pageReportedVersion: '2.3000.1043549335', probeStatus: 'ok' });
    expect(classifyVersionProbe({ pageAvailable: true, value: '2.3000.1043346688-alpha' }).probeStatus)
      .toBe('ok');
  });
  it('arbitrary page-controlled text becomes null with invalid_value', () => {
    for (const hostile of ['<script>alert(1)</script>', 'v2.3000 OR 1=1', '2.3000.99;rm -rf /', '', null, undefined, {}]) {
      expect(classifyVersionProbe({ pageAvailable: true, value: hostile }))
        .toEqual({ pageReportedVersion: null, probeStatus: 'invalid_value' });
    }
  });
  it('page unavailable classifies without touching the value', () => {
    expect(classifyVersionProbe({ pageAvailable: false, value: '2.3000.1' }))
      .toEqual({ pageReportedVersion: null, probeStatus: 'page_unavailable' });
  });
  it('probe timeout and probe error classify distinctly, error wins over timeout', () => {
    expect(classifyVersionProbe({ pageAvailable: true, timedOut: true }).probeStatus).toBe('probe_timeout');
    expect(classifyVersionProbe({ pageAvailable: true, errored: true }).probeStatus).toBe('probe_error');
    expect(classifyVersionProbe({ pageAvailable: true, errored: true, timedOut: true }).probeStatus).toBe('probe_error');
  });
});

describe('makeVersionEvidenceFinalizer — unconditional single emission', () => {
  it('emits exactly once regardless of how many paths call it', () => {
    const lines: any[] = [];
    const finalize = makeVersionEvidenceFinalizer((kind, detail) => lines.push({ kind, ...detail }));
    const evidence = { pinnedCacheVersion: '2.3000.1043346688-alpha', pageReportedVersion: null, probeStatus: 'probe_timeout' as const };
    expect(finalize(evidence)).toBe(true);
    expect(finalize(evidence)).toBe(false);
    expect(finalize({ ...evidence, probeStatus: 'ok' })).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      kind: 'wweb_version_evidence',
      pinnedCacheVersion: '2.3000.1043346688-alpha',
      pageReportedVersion: null,
      probeStatus: 'probe_timeout',
    });
  });
  it('zero-state fatal path still yields a defined line (nulls + not_attempted)', () => {
    const lines: any[] = [];
    const finalize = makeVersionEvidenceFinalizer((kind, detail) => lines.push({ kind, ...detail }));
    finalize({ pinnedCacheVersion: null, pageReportedVersion: null, probeStatus: 'not_attempted' });
    expect(lines[0].pinnedCacheVersion).toBeNull();
    expect(lines[0].probeStatus).toBe('not_attempted');
  });
});

// ── Section 29d: pre-lifecycle fatal still emits evidence (Codex blocking fix)
import { vi } from 'vitest';
import fs from 'fs';
import { runWebjsBootstrapDiagnostic } from '../src/scripts/diagnoseWebjsBootstrap';

describe('fatal before bootstrap — finalizers still fire', () => {
  it('mkdtempSync failure yields exactly one zero-state wweb_version_evidence and one network_summary', async () => {
    const lines: any[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
      try { lines.push(JSON.parse(String(chunk))); } catch { /* non-JSON chunk */ }
      return true;
    }) as any);
    const mkdtempSpy = vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => {
      throw new Error('EACCES: simulated temp-dir denial');
    });
    try {
      await expect(runWebjsBootstrapDiagnostic({} as NodeJS.ProcessEnv))
        .rejects.toThrow('simulated temp-dir denial');
    } finally {
      mkdtempSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
    const versionLines = lines.filter((l) => l.kind === 'wweb_version_evidence');
    const summaryLines = lines.filter((l) => l.kind === 'network_summary');
    expect(versionLines).toHaveLength(1);
    expect(versionLines[0]).toMatchObject({
      pinnedCacheVersion: null,
      pageReportedVersion: null,
      probeStatus: 'not_attempted',
    });
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toMatchObject({
      reason: 'fatal_before_bootstrap',
      observerAttached: false,
      coverage: 'pending',
    });
    expect(summaryLines[0].totals.ws_created).toBe(0);
    // no diagnostic_start line — creation failed before it could emit
    expect(lines.filter((l) => l.kind === 'diagnostic_start')).toHaveLength(0);
  });
});
