import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { login, logout, changePassword, createUser, resetPassword, validatePasswordComplexity } from '../services/authService';
import { evictDEKCache } from '../services/envelopeEncryptionService';
import { requireAuth, requireAdmin, TOKEN_COOKIE } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { loginSchema, changePasswordSchema, createUserSchema, setupPasswordSchema, forgotPasswordSchema } from '../schemas/auth';
import { validateSeatAvailability } from '../services/licenseService';
import { isValidUserType } from '../config/userTypes';
import { getConfig } from '../services/configService';
import { sendInvitation, setupPassword, validateInviteToken, sendPasswordReset, getClientTransporter } from '../services/inviteService';
import prisma from '../db/prisma';

const router = Router();

// Rate limiting for auth endpoints (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests. Please try again later.' },
});

// ─── Login (email/empcode + password) ──────────────────────────

router.post('/login', authLimiter, validate(loginSchema), async (req: Request, res: Response) => {
  const { email, empcode, password } = req.body;
  const identifier = email || empcode;

  const result = await login(identifier, password, {
    userAgent: req.headers['user-agent'] as string,
    ip: req.ip,
  });

  if (!result.success) {
    res.status(result.locked ? 423 : 401).json({ error: result.error });
    return;
  }

  res.cookie(TOKEN_COOKIE, result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 72 * 60 * 60 * 1000,
  });

  res.json({ success: true, user: result.user });
});

// ─── Logout ────────────────────────────────────────────────────

router.post('/logout', requireAuth, async (req: Request, res: Response) => {
  const token = req.cookies?.[TOKEN_COOKIE];
  if (token) await logout(token);
  // Evict DEK from session cache — personal data no longer accessible
  if (req.user?.id) evictDEKCache(req.user.id);
  res.clearCookie(TOKEN_COOKIE);
  res.json({ success: true });
});

// ─── Current User ──────────────────────────────────────────────

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  // Include the tenant's display name so the UI can render
  // "Acme Corp" badges instead of system words like "Tenant" or
  // raw client_numbers like "TMC-0001".
  let tenantName: string | null = null;
  try {
    const t = await (await import('../db/prisma')).default.tenant.findUnique({
      where: { clientNumber: req.user!.clientNumber },
      select: { name: true },
    });
    tenantName = t?.name ?? null;
  } catch { /* fall through with null */ }
  res.json({
    user: req.user,
    tenant: { clientNumber: req.user!.clientNumber, name: tenantName },
  });
});

// ─── Change Password ───────────────────────────────────────────

router.post('/change-password', requireAuth, validate(changePasswordSchema), async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body;
  const result = await changePassword(req.user!.id, currentPassword, newPassword);
  if (!result.success) { res.status(400).json({ error: result.error }); return; }
  res.json({ success: true });
});

// ─── Admin: Create User ────────────────────────────────────────

router.post('/users', requireAuth, requireAdmin, validate(createUserSchema), async (req: Request, res: Response) => {
  const { empcode, name, email, password, userType, department, clientNumber: reqClientNumber, expiresAt } = req.body;

  // Validate password complexity from system_config
  const targetClient = req.user!.isSuperAdmin && reqClientNumber ? reqClientNumber : req.user!.clientNumber;
  const minLen = parseInt(await getConfig(targetClient, 'password_min_length') || '8');
  const reqUpper = (await getConfig(targetClient, 'password_require_uppercase') || 'true') === 'true';
  const reqNum = (await getConfig(targetClient, 'password_require_number') || 'true') === 'true';
  const reqSpecial = (await getConfig(targetClient, 'password_require_special') || 'true') === 'true';
  const pwError = validatePasswordComplexity(password, { passwordMinLength: minLen, requireUppercase: reqUpper, requireNumber: reqNum, requireSpecial: reqSpecial });
  if (pwError) { res.status(400).json({ error: pwError }); return; }

  // Admin can only create ST and BS users. SA and AD require SuperAdmin.
  if ((userType === 'SA' || userType === 'AD') && !req.user!.isSuperAdmin) {
    res.status(403).json({ error: 'Only SuperAdmin can create Admin or SuperAdmin users' });
    return;
  }

  // Validate seat availability
  const seatCheck = await validateSeatAvailability(targetClient, userType);
  if (!seatCheck.allowed) { res.status(403).json({ error: seatCheck.error }); return; }

  try {
    const user = await createUser({ clientNumber: targetClient, empcode, name, email, password, userType, department, expiresAt });
    res.status(201).json({ success: true, user: { id: user.id, empcode: user.empcode, name: user.name, email: user.email, userType: user.userType, expiresAt: user.expiresAt } });
  } catch (error: any) {
    if (error.code === 'P2002') { res.status(409).json({ error: 'User with this empcode or email already exists' }); return; }
    res.status(500).json({ error: error.message });
  }
});

// ─── Admin: Reset Password ─────────────────────────────────────

router.post('/users/:empcode/reset-password', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const result = await resetPassword(req.user!.clientNumber, req.params.empcode as string);
  if (!result.success) { res.status(400).json({ error: result.error }); return; }
  res.json({ success: true, tempPassword: result.tempPassword });
});

