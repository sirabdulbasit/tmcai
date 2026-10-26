/**
 * DEF-362 — Integrations Stage 1b: the API secret, encrypted at rest.
 *
 * Spec: server/docs/INTEGRATIONS_DESIGN.md §2b ("The model never chooses or
 * stores a secret: the admin types it into a secret field; it is encrypted
 * (AES-256-GCM, key HKDF-derived from ENCRYPTION_KEY via the strict decodeMEK,
 * own `v1:` prefix — not configService, see DEF-356) and never returned").
 *
 * Why its own envelope and not configService / envelopeEncryptionService:
 *   - configService's secret handling is the subject of DEF-356 (open);
 *     building on it would inherit that defect.
 *   - envelopeEncryptionService encrypts PERSONAL data under per-user DEKs; an
 *     integration credential belongs to the tenant, not to a user, and must be
 *     readable by the scheduler with no user session. We reuse only its STRICT
 *     MEK decoder, so a malformed ENCRYPTION_KEY is refused the same way.
 *   - HKDF with a purpose-specific `info` gives this store a key no other
 *     subsystem holds: a ciphertext from elsewhere cannot be fed in here, and
 *     vice versa.
 *
 * Fails closed: no key, a bad key, a tampered value or an unknown format all
 * THROW — nothing ever falls back to sending a request without the credential
 * or with a different one. Plaintext is never logged.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { decodeMEK } from '../../envelopeEncryptionService';
import {
  CredentialUnreadableError,
  IntegrationInputError,
  IntegrationNotFoundError,
  type SecretStoreModule,
  type SetSecretResult,
} from '../types';

const log = createLogger('integrations-secret');

const PREFIX = 'v1';
const HKDF_INFO = 'nexeo/integrations/secret/v1';
/** 12 bytes: the NIST-recommended GCM IV length (same as envelopeEncryptionService H4). */
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A credential longer than this is not a credential; refuse rather than store a document. */
const MAX_SECRET_CHARS = 8192;

/** Derived per call, never cached: a rotated ENCRYPTION_KEY takes effect at once,
 *  and tests can swap the env without a reset hook. HKDF is microseconds. */
function deriveKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || !raw.trim()) {
    throw new CredentialUnreadableError('The server has no encryption key, so the API credential cannot be stored or read.');
  }
  let mek: Buffer;
  try {
    mek = decodeMEK(raw);
  } catch {
    // decodeMEK's own message names the key length; keep the admin message plain.
    throw new CredentialUnreadableError('The server encryption key is malformed, so the API credential cannot be stored or read.');
  }
  return Buffer.from(hkdfSync('sha256', mek, Buffer.alloc(0), HKDF_INFO, 32));
}

/** Pure: plaintext → 'v1:<b64 iv>:<b64 tag>:<b64 ct>'. Exported for tests. */
export function encryptSecret(plain: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** Pure: the inverse. Throws CredentialUnreadableError on ANY problem — wrong
 *  prefix, wrong shape, wrong key, tampered bytes. Exported for tests. */
export function decryptSecret(enc: string): string {
  const parts = typeof enc === 'string' ? enc.split(':') : [];
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new CredentialUnreadableError('The stored API credential is in an unknown format. Enter it again.');
  }
  const key = deriveKey();
  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('bad envelope');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new CredentialUnreadableError('The stored API credential could not be decrypted (the server key changed or the value was altered). Enter it again.');
  }
}

export const setSecret: SecretStoreModule['setSecret'] = async (cn, integrationId, plain, opts = {}) => {
  const exists = await prisma.integrationSync.findFirst({
    where: { id: integrationId, clientNumber: cn },
    select: { id: true, status: true },
  });
  if (!exists) throw new IntegrationNotFoundError(integrationId);
  // DEF-362 review: the same rule updateIntegration applies to api_config. A
  // new credential is a new connection (secret_set_at is in the fingerprint),
  // and an ACTIVE row would read with it at its next slot — another account's
  // records, written with no dry run ever having seen them. Refused BEFORE the
  // candidate is sent anywhere.
  if (exists.status === 'ACTIVE') {
    throw new IntegrationInputError('Pause this integration before changing its credential.', 'secret');
  }

  const value = typeof plain === 'string' ? plain.trim() : '';
  if (!value) return { stored: false, test: null, reason: 'Enter the credential first.' } satisfies SetSecretResult;
  if (value.length > MAX_SECRET_CHARS) {
    return { stored: false, test: null, reason: 'That is too long to be an API credential.' };
  }

  // Encrypt BEFORE testing: a missing/bad server key must refuse here, not
  // after the candidate has already been sent to the outside system.
  const enc = encryptSecret(value);

  let test: SetSecretResult['test'] = null;
  if (opts.testFirst) {
    test = await opts.testFirst(value);
    if (!test.ok) {
      // Spec §2b: a secret that fails is not stored over one that works.
      log.info('integration secret not stored: test failed', { cn, integrationId });
      return { stored: false, test, reason: test.reason || 'The connection test failed with this credential.' };
    }
  }

  // A new credential is a new connection: clear the test so turn-on demands a
  // fresh one (vm §9 "the tested connection is the one runs use").
  const res = await prisma.integrationSync.updateMany({
    where: { id: integrationId, clientNumber: cn },
    data: { secretEnc: enc, secretSetAt: new Date(), connectionTestedAt: null, connectionFingerprint: null },
  });
  if (res.count === 0) throw new IntegrationNotFoundError(integrationId);
  log.info('integration secret stored', { cn, integrationId, tested: !!opts.testFirst });
  return { stored: true, test };
};

export const hasSecret: SecretStoreModule['hasSecret'] = async (cn, integrationId) => {
  const row = await prisma.integrationSync.findFirst({
    where: { id: integrationId, clientNumber: cn },
    select: { secretEnc: true },
  });
  return !!row?.secretEnc;
};

export const getSecret: SecretStoreModule['getSecret'] = async (cn, integrationId) => {
  const row = await prisma.integrationSync.findFirst({
    where: { id: integrationId, clientNumber: cn },
    select: { secretEnc: true },
  });
  if (!row) throw new IntegrationNotFoundError(integrationId);
  if (!row.secretEnc) return null;
  return decryptSecret(row.secretEnc);
};
