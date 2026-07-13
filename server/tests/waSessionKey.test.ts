import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  safeSegment,
  userSessionKey,
  hardenSessionDir,
  migrateLegacyUserSession,
} from '../src/services/whatsapp/waSessionKey';

// E2 — LocalAuth session dirs hold live WhatsApp auth tokens and message
// history. Keys must be collision-free (tenant+user), path-safe, and the
// directories locked to 0700 and owned by us before a client initializes.

describe('safeSegment', () => {
  it('accepts alphanumerics, dash, underscore', () => {
    expect(safeSegment('tmc-01_A')).toBe('tmc-01_A');
  });
  it.each(['../evil', 'a/b', 'a\\b', '', ' ', 'a b', 'a\0b'])('rejects %j', (bad) => {
    expect(() => safeSegment(bad as string)).toThrow();
  });
});

describe('userSessionKey', () => {
  it('binds tenant AND user so ids can never collide across tenants', () => {
    expect(userSessionKey('tmc', 7)).toBe('tmc-u7');
  });
  it('rejects unsafe tenant ids', () => {
    expect(() => userSessionKey('../x', 7)).toThrow();
  });
});

describe('hardenSessionDir', () => {
  it('creates missing dirs with 0700', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-key-')) + '/newdir';
    hardenSessionDir(dir);
    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });
  it('tightens existing dirs to 0700', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-key-'));
    fs.chmodSync(dir, 0o755);
    hardenSessionDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('migrateLegacyUserSession', () => {
  it('renames a legacy session dir to the tenant-scoped key once', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mig-'));
    fs.mkdirSync(path.join(base, 'session-u7'));
    migrateLegacyUserSession(base, 'u7', 'tmc-u7');
    expect(fs.existsSync(path.join(base, 'session-tmc-u7'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'session-u7'))).toBe(false);
  });
  it('no-ops when the new dir already exists (never clobbers)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mig-'));
    fs.mkdirSync(path.join(base, 'session-u7'));
    fs.mkdirSync(path.join(base, 'session-tmc-u7'));
    fs.writeFileSync(path.join(base, 'session-tmc-u7', 'keep.txt'), 'x');
    migrateLegacyUserSession(base, 'u7', 'tmc-u7');
    expect(fs.existsSync(path.join(base, 'session-u7'))).toBe(true);
    expect(fs.readFileSync(path.join(base, 'session-tmc-u7', 'keep.txt'), 'utf8')).toBe('x');
  });
  it('no-ops when there is no legacy dir', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mig-'));
    expect(() => migrateLegacyUserSession(base, 'u7', 'tmc-u7')).not.toThrow();
  });
});
