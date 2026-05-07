import crypto from 'crypto';
import nodemailer from 'nodemailer';
import prisma from '../db/prisma';
import { getConfig } from './configService';

/**
 * InviteService — sends invitation emails using the CLIENT's SMTP config.
 * Each tenant has their own SMTP setup in system_config.
 *
 * Flow:
 * 1. Admin creates user (password optional, passwordSet=false)
 * 2. Admin clicks "Send Invite"
 * 3. System generates invite token (64-char hex, 7-day expiry)
 * 4. Sends email via CLIENT's SMTP with setup link
 * 5. User clicks link → /setup-password?token=xxx
 * 6. User sets their own password → passwordSet=true
 */

const INVITE_EXPIRY_DAYS = 7;

/**
 * Get SMTP transporter for a specific client (reads from their system_config).
 */
export async function getClientTransporter(clientNumber: string): Promise<nodemailer.Transporter> {
  const host = await getConfig(clientNumber, 'smtp_host') || process.env.SMTP_HOST || '';
  const port = parseInt(await getConfig(clientNumber, 'smtp_port') || process.env.SMTP_PORT || '587');
  const user = await getConfig(clientNumber, 'smtp_user') || process.env.SMTP_USER || '';
  const pass = await getConfig(clientNumber, 'smtp_pass') || process.env.SMTP_PASS || '';
  const secure = (await getConfig(clientNumber, 'smtp_secure') || process.env.SMTP_SECURE || 'false') === 'true';

  if (!host || !user) {
    throw new Error('SMTP not configured for this client. Go to Client Configuration → Email/SMTP to set it up.');
  }

  return nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
  });
}

/**
 * Generate invite token and send invitation email.
 */
