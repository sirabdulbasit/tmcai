/**
 * DEF-369 — in production the integration secret store could store NOTHING.
 *
 * Owner 10-31 ("see", Connect screenshot): the test still said "no credential
 * has been entered" after the document was re-attached. Server log: "api
 * document keys not kept: encryption unavailable — The server encryption key is
 * malformed", keysKept 0, and not one "integration secret stored" line ever.
 * Production's ENCRYPTION_KEY is the configService key (a ≥32-char string), not
 * a canonical 32-byte hex/base64 MEK, and secretStore accepted only the latter.
 * Every earlier test used a canonical random hex key, so none could see it.
 *
 * Pinned:
 *  1. a ≥32-character string key round-trips (the production shape);
 *  2. below 32 characters still throws (fail closed, as configService);
 *  3. a canonical MEK still works, and the two derivations differ;
 *  4. a different string key cannot read the ciphertext;
 *  5. testApi names an example address BEFORE asking for a credential.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
const db = vi.hoisted(() => ({ secretReads: 0 }));
vi.mock('../src/db/prisma', () => ({
  __esModule: true,
  default: { integrationSync: { findFirst: async () => { db.secretReads++; return { secretEnc: null }; } } },
}));

import { decryptSecret, encryptSecret } from '../src/services/integrations/store/secretStore';
import { testApi } from '../src/services/integrations/sources/apiReader';
import { CredentialUnreadableError } from '../src/services/integrations/types';

// The production shape: a long passphrase-like string, NOT 64 hex / 44 base64.
const STRING_KEY = 'tmcai-prod-key-2026!long-enough-to-pass-configService';
const OTHER_STRING_KEY = 'another-long-configservice-style-key-of-40-plus-chars';
let saved: string | undefined;
beforeEach(() => { saved = process.env.ENCRYPTION_KEY; db.secretReads = 0; });
afterEach(() => { if (saved === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = saved; });

describe('DEF-369 the secret store accepts production\'s ENCRYPTION_KEY', () => {
  it('a ≥32-character string key round-trips', () => {
    process.env.ENCRYPTION_KEY = STRING_KEY;
    const enc = encryptSecret('x-api-key-value-123456');
    expect(enc).toMatch(/^v1:/);
    expect(decryptSecret(enc)).toBe('x-api-key-value-123456');
  });

  it('below 32 characters is still refused (fail closed)', () => {
    process.env.ENCRYPTION_KEY = 'short-key-only-20chr';
    expect(() => encryptSecret('k')).toThrow(CredentialUnreadableError);
  });

  it('a canonical MEK still works, and the two derivations are different keys', () => {
    const hex = randomBytes(32).toString('hex');
    process.env.ENCRYPTION_KEY = hex;
    const fromHex = encryptSecret('same-plaintext-value');
    expect(decryptSecret(fromHex)).toBe('same-plaintext-value');
    process.env.ENCRYPTION_KEY = STRING_KEY;
    expect(() => decryptSecret(fromHex)).toThrow(CredentialUnreadableError);
  });

  it('a different string key cannot read the ciphertext', () => {
    process.env.ENCRYPTION_KEY = STRING_KEY;
    const enc = encryptSecret('secret-value-abcdef');
    process.env.ENCRYPTION_KEY = OTHER_STRING_KEY;
    expect(() => decryptSecret(enc)).toThrow(CredentialUnreadableError);
  });
});

describe('DEF-369 the example address is named before the missing credential', () => {
  it('your-domain.com with no stored key: the reason is the address, and no secret is even read', async () => {
    const r = await testApi('TENANT_A', {
      id: 'i1', sourceKind: 'api',
      apiConfig: {
        baseUrl: 'https://your-domain.com', method: 'GET', path: '/taql/api/employee/directory', query: {},
        authScheme: 'API_KEY', authHeaderName: 'x-api-key', recordsPath: 'data', idField: 'id', pagination: { kind: 'none' },
      } as any,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/document's example \(your-domain\.com\)/);
    expect(r.reason).not.toMatch(/no credential/);
    expect(db.secretReads).toBe(0);
  });
});