// ─── Voice transcript backfill ─────────────────────────────────
// Runs the backfill IN this server process (where the in-memory
// webjs clients live). CLI scripts spawn a fresh Node process and
// see an empty clients Map — that's why running ts-node returned
// skipped(no-client)=N for every row.
//
// Default scope: caller's own user. Passing userId in the body to
// backfill someone else's data is gated to admins/super-admins so a
// regular user can't read another user's voice notes.
router.post('/voice-backfill', requireAuth, async (req: Request, res: Response) => {
  const caller = (req as any).user;
  const apply = !!req.body?.apply;
  const requestedUserId = req.body?.userId ? Number(req.body.userId) : null;
  let userId = caller.id;
  if (requestedUserId && requestedUserId !== caller.id) {
    if (!caller.isAdmin && !caller.isSuperAdmin) {
      return res.status(403).json({ error: 'admin required to backfill another user' });
    }
    userId = requestedUserId;
  }
  const limit = req.body?.limit ? Math.max(1, Math.min(500, Number(req.body.limit))) : 200;
  try {
    const { backfillVoiceTranscriptsInProcess } =
      await import('../services/whatsapp/UserWebjsProvider');
    const result = await backfillVoiceTranscriptsInProcess({ apply, userId, limit });
    res.json({ ok: true, mode: apply ? 'apply' : 'dry-run', userId, limit, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'backfill failed' });
  }
});

// ─── Admin: SMTP Health / Test ─────────────────────────────────
// Verifies the tenant's SMTP transport via SMTP handshake (does NOT
// send a real message). Used by Client Config → Email/SMTP to surface
// misconfiguration that the public forgot-password flow swallows on
// purpose. Admin-only so we can return real error text without enabling
// public email-enumeration probes.
router.post('/smtp-test', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const requestedClient = (req.body?.clientNumber as string | undefined)?.trim();
  const clientNumber = req.user!.isSuperAdmin && requestedClient
    ? requestedClient
    : req.user!.clientNumber;
  try {
    const transporter = await getClientTransporter(clientNumber);
    await transporter.verify();
    const fromAddr = await getConfig(clientNumber, 'smtp_from') || process.env.SMTP_FROM || '';
    res.json({ ok: true, clientNumber, fromAddr, message: 'SMTP handshake succeeded.' });
  } catch (err: any) {
    res.json({ ok: false, clientNumber, error: err?.message || 'SMTP test failed' });
  }
});

// ─── Send Invitation Email ─────────────────────────────────────

router.post('/users/:id/invite', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id as string);
    if (isNaN(userId)) { res.status(400).json({ error: 'Invalid user ID' }); return; }
    const baseUrl = req.body.baseUrl || `${req.protocol}://${req.get('host')}`.replace(':4002', ':5174'); // client URL
    const result = await sendInvitation(userId, req.user!.clientNumber, baseUrl);
    if (!result.success) { res.status(400).json({ error: result.error }); return; }
    res.json({ success: true, message: 'Invitation sent' });
  } catch (err: any) {
    console.error('[Invite Route] Error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send invitation' });
  }
});

// ─── Public: Get Password Rules (for setup/reset forms) ────────

router.get('/password-rules/:token', async (req: Request, res: Response) => {
  // Look up user by invite token to get their client's rules
  const user = await prisma.user.findFirst({ where: { inviteToken: req.params.token as string } });
  const cn = user?.clientNumber || 'TMC-0001'; // fallback
  const gc = async (key: string, fallback: string) => (await getConfig(cn, key)) || fallback;

  res.json({
    minLength: parseInt(await gc('password_min_length', '8')),
    requireUppercase: (await gc('password_require_uppercase', 'true')) === 'true',
    requireNumber: (await gc('password_require_number', 'true')) === 'true',
    requireSpecial: (await gc('password_require_special', 'true')) === 'true',
  });
});

// ─── Public: Forgot Password ───────────────────────────────────

router.post('/forgot-password', forgotPasswordLimiter, validate(forgotPasswordSchema), async (req: Request, res: Response) => {
  const { email, baseUrl } = req.body;
  const clientUrl = baseUrl || `${req.protocol}://${req.get('host')}`.replace(':4002', ':5174');
  await sendPasswordReset(email, clientUrl);
  // Always return success to not reveal whether email exists
  res.json({ success: true, message: 'If an account exists with that email, a reset link has been sent.' });
});

// ─── Public: Validate Invite Token ─────────────────────────────

router.get('/invite/:token', async (req: Request, res: Response) => {
  const result = await validateInviteToken(req.params.token as string);
  res.json(result);
});

// ─── Public: Set Password via Invite Token ─────────────────────

router.post('/setup-password', validate(setupPasswordSchema), async (req: Request, res: Response) => {
  const { token, password } = req.body;
  const result = await setupPassword(token, password);
  if (!result.success) { res.status(400).json({ error: result.error }); return; }
  res.json({ success: true, message: 'Password set successfully. You can now login.' });
});

export default router;
