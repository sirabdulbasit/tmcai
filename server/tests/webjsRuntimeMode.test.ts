/**
 * Section 31 — shared Web.js display-mode policy.
 * Root cause 2026-07-21: WhatsApp Web bootstrap stalls in headless
 * Chrome on the production host; headful under Xvfb works. These tests
 * pin the helper semantics, the fail-closed display guard, and (source-
 * level) that BOTH QR providers consume the helper while MetaProvider
 * remains untouched by the flag.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  resolveWebjsHeadlessMode,
  assertHeadfulDisplayAvailable,
  WebjsDisplayError,
} from '../src/services/whatsapp/webjsRuntimeMode';

afterEach(() => vi.restoreAllMocks());

describe('resolveWebjsHeadlessMode', () => {
  it('defaults to headless', () => {
    expect(resolveWebjsHeadlessMode({} as NodeJS.ProcessEnv)).toEqual({ headless: true });
  });
  it('goes headful ONLY on the exact value "1"', () => {
    expect(resolveWebjsHeadlessMode({ WHATSAPP_WEBJS_HEADFUL: '1' } as NodeJS.ProcessEnv))
      .toEqual({ headless: false });
  });
  it('every other value stays headless', () => {
    for (const v of ['true', 'yes', '0', '', ' 1', '1 ', 'headful', 'TRUE']) {
      expect(resolveWebjsHeadlessMode({ WHATSAPP_WEBJS_HEADFUL: v } as NodeJS.ProcessEnv).headless)
        .toBe(true);
    }
  });
});

describe('assertHeadfulDisplayAvailable — fail closed, typed', () => {
  it('is a no-op in headless mode even with no DISPLAY anywhere', () => {
    expect(() => assertHeadfulDisplayAvailable({} as NodeJS.ProcessEnv)).not.toThrow();
  });
  it('headful without DISPLAY throws headful_display_missing', () => {
    try {
      assertHeadfulDisplayAvailable({ WHATSAPP_WEBJS_HEADFUL: '1' } as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(WebjsDisplayError);
      expect(e.code).toBe('headful_display_missing');
      expect(e.message).toContain('nexeo-xvfb');
    }
    expect(() => assertHeadfulDisplayAvailable(
      { WHATSAPP_WEBJS_HEADFUL: '1', DISPLAY: '   ' } as NodeJS.ProcessEnv,
    )).toThrow(/headful_display_missing/);
  });
  it('local DISPLAY without its X11 socket throws headful_display_unavailable', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    try {
      assertHeadfulDisplayAvailable({ WHATSAPP_WEBJS_HEADFUL: '1', DISPLAY: ':99' } as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(WebjsDisplayError);
      expect(e.code).toBe('headful_display_unavailable');
      expect(e.message).toContain('/tmp/.X11-unix/X99');
    }
  });
  it('local DISPLAY with a live socket passes (screen suffix supported)', () => {
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    expect(() => assertHeadfulDisplayAvailable(
      { WHATSAPP_WEBJS_HEADFUL: '1', DISPLAY: ':99.0' } as NodeJS.ProcessEnv,
    )).not.toThrow();
    expect(spy).toHaveBeenCalledWith('/tmp/.X11-unix/X99');
  });
  it('non-local DISPLAY forms are accepted without a socket check', () => {
    const spy = vi.spyOn(fs, 'existsSync');
    expect(() => assertHeadfulDisplayAvailable(
      { WHATSAPP_WEBJS_HEADFUL: '1', DISPLAY: 'localhost:10.0' } as NodeJS.ProcessEnv,
    )).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('provider consumption — source-level enforcement', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', rel), 'utf8');

  it('both Web.js providers consume the shared helper', () => {
    for (const provider of ['WebjsProvider.ts', 'UserWebjsProvider.ts']) {
      const src = read(provider);
      expect(src, `${provider} must import webjsRuntimeMode`).toContain("from './webjsRuntimeMode'");
      expect(src, `${provider} must guard before client construction`).toContain('assertHeadfulDisplayAvailable');
      expect(src, `${provider} must not hardcode a headless flag`).not.toMatch(/headless:\s*(true|false)\b/);
    }
  });
  it('MetaProvider routing is untouched by the display flag', () => {
    const src = read('MetaProvider.ts');
    expect(src).not.toContain('WHATSAPP_WEBJS_HEADFUL');
    expect(src).not.toContain('webjsRuntimeMode');
    expect(src).not.toMatch(/headless/i);
  });
});
