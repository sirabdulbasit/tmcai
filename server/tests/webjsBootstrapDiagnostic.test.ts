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
