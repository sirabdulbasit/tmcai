import { describe, expect, it } from 'vitest';
import {
  fingerprintBrowserError,
  getInitConsoleErrorCap,
  safeBrowserUrl,
  safeBrowserExceptionName,
  safeWwebVersion,
  WebjsInitTelemetry,
} from '../src/services/whatsapp/webjsInitTelemetry';

describe('WhatsApp Web.js bounded initialization telemetry', () => {
  it('removes query, fragment, and credentials from page URLs', () => {
    expect(safeBrowserUrl('https://user:secret@web.whatsapp.com/app?token=abc#private'))
      .toBe('https://web.whatsapp.com/app');
    expect(safeBrowserUrl('file:///tmp/session-token')).toBeNull();
    expect(safeBrowserUrl('not a URL')).toBeNull();
  });

  it('accepts only bounded numeric WhatsApp Web versions', () => {
    expect(safeWwebVersion('2.3000.1043351526-alpha')).toBe('2.3000.1043351526-alpha');
    expect(safeWwebVersion('version=<token>')).toBeNull();
    expect(safeWwebVersion('2.3')).toBeNull();
  });

  it('retains only a bounded exception name and never its message', () => {
    expect(safeBrowserExceptionName(new TypeError('secret message'))).toBe('TypeError');
    expect(safeBrowserExceptionName('Uncaught (in promise) SecurityError: private detail'))
      .toBe('SecurityError');
    expect(safeBrowserExceptionName('r: opaque minified failure')).toBe('r');
    expect(safeBrowserExceptionName('private free-form text without a class')).toBeNull();
    expect(safeBrowserExceptionName(`${'A'.repeat(49)}: too long`)).toBeNull();
  });

  it('maps raw browser failures to fixed fingerprints', () => {
    expect(fingerprintBrowserError('Runtime.callFunctionOn timed out')).toBe('runtime_call_timeout');
    expect(fingerprintBrowserError(new Error('Execution context was destroyed')))
      .toBe('execution_context_lost');
    expect(fingerprintBrowserError('failed to fetch https://secret.example/token'))
      .toBe('network_failure');
    expect(fingerprintBrowserError('private arbitrary browser detail'))
      .toBe('unknown_browser_error');
    expect(fingerprintBrowserError(
      'opaque minified exception',
      'https://static.whatsapp.net/rsrc.php/v4/yS/r/bundle.js?token=secret',
    )).toBe('wa_bundle_boot_exception');
  });

  it('retains only a capped fingerprint ring and no raw browser text', () => {
    const telemetry = new WebjsInitTelemetry(1_000, 2);
    telemetry.setPageUrl('https://web.whatsapp.com/?token=secret', 1_001);
    telemetry.recordBrowserError('console', 'secret-A Runtime.callFunctionOn timed out', undefined, 1_002);
    telemetry.recordBrowserError('pageerror', 'secret-B Execution context destroyed', undefined, 1_003);
    telemetry.recordBrowserError('console', 'secret-C arbitrary private text', undefined, 1_004);

    const snapshot = telemetry.snapshot();
    expect(snapshot.pageUrl).toBe('https://web.whatsapp.com/');
    expect(snapshot.consoleErrors).toEqual([
      { at: 1_003, source: 'pageerror', fingerprint: 'execution_context_lost' },
      { at: 1_004, source: 'console', fingerprint: 'unknown_browser_error' },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret-[ABC]|token=secret|private text/);
  });

  it('records exception name without retaining the exception message', () => {
    const telemetry = new WebjsInitTelemetry(1_000);
    telemetry.recordBrowserError(
      'pageerror',
      new DOMException('private anti-bot detail', 'SecurityError'),
      'https://static.whatsapp.net/rsrc.php/v4/x.js?token=secret',
      1_001,
    );
    const serialized = JSON.stringify(telemetry.snapshot());
    expect(telemetry.snapshot().consoleErrors[0]).toEqual({
      at: 1_001,
      source: 'pageerror',
      fingerprint: 'wa_bundle_boot_exception',
      exceptionName: 'SecurityError',
      location: 'https://static.whatsapp.net/rsrc.php/v4/x.js',
    });
    expect(serialized).not.toMatch(/anti-bot detail|token=secret/);
  });

  it('records lifecycle facts and returns defensive snapshots', () => {
    const telemetry = new WebjsInitTelemetry(1_000);
    telemetry.mark('provider_qr_listener_registered', 1_001);
    telemetry.setLoadingPercent(99.4, 1_002);
    telemetry.mark('qr_emitted', 1_003);
    telemetry.mark('authenticated', 1_004);
    telemetry.setWwebVersion('2.3000.1043351526');

    const first = telemetry.snapshot();
    first.timeline.length = 0;
    first.consoleErrors.push({
      at: 1_005, source: 'console', fingerprint: 'unknown_browser_error',
    });
    const second = telemetry.snapshot();
    expect(second).toMatchObject({
      stage: 'authenticated',
      wwebVersion: '2.3000.1043351526',
      qrListenerRegistered: true,
      qrEmitted: true,
      authenticated: true,
      loadingPercent: 99,
    });
    expect(second.timeline.length).toBeGreaterThan(0);
    expect(second.consoleErrors).toHaveLength(0);
  });

  it('bounds the production-tunable console fingerprint cap', () => {
    expect(getInitConsoleErrorCap({} as NodeJS.ProcessEnv)).toBe(8);
    expect(getInitConsoleErrorCap({ WHATSAPP_WEBJS_INIT_CONSOLE_ERROR_CAP: '0' } as NodeJS.ProcessEnv)).toBe(1);
    expect(getInitConsoleErrorCap({ WHATSAPP_WEBJS_INIT_CONSOLE_ERROR_CAP: '999' } as NodeJS.ProcessEnv)).toBe(20);
  });
});
