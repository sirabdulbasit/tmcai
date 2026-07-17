import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareVerifiedWebjsVersionCache,
  resolveWebjsVersionPin,
} from '../src/services/whatsapp/webjsVersionCache';

const temporaryPaths: string[] = [];

function temporarySessionPath(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'nexeo-web-cache-'));
  temporaryPaths.push(value);
  return value;
}

function pinFor(content: Buffer, version = '2.3000.9999999999-alpha'): NodeJS.ProcessEnv {
  return {
    WHATSAPP_WEBJS_WEB_VERSION: version,
    WHATSAPP_WEBJS_WEB_CACHE_URL: `https://archive.example/${version}.html`,
    WHATSAPP_WEBJS_WEB_CACHE_SHA256: crypto.createHash('sha256').update(content).digest('hex'),
    WHATSAPP_WEBJS_WEB_CACHE_EXPIRES_AT: '2099-01-01T00:00:00.000Z',
  } as NodeJS.ProcessEnv;
}

function response(content: Buffer): Response {
  return new Response(content, {
    status: 200,
    headers: { 'content-length': String(content.length), 'content-type': 'text/html' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const temporary of temporaryPaths.splice(0)) {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

describe('integrity-checked WhatsApp Web version cache', () => {
  it('defaults to the immutable clean-profile QR-verified artifact', () => {
    expect(resolveWebjsVersionPin({} as NodeJS.ProcessEnv)).toEqual({
      version: '2.3000.1043346688-alpha',
      sourceUrl: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/d71af1f1094ace8354e0a0f0f5e9c32b67988f96/html/2.3000.1043346688-alpha.html',
      sha256: '80a55358cdd081b3e58eb4bf62434b9f8bd9802f569e10c53e48823cd8528fcf',
      expiresAt: '2026-09-17T07:27:10.198Z',
    });
  });

  it('requires an atomic version, URL, and digest rotation', () => {
    expect(() => resolveWebjsVersionPin({
      WHATSAPP_WEBJS_WEB_VERSION: '2.3000.1-alpha',
    } as NodeJS.ProcessEnv)).toThrow(/requires version, URL, SHA-256, and expiry together/);
    expect(() => resolveWebjsVersionPin({
      WHATSAPP_WEBJS_WEB_VERSION: '2.3000.1-alpha',
      WHATSAPP_WEBJS_WEB_CACHE_URL: 'http://archive.example/build.html',
      WHATSAPP_WEBJS_WEB_CACHE_SHA256: 'a'.repeat(64),
      WHATSAPP_WEBJS_WEB_CACHE_EXPIRES_AT: '2099-01-01T00:00:00.000Z',
    } as NodeJS.ProcessEnv)).toThrow(/credential-free HTTPS/);
  });

  it('fails closed after the pinned artifact expiry', async () => {
    const content = Buffer.from('<html>expired</html>');
    const env = pinFor(content);
    env.WHATSAPP_WEBJS_WEB_CACHE_EXPIRES_AT = '2020-01-01T00:00:00.000Z';
    await expect(prepareVerifiedWebjsVersionCache({
      sessionPath: temporarySessionPath(), env,
      fetchImpl: vi.fn() as typeof fetch,
    })).rejects.toThrow(/artifact has expired/);
  });

  it('downloads, verifies, atomically caches, and then reuses the artifact', async () => {
    const content = Buffer.from('<!doctype html><html>verified WhatsApp Web</html>');
    const fetchImpl = vi.fn().mockResolvedValue(response(content));
    const sessionPath = temporarySessionPath();
    const env = pinFor(content);

    const first = await prepareVerifiedWebjsVersionCache({
      sessionPath, env, fetchImpl: fetchImpl as typeof fetch,
    });
    const second = await prepareVerifiedWebjsVersionCache({
      sessionPath, env, fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(first.webVersionCache).toEqual({
      type: 'local', path: first.cachePath, strict: true,
    });
    expect(second).toEqual(first);
    expect(fs.readFileSync(path.join(first.cachePath, `${first.version}.html`))).toEqual(content);
  });

  it('fails closed and writes nothing when the archive digest mismatches', async () => {
    const expected = Buffer.from('<html>expected</html>');
    const received = Buffer.from('<html>tampered</html>');
    const sessionPath = temporarySessionPath();

    await expect(prepareVerifiedWebjsVersionCache({
      sessionPath,
      env: pinFor(expected),
      fetchImpl: vi.fn().mockResolvedValue(response(received)) as typeof fetch,
    })).rejects.toThrow(/failed SHA-256 verification/);

    expect(fs.existsSync(path.join(sessionPath, '.webjs-version-cache'))).toBe(false);
  });

  it('repairs a corrupted local artifact from the verified immutable source', async () => {
    const content = Buffer.from('<html>verified replacement</html>');
    const env = pinFor(content);
    const pin = resolveWebjsVersionPin(env);
    const sessionPath = temporarySessionPath();
    const cachePath = path.join(sessionPath, '.webjs-version-cache');
    fs.mkdirSync(cachePath);
    fs.writeFileSync(path.join(cachePath, `${pin.version}.html`), 'corrupted');
    const fetchImpl = vi.fn().mockResolvedValue(response(content));

    const prepared = await prepareVerifiedWebjsVersionCache({
      sessionPath, env, fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(prepared.cachePath, `${pin.version}.html`))).toEqual(content);
  });
});
