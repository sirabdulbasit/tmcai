// ═════════════════════════════════════════════════════════════════════════════
// envelopeEncryptionService.ts — Phase 4: Envelope encryption for personal data
//
// Architecture:
//   MEK (Master Encryption Key) — stored in GCP Secret Manager, never in env vars
//   DEK (Data Encryption Key)   — 256-bit random key per user
//                                  encrypted with MEK, stored in users.encrypted_dek
//
// Password reset is SAFE: DEK is independent of password.
// Admin cannot access personal data: DEK is only loaded into session memory.
// Key rotation: re-encrypt all DEKs with new MEK (background job, no user impact).
// ═════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('envelopeEncryption');

const ALGORITHM   = 'aes-256-gcm';
// H4 — 12 bytes is the NIST-recommended IV length for GCM. New
// ciphertexts use 12 bytes. Existing 16-byte ciphertexts remain
// decryptable because aeDecrypt reads the IV length from the encoded
// prefix — no data migration needed.
const IV_LENGTH   = 12;
const DEK_BYTES   = 32; // 256-bit DEK
const MEK_BYTES   = 32; // 256-bit MEK

// In-memory DEK cache (session-scoped — cleared on process restart)
const dekCache = new Map<number, Buffer>();

// ─── MEK helpers (reuses Secret Manager logic from configService) ─────────────

let mekCache: Buffer | null = null;

/**
 * H3 — Decode a MEK string into exactly 32 bytes.
 *
 * Accepted encodings:
 *   - base64 / base64url of 32 bytes (44 or 43 chars)
 *   - hex of 32 bytes (64 chars)
 *
 * Previously the code did `Buffer.from(str.slice(0, 32), 'utf-8')`, which
 * silently truncated to 32 UTF-8 bytes of whatever was in the env. For a
 * hex-encoded secret that meant only 128 bits of entropy landed in the
 * AES-256 key. This function now requires a canonical encoding and
 * throws on anything else, so bad config fails at startup rather than
 * quietly weakening encryption.
 */
export function decodeMEK(raw: string): Buffer {
  const trimmed = raw.trim();

  // Try hex first (only 0-9a-fA-F, length 64).
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // Try base64 (standard or url-safe). 32 bytes → 43 chars unpadded or 44
  // with padding.
  if (/^[A-Za-z0-9+/_-]{43,44}=?=?$/.test(trimmed)) {
    const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === MEK_BYTES) return buf;
  }

  throw new Error(
    `ENCRYPTION_KEY (MEK) must be 32 bytes encoded as hex (64 chars) or ` +
    `base64 (43/44 chars). Got length=${trimmed.length}.`,
  );
}

async function getMEK(): Promise<Buffer> {
  if (mekCache) return mekCache;

  if (process.env.NODE_ENV === 'production' && process.env.GCP_PROJECT_ID) {
    try {
      const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
      const client = new SecretManagerServiceClient();
      const projectId = process.env.GCP_PROJECT_ID;
      const [version] = await client.accessSecretVersion({
        name: `projects/${projectId}/secrets/tmcai-encryption-key/versions/latest`,
      });
      const secret = version.payload?.data?.toString();
      if (!secret) throw new Error('MEK from Secret Manager is empty');
      mekCache = decodeMEK(secret);
      return mekCache;
    } catch (err: any) {
      log.error('Secret Manager MEK load failed', { error: err.message });
      // Fall through to env-var path so boot doesn't hard-fail if Secret
      // Manager is transiently unavailable. The env-var path still fails
      // loudly if the value is unset or malformed.
    }
  }

  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY must be set');
  mekCache = decodeMEK(key);
  return mekCache;
}

// ─── AES-256-GCM helpers ─────────────────────────────────────────────────────

function aeEncrypt(plaintext: Buffer, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

function aeDecrypt(encoded: string, key: Buffer): Buffer {
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');
  const iv      = Buffer.from(parts[0], 'base64');
  const authTag = Buffer.from(parts[1], 'base64');
  const data    = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ─── DEK management ──────────────────────────────────────────────────────────

/**
 * Get or create the DEK for a user.
 * On first call: generates a new DEK, encrypts with MEK, stores in DB.
 * Returns the plaintext DEK (Buffer) in session memory only.
 */
export async function getUserDEK(userId: number): Promise<Buffer> {
  // Check session cache
  const cached = dekCache.get(userId);
  if (cached) return cached;

  const mek = await getMEK();

  // Check if user already has an encrypted DEK in DB
  const rows: any[] = await prisma.$queryRawUnsafe(
    'SELECT encrypted_dek FROM users WHERE id = $1',
    userId,
  );

  let dek: Buffer;
  const encryptedDek = rows[0]?.encrypted_dek;

  if (encryptedDek) {
    // Decrypt existing DEK with MEK
    dek = aeDecrypt(encryptedDek, mek);
    log.info('DEK loaded from DB', { userId });
  } else {
    // Generate new DEK, encrypt with MEK, store
    dek = crypto.randomBytes(DEK_BYTES);
    const encDek = aeEncrypt(dek, mek);
    await prisma.$executeRawUnsafe(
      'UPDATE users SET encrypted_dek = $1 WHERE id = $2',
      encDek, userId,
    );
    log.info('New DEK generated for user', { userId });
  }

  // Cache in session memory
  dekCache.set(userId, dek);
  return dek;
}

/**
 * Encrypt data using the user's DEK.
 * Used for personal_chunks content in Phase 4+.
 */
export async function encryptForUser(userId: number, plaintext: string): Promise<string> {
  const dek = await getUserDEK(userId);
  return aeEncrypt(Buffer.from(plaintext, 'utf-8'), dek);
}

/**
 * Decrypt data using the user's DEK.
 */
export async function decryptForUser(userId: number, encrypted: string): Promise<string> {
  const dek = await getUserDEK(userId);
  return aeDecrypt(encrypted, dek).toString('utf-8');
}

/**
 * Evict a user's DEK from session cache (e.g., on logout).
 */
export function evictDEKCache(userId: number): void {
  dekCache.delete(userId);
}

/**
 * DEK rotation: re-encrypt all users' DEKs with a new MEK.
 * Call this after rotating the MEK in Secret Manager.
 * Runs as a background job — no user impact.
 */
export async function rotateMEK(newMEK: Buffer): Promise<{ rotated: number; errors: number }> {
  const oldMEK = await getMEK();
  const users: any[] = await prisma.$queryRawUnsafe(
    'SELECT id, encrypted_dek FROM users WHERE encrypted_dek IS NOT NULL',
  );

  let rotated = 0, errors = 0;
  for (const user of users) {
    try {
      const dek = aeDecrypt(user.encrypted_dek, oldMEK);
      const newEncDek = aeEncrypt(dek, newMEK);
      await prisma.$executeRawUnsafe(
        'UPDATE users SET encrypted_dek = $1 WHERE id = $2',
        newEncDek, user.id,
      );
      dekCache.delete(user.id); // Invalidate session cache
      rotated++;
    } catch (e: any) {
      log.error('DEK rotation failed for user', { userId: user.id, error: e.message });
      errors++;
    }
  }

  // Update MEK cache to new key
  mekCache = newMEK;
  log.info('MEK rotation complete', { rotated, errors });
  return { rotated, errors };
}
