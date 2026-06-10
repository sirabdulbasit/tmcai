import crypto from 'crypto';
import bcrypt from 'bcrypt';
import prisma from '../db/prisma';
import { getUserTypeConfig } from '../config/userTypes';
import { getConfig } from './configService';
import { sendPasswordChangedEmail } from './inviteService';

// M12 — bumped from 10 (2020-era) to 12 (2024+ guidance). Existing
// users keep their 10-round hashes until their next password change;
// this is forward-safe because bcrypt.compare reads the cost from the
// stored hash. For eager upgrades, re-hash on successful login.
const SALT_ROUNDS = 12;
const TOKEN_LENGTH = 64;

// C2 — Session tokens are hashed at rest. The bearer token returned to the
// client is the raw `token`; only `sha256(token)` is stored in `sessions`.
// Lookups use the hash, so a read-only DB leak cannot impersonate users.
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// H5 — Dummy hash used to equalise timing when the submitted identifier
// matches no user. Generated once at module load so the per-request work
// is a bcrypt.compare against a real 12-round hash, matching the real
// login path's CPU profile. The secret content is irrelevant; no user can
// ever have this hash because bcrypt hashes are unique per salt.
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('decoy-password-no-user-has-this', SALT_ROUNDS);

// Read security settings from system_config (with fallback defaults)
async function getSecurityConfig(clientNumber: string) {
  const get = async (key: string, fallback: string) => (await getConfig(clientNumber, key)) || fallback;
  return {
    maxAttempts: parseInt(await get('max_login_attempts', '5')),
    lockoutMinutes: parseInt(await get('lockout_minutes', '30')),
    sessionHours: parseInt(await get('session_hours', '72')),
    passwordMinLength: parseInt(await get('password_min_length', '8')),
    requireUppercase: (await get('password_require_uppercase', 'true')) === 'true',
    requireNumber: (await get('password_require_number', 'true')) === 'true',
    requireSpecial: (await get('password_require_special', 'true')) === 'true',
  };
}

export function validatePasswordComplexity(password: string, config: { passwordMinLength: number; requireUppercase: boolean; requireNumber: boolean; requireSpecial: boolean }): string | null {
  if (password.length < config.passwordMinLength) return `Password must be at least ${config.passwordMinLength} characters`;
  if (config.requireUppercase && !/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (config.requireNumber && !/[0-9]/.test(password)) return 'Password must contain at least one number';
  if (config.requireSpecial && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) return 'Password must contain at least one special character';
  return null;
}

// ─── User Management ───────────────────────────────────────────

export async function createUser(data: {
  clientNumber: string;
  empcode: string;
  name: string;
  email: string;
  password: string;
  userType: string;
  department?: string;
  /** Optional ISO-8601 string for demo accounts. demoExpirySuspendJob
   *  auto-suspends the user once this passes. NULL = permanent. */
  expiresAt?: string | null;
}) {
  const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);
  return prisma.user.create({
    data: {
      clientNumber: data.clientNumber,
      empcode: data.empcode,
      name: data.name,
      email: data.email,
      passwordHash,
      userType: data.userType,
      department: data.department,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    },
  });
}

// ─── Authentication ────────────────────────────────────────────

export interface AuthResult {
  success: boolean;
  token?: string;
  user?: TokenUser;
  error?: string;
  locked?: boolean;
}

export async function login(identifier: string, password: string, meta?: { userAgent?: string; ip?: string }): Promise<AuthResult> {
  const user = await prisma.user.findFirst({
    where: { OR: [{ email: identifier }, { empcode: identifier }] },
  });

  // H5 — When the identifier matches no user OR the account is disabled,
  // still run a bcrypt compare against a dummy hash so the response time
  // matches the real path. This closes the account-enumeration oracle
  // that previously let attackers distinguish "user not found" (fast)
  // from "wrong password" (slow) by timing alone.
  if (!user || !user.isActive) {
    await bcrypt.compare(password, DUMMY_BCRYPT_HASH).catch(() => false);
    return { success: false, error: 'Invalid credentials' };
  }

  const sec = await getSecurityConfig(user.clientNumber);

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    return { success: false, error: `Account locked. Try again in ${minutesLeft} minutes.`, locked: true };
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    const attempts = user.failedAttempts + 1;
    const lockData: any = { failedAttempts: attempts };
    if (attempts >= sec.maxAttempts) {
      lockData.lockedUntil = new Date(Date.now() + sec.lockoutMinutes * 60 * 1000);
    }
    await prisma.user.update({ where: { id: user.id }, data: lockData });
    if (attempts >= sec.maxAttempts) {
      return { success: false, error: `Account locked for ${sec.lockoutMinutes} minutes.`, locked: true };
    }
    return { success: false, error: `Invalid credentials. ${sec.maxAttempts - attempts} attempts remaining.` };
  }

  const token = crypto.randomBytes(TOKEN_LENGTH / 2).toString('hex');
  const expiresAt = new Date(Date.now() + sec.sessionHours * 60 * 60 * 1000);

  await prisma.session.create({
    data: { tokenHash: hashToken(token), userId: user.id, expiresAt, userAgent: meta?.userAgent?.slice(0, 500), ipAddress: meta?.ip?.slice(0, 50) },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  const config = getUserTypeConfig(user.userType);
  return {
    success: true,
    token,
    user: {
      id: user.id,
      clientNumber: user.clientNumber,
      empcode: user.empcode,
      name: user.name,
      email: user.email,
      department: user.department,
      userType: user.userType,
      ...config,
    },
  };
}

// ─── Session Validation ────────────────────────────────────────

export interface TokenUser {
  id: number;
  clientNumber: string;
  empcode: string;
  name: string;
  email: string;
  department: string | null;
  userType: string;
  label: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  allowedProviders: string[];
  internetAccess: string;
  maxScheduledTasks: number;
  canExport: boolean;
}

export async function validateToken(token: string): Promise<TokenUser | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session || session.isRevoked || session.expiresAt < new Date() || !session.user.isActive) return null;

  const user = session.user;
  const config = getUserTypeConfig(user.userType);

  return {
    id: user.id,
    clientNumber: user.clientNumber,
    empcode: user.empcode,
    name: user.name,
    email: user.email,
    department: user.department,
    userType: user.userType,
    ...config,
  };
}

export async function logout(token: string): Promise<void> {
  await prisma.session.update({ where: { tokenHash: hashToken(token) }, data: { isRevoked: true } }).catch(() => {});
}

export async function changePassword(userId: number, currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { success: false, error: 'User not found' };
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) return { success: false, error: 'Current password is incorrect' };

  const sec = await getSecurityConfig(user.clientNumber);
  const complexityError = validatePasswordComplexity(newPassword, sec);
  if (complexityError) return { success: false, error: complexityError };

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  // Send confirmation email
  sendPasswordChangedEmail(userId).catch(() => {});

  return { success: true };
}

export async function resetPassword(clientNumber: string, empcode: string): Promise<{ success: boolean; tempPassword?: string; error?: string }> {
  const tempPassword = crypto.randomBytes(4).toString('hex');
  const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
  try {
    await prisma.user.update({
      where: { clientNumber_empcode: { clientNumber, empcode } },
      data: { passwordHash, failedAttempts: 0, lockedUntil: null },
    });
    return { success: true, tempPassword };
  } catch {
    return { success: false, error: 'User not found' };
  }
}
