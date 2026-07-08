import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateEnv } from '../env';

const SECURITY_KEYS = ['DATABASE_URL', 'ENCRYPTION_KEY'];

describe('validateEnv', () => {
  const snapshot: Record<string, string | undefined> = {};
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of SECURITY_KEYS) snapshot[k] = process.env[k];
    snapshot.NODE_ENV = process.env.NODE_ENV;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of Object.keys(snapshot)) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('fails fast in production when security-critical vars are missing', () => {
    process.env.NODE_ENV = 'production';
    for (const k of SECURITY_KEYS) delete process.env[k];
    expect(() => validateEnv()).toThrow(/Security-critical env vars invalid/);
  });

  it('ignores PLATFORM_API_TOKEN entirely (E1: agent tokens live in the DB now)', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://x';
    process.env.ENCRYPTION_KEY = 'x'.repeat(32);
    process.env.PLATFORM_API_TOKEN = 'short'; // would have thrown before E1
    expect(() => validateEnv()).not.toThrow();
  });

  it('fails fast in production when ENCRYPTION_KEY is too short', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://x';
    process.env.ENCRYPTION_KEY = 'shortkey';
    expect(() => validateEnv()).toThrow(/ENCRYPTION_KEY.*too short/);
  });

  it('does not throw in development when security vars are missing', () => {
    process.env.NODE_ENV = 'development';
    for (const k of SECURITY_KEYS) delete process.env[k];
    expect(() => validateEnv()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('passes with all security vars set to valid values', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://user:pass@host:5432/db';
    process.env.ENCRYPTION_KEY = 'x'.repeat(32);
    expect(() => validateEnv()).not.toThrow();
  });

  it('warns (but does not throw) when no AI provider keys are configured', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://x';
    process.env.ENCRYPTION_KEY = 'x'.repeat(32);
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    expect(() => validateEnv()).not.toThrow();
    const calls = warnSpy.mock.calls.flat().join(' ');
    expect(calls).toMatch(/No AI API keys configured/);
  });
});
