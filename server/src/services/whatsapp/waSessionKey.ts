// ═════════════════════════════════════════════════════════════════════════════
// waSessionKey — collision-free, path-safe keys + hardened permissions for
// whatsapp-web.js LocalAuth session directories.
//
// E2 (2026-07-08): session dirs hold LIVE WhatsApp auth tokens and message
// history. Three guarantees before any client initializes:
//   1. Keys are validated ([A-Za-z0-9_-] only) — a malformed tenant id can
//      never traverse outside the session root.
//   2. User sessions are keyed <clientNumber>-u<userId> so a userId can
//      never collide across tenants.
//   3. Session dirs are chmod 0700 and must be owned by this process's uid.
// ═════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';

const SAFE_RE = /^[A-Za-z0-9_-]+$/;

/** Validate a single path segment used in a session key. Throws on anything
 *  that could traverse or confuse the filesystem. Fail closed. */
export function safeSegment(raw: string): string {
  if (typeof raw !== 'string' || !SAFE_RE.test(raw)) {
    throw new Error(`unsafe session-key segment: ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** Tenant Brain-number session key (one per tenant; clientNumber is a PK). */
export function tenantSessionKey(clientNumber: string): string {
  return safeSegment(clientNumber);
}

/** User-paired session key — tenant AND user bound, collision-free. */
export function userSessionKey(clientNumber: string, userId: number): string {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`unsafe userId for session key: ${String(userId)}`);
  }
  return `${safeSegment(clientNumber)}-u${userId}`;
}

/** Create (or tighten) a session directory: mode 0700, owned by us.
 *  Throws if an existing dir is owned by another uid — never initialize a
 *  WhatsApp client on top of someone else's session state. */
export function hardenSessionDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const st = fs.statSync(dir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`session dir ${dir} is owned by uid ${st.uid}, not us (${process.getuid()})`);
  }
  if ((st.mode & 0o777) !== 0o700) {
    fs.chmodSync(dir, 0o700);
  }
}

/** One-time move of a pre-E2 user session (`session-u<id>`) to the
 *  tenant-scoped key, preserving the existing pairing so users don't have
 *  to re-scan the QR. Never clobbers an existing new-style dir. */
export function migrateLegacyUserSession(dataPath: string, legacyKey: string, newKey: string): void {
  const legacyDir = path.join(dataPath, `session-${legacyKey}`);
  const newDir = path.join(dataPath, `session-${newKey}`);
  if (!fs.existsSync(legacyDir) || fs.existsSync(newDir)) return;
  fs.renameSync(legacyDir, newDir);
}