export async function sendInvitation(userId: number, clientNumber: string, baseUrl: string): Promise<{ success: boolean; error?: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { success: false, error: 'User not found' };

  // Generate token
  const inviteToken = crypto.randomBytes(32).toString('hex');
  const inviteExpiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: userId },
    data: { inviteToken, inviteExpiresAt, inviteSentAt: new Date() },
  });

  // Build invite link
  const setupUrl = `${baseUrl}/setup-password?token=${inviteToken}`;

  // Get client's SMTP and send
  try {
    const transporter = await getClientTransporter(clientNumber);
    const fromAddr = await getConfig(clientNumber, 'smtp_from') || process.env.SMTP_FROM || 'TMC AI <noreply@tmcai.com>';

    // Get tenant name for branding
    const tenant = await prisma.tenant.findUnique({ where: { clientNumber } });
    const appName = await getConfig(clientNumber, 'app_name') || 'TMC AI Intelligence';

    await transporter.sendMail({
      from: fromAddr,
      to: user.email,
      subject: `Welcome to ${appName} — Set Up Your Account`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #cc6b4a; margin: 0;">${appName}</h1>
            ${tenant ? `<p style="color: #888; font-size: 14px;">${tenant.name}</p>` : ''}
          </div>

          <p style="font-size: 16px; color: #333;">Hello ${user.name},</p>

          <p style="color: #555; line-height: 1.6;">
            You've been invited to join <strong>${appName}</strong>.
            Click the button below to set up your password and access your account.
          </p>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${setupUrl}" style="display: inline-block; padding: 14px 32px; background: #cc6b4a; color: #fff; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: 600;">
              Set Up Your Password
            </a>
          </div>

          <div style="background: #f8f8f8; padding: 16px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; font-size: 13px; color: #666;"><strong>Your details:</strong></p>
            <p style="margin: 4px 0; font-size: 13px; color: #888;">Email: ${user.email}</p>
            <p style="margin: 4px 0; font-size: 13px; color: #888;">Employee Code: ${user.empcode}</p>
          </div>

          <p style="font-size: 12px; color: #999; line-height: 1.5;">
            This link expires in ${INVITE_EXPIRY_DAYS} days. If you didn't expect this email, please ignore it.
          </p>

          <p style="font-size: 12px; color: #ccc; margin-top: 20px;">
            If the button doesn't work, copy this link:<br>
            <a href="${setupUrl}" style="color: #cc6b4a; word-break: break-all;">${setupUrl}</a>
          </p>
        </div>
      `,
    });

    console.log(`[Invite] Sent to ${user.email} (client: ${clientNumber})`);
    return { success: true };
  } catch (err: any) {
    console.error(`[Invite] Failed for ${user.email}:`, err.message);
    return { success: false, error: `Failed to send email: ${err.message}` };
  }
}

/**
 * Validate invite token and set password.
 */
export async function setupPassword(token: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
  const user = await prisma.user.findFirst({ where: { inviteToken: token } });

  if (!user) return { success: false, error: 'Invalid or expired invitation link' };
  if (!user.inviteExpiresAt || user.inviteExpiresAt < new Date()) {
    return { success: false, error: 'Invitation link has expired. Ask your admin to send a new one.' };
  }

  // Validate password complexity
  const { getConfig: gc } = require('./configService');
  const minLen = parseInt(await gc(user.clientNumber, 'password_min_length') || '8');
  const reqUpper = (await gc(user.clientNumber, 'password_require_uppercase') || 'true') === 'true';
  const reqNum = (await gc(user.clientNumber, 'password_require_number') || 'true') === 'true';
  const reqSpecial = (await gc(user.clientNumber, 'password_require_special') || 'true') === 'true';

  const { validatePasswordComplexity } = require('./authService');
  const pwError = validatePasswordComplexity(newPassword, { passwordMinLength: minLen, requireUppercase: reqUpper, requireNumber: reqNum, requireSpecial: reqSpecial });
  if (pwError) return { success: false, error: pwError };

  const bcrypt = require('bcrypt');
  const passwordHash = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      passwordSet: true,
      inviteToken: null,
      inviteExpiresAt: null,
    },
  });

  // Send confirmation email
  sendPasswordChangedEmail(user.id).catch(() => {});

  console.log(`[Invite] Password set for ${user.email}`);
  return { success: true };
}

/**
 * Check invite token validity (for the setup page to show/hide form).
 */
export async function validateInviteToken(token: string): Promise<{ valid: boolean; email?: string; name?: string; error?: string }> {
  const user = await prisma.user.findFirst({ where: { inviteToken: token } });
  if (!user) return { valid: false, error: 'Invalid invitation link' };
  if (!user.inviteExpiresAt || user.inviteExpiresAt < new Date()) {
    return { valid: false, error: 'Invitation link has expired' };
  }
  return { valid: true, email: user.email, name: user.name };
}

/**
 * Forgot password — generates reset token and sends email.
 * Uses same invite_token field but with shorter expiry (1 hour).
 */
export async function sendPasswordReset(email: string, baseUrl: string): Promise<{ success: boolean; error?: string }> {
  const user = await prisma.user.findFirst({ where: { email } });
  if (!user) {
    // Don't reveal whether user exists — always return success
    return { success: true };
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await prisma.user.update({
    where: { id: user.id },
    data: { inviteToken: resetToken, inviteExpiresAt: resetExpiry },
  });

  const resetUrl = `${baseUrl}/setup-password?token=${resetToken}`;

  try {
    const transporter = await getClientTransporter(user.clientNumber);
    const fromAddr = await getConfig(user.clientNumber, 'smtp_from') || process.env.SMTP_FROM || 'TMC AI <noreply@tmcai.com>';
    const appName = await getConfig(user.clientNumber, 'app_name') || 'TMC AI Intelligence';

    await transporter.sendMail({
      from: fromAddr,
      to: user.email,
      subject: `${appName} — Reset Your Password`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #cc6b4a;">${appName}</h1>
          <p style="font-size: 16px; color: #333;">Hello ${user.name},</p>
          <p style="color: #555; line-height: 1.6;">
            We received a request to reset your password. Click the button below to set a new password.
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="display: inline-block; padding: 14px 32px; background: #cc6b4a; color: #fff; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: 600;">
              Reset Password
            </a>
          </div>
          <p style="font-size: 12px; color: #999;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
          <p style="font-size: 12px; color: #ccc;">Link: <a href="${resetUrl}" style="color: #cc6b4a; word-break: break-all;">${resetUrl}</a></p>
        </div>
      `,
    });

    console.log(`[PasswordReset] Sent to ${user.email}`);
    return { success: true };
  } catch (err: any) {
    console.error(`[PasswordReset] Failed for ${user.email}:`, err.message);
    // Still return success to not reveal user existence
    return { success: true };
  }
}

/**
 * Send password changed confirmation email.
 * Called after: invite password setup, forgot password reset, manual password change.
 */
export async function sendPasswordChangedEmail(userId: number): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  try {
    const transporter = await getClientTransporter(user.clientNumber);
    const fromAddr = await getConfig(user.clientNumber, 'smtp_from') || process.env.SMTP_FROM || 'TMC AI <noreply@tmcai.com>';
    const appName = await getConfig(user.clientNumber, 'app_name') || 'TMC AI Intelligence';
    const now = new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });

    await transporter.sendMail({
      from: fromAddr,
      to: user.email,
      subject: `${appName} — Your Password Was Changed`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #cc6b4a;">${appName}</h1>
          <p style="font-size: 16px; color: #333;">Hello ${user.name},</p>
          <p style="color: #555; line-height: 1.6;">
            Your password was successfully changed on <strong>${now}</strong>.
          </p>
          <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 14px; margin: 20px 0;">
            <p style="margin: 0; color: #856404; font-size: 14px;">
              <strong>Didn't make this change?</strong><br>
              If you did not change your password, your account may be compromised.
              Contact your administrator immediately.
            </p>
          </div>
          <p style="font-size: 12px; color: #999;">This is an automated security notification from ${appName}.</p>
        </div>
      `,
    });

    console.log(`[Security] Password changed confirmation sent to ${user.email}`);
  } catch (err: any) {
    console.error(`[Security] Failed to send confirmation to ${user.email}:`, err.message);
  }
}
