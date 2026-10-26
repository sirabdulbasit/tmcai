/**
 * DEF-362 — Integrations Stage 1b: the API secret store (spec §2b).
 *
 * Pins:
 *  1. AES-256-GCM round trip in the 'v1:<iv>:<tag>:<ct>' envelope; the stored
 *     column never holds the plaintext.
 *  2. Fail closed: a tampered ciphertext, a wrong prefix, a missing or
 *     malformed ENCRYPTION_KEY, or a different key all THROW
 *     CredentialUnreadableError — never return garbage or an empty credential.
 *  3. The key is HKDF-derived for THIS purpose: the raw MEK used directly as an
 *     AES key cannot open the value (falsifier: drop the HKDF step).
 *  4. "A secret that fails is not stored over one that works": a failing
 *     testFirst leaves the previous ciphertext untouched.
 *  5. Storing a secret clears the connection test (a new credential is a new
 *     connection), and every query is tenant-scoped — another tenant's id is
 *     not found.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDecipheriv, randomBytes } from 'crypto';
import { makeFakeDb } from './def354IntegrationFakeDb';

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/db/prisma', () => {
  const p = new Proxy({}, { get: (_t, k) => h.db.prisma[k] });
  return { __esModule: true, default: p, prisma: p };
});

import {
  decryptSecret, encryptSecret, getSecret, hasSecret, setSecret,
} from '../src/services/integrations/store/secretStore';
import { CredentialUnreadableError, IntegrationNotFoundError } from '../src/services/integrations/types';

const CN = 'TMC-0001';
const KEY_A = randomBytes(32).toString('hex');
const KEY_B = randomBytes(32).toString('hex');
const SECRET = 'sk_live_51Hx-very-secret-token';
let savedKey: string | undefined;

function seed(extra: Record<string, unknown> = {}) {
  return h.db.insert('integrationSync', {
    clientNumber: CN, name: 'Billing API', sourceKind: 'api', createdBy: 1,
    connectionTestedAt: new Date(), connectionFingerprint: 'f'.repeat(64), ...extra,
  });
}

beforeEach(() => {
  h.db = makeFakeDb();
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = KEY_A;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
});

describe('DEF-362 secret envelope', () => {
  it('round-trips through the v1 envelope, with a fresh IV each time', () => {
    const a = encryptSecret(SECRET);
    const b = encryptSecret(SECRET);
    expect(a).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(a).not.toContain(SECRET);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(SECRET);
    expect(decryptSecret(b)).toBe(SECRET);
  });

  it('a tampered ciphertext or tag throws, never returns altered plaintext', () => {
    const enc = encryptSecret(SECRET);
    const [p, iv, tag, ct] = enc.split(':');
    const ctBuf = Buffer.from(ct, 'base64');
    ctBuf[0] ^= 0x01;
    expect(() => decryptSecret([p, iv, tag, ctBuf.toString('base64')].join(':'))).toThrow(CredentialUnreadableError);
    const tagBuf = Buffer.from(tag, 'base64');
    tagBuf[3] ^= 0x80;
    expect(() => decryptSecret([p, iv, tagBuf.toString('base64'), ct].join(':'))).toThrow(CredentialUnreadableError);
  });

  it('a wrong or missing prefix throws', () => {
    const enc = encryptSecret(SECRET);
    expect(() => decryptSecret(enc.replace(/^v1:/, 'v2:'))).toThrow(CredentialUnreadableError);
    expect(() => decryptSecret(enc.replace(/^v1:/, ''))).toThrow(CredentialUnreadableError);
    expect(() => decryptSecret(SECRET)).toThrow(CredentialUnreadableError);
  });

  it('a missing or malformed ENCRYPTION_KEY throws on both encrypt and decrypt (fail closed)', () => {
    const enc = encryptSecret(SECRET);
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptSecret(SECRET)).toThrow(CredentialUnreadableError);
    expect(() => decryptSecret(enc)).toThrow(CredentialUnreadableError);
    process.env.ENCRYPTION_KEY = 'too-short';
    expect(() => encryptSecret(SECRET)).toThrow(CredentialUnreadableError);
    expect(() => decryptSecret(enc)).toThrow(CredentialUnreadableError);
  });

  it('a different server key cannot open it', () => {
    const enc = encryptSecret(SECRET);
    process.env.ENCRYPTION_KEY = KEY_B;
    expect(() => decryptSecret(enc)).toThrow(CredentialUnreadableError);
  });

  it('the AES key is HKDF-derived, not the raw MEK', () => {
    const [, iv, tag, ct] = encryptSecret(SECRET).split(':');
    const d = createDecipheriv('aes-256-gcm', Buffer.from(KEY_A, 'hex'), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    expect(() => Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()])).toThrow();
  });
});

describe('DEF-362 secret store', () => {
  it('stores ciphertext only, reports hasSecret, returns the plaintext to getSecret, clears the connection test', async () => {
    const row = seed();
    expect(await hasSecret(CN, row.id)).toBe(false);
    expect(await getSecret(CN, row.id)).toBeNull();

    const r = await setSecret(CN, row.id, `  ${SECRET}  `);
    expect(r).toEqual({ stored: true, test: null });
    expect(row.secretEnc).toMatch(/^v1:/);
    expect(row.secretEnc).not.toContain(SECRET);
    expect(row.secretSetAt).toBeInstanceOf(Date);
    expect(row.connectionTestedAt).toBeNull();
    expect(row.connectionFingerprint).toBeNull();
    expect(await hasSecret(CN, row.id)).toBe(true);
    expect(await getSecret(CN, row.id)).toBe(SECRET);
  });

  it('a secret whose test fails is NOT stored over one that works', async () => {
    const row = seed();
    await setSecret(CN, row.id, SECRET);
    const before = row.secretEnc;
    const testFirst = vi.fn(async () => ({ ok: false, rows: 0, columns: [], sampleRow: null, reason: '401 Unauthorized' }));
    const r = await setSecret(CN, row.id, 'wrong-key', { testFirst });
    expect(testFirst).toHaveBeenCalledWith('wrong-key');
    expect(r.stored).toBe(false);
    expect(r.reason).toBe('401 Unauthorized');
    expect(row.secretEnc).toBe(before);
    expect(await getSecret(CN, row.id)).toBe(SECRET);
  });

  it('a secret whose test passes is stored', async () => {
    const row = seed();
    const test = { ok: true, rows: 3, columns: ['id'], sampleRow: { id: '1' } };
    const r = await setSecret(CN, row.id, SECRET, { testFirst: async () => test });
    expect(r).toEqual({ stored: true, test });
    expect(await getSecret(CN, row.id)).toBe(SECRET);
  });

  it('an empty secret is refused and nothing is written', async () => {
    const row = seed();
    const r = await setSecret(CN, row.id, '   ');
    expect(r.stored).toBe(false);
    expect(row.secretEnc).toBeUndefined();
  });

  it('getSecret on an unreadable stored value throws CredentialUnreadableError (no silent null)', async () => {
    const row = seed();
    await setSecret(CN, row.id, SECRET);
    process.env.ENCRYPTION_KEY = KEY_B;
    await expect(getSecret(CN, row.id)).rejects.toBeInstanceOf(CredentialUnreadableError);
  });

  it('is tenant-scoped: another tenant cannot set, read or see the secret', async () => {
    const row = seed();
    await setSecret(CN, row.id, SECRET);
    await expect(setSecret('TMC-0002', row.id, 'x')).rejects.toBeInstanceOf(IntegrationNotFoundError);
    await expect(getSecret('TMC-0002', row.id)).rejects.toBeInstanceOf(IntegrationNotFoundError);
    expect(await hasSecret('TMC-0002', row.id)).toBe(false);
    for (const c of h.db.calls) expect(c.args.where.clientNumber).toBeDefined();
  });
});
