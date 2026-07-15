import nodemailer from 'nodemailer';

/**
 * EmailService — sends emails using SMTP configured in system_config.
 * Config keys: smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from
 */

/** Platform-level (NOT tenant) SMTP settings live under this tenant's
 *  system_config rows — a deployment/operator choice, not tenant
 *  identity. Override with PLATFORM_CONFIG_TENANT; env SMTP_* vars
 *  always take precedence over DB rows anyway. */
export const PLATFORM_CONFIG_TENANT = process.env.PLATFORM_CONFIG_TENANT || 'TMC-0001';

/** #7: is the platform SMTP fallback actually configured? Used by live
 *  capability discovery ('smtp' provider in send_email's anyOf). */
export async function smtpConfigured(): Promise<boolean> {
  if (process.env.SMTP_HOST && process.env.SMTP_USER) return true;
  try {
    const { getConfig } = await import('./configService');
    const host = await getConfig(PLATFORM_CONFIG_TENANT, 'smtp_host');
    const user = await getConfig(PLATFORM_CONFIG_TENANT, 'smtp_user');
    return Boolean(host && user);
  } catch { return false; }
}

let transporter: nodemailer.Transporter | null = null;

async function getTransporter(): Promise<nodemailer.Transporter> {
  if (transporter) return transporter;

  // Read SMTP config from system_config (DB) first, fallback to .env
  let host = process.env.SMTP_HOST || '';
  let port = parseInt(process.env.SMTP_PORT || '587');
  let user = process.env.SMTP_USER || '';
  let pass = process.env.SMTP_PASS || '';

  if (!host || !user) {
    try {
      const { getConfig } = await import('./configService');
      // Read from system_config (auto-decrypts sensitive fields like smtp_pass)
      const dbHost = await getConfig(PLATFORM_CONFIG_TENANT, 'smtp_host');
      const dbPort = await getConfig(PLATFORM_CONFIG_TENANT, 'smtp_port');
      const dbUser = await getConfig(PLATFORM_CONFIG_TENANT, 'smtp_user');
      const dbPass = await getConfig(PLATFORM_CONFIG_TENANT, 'smtp_pass');
      if (dbHost) host = dbHost;
      if (dbPort) port = parseInt(dbPort);
      if (dbUser) user = dbUser;
      if (dbPass) pass = dbPass;
    } catch {}
  }

  if (!host || !user) {
    throw new Error('SMTP not configured. Set smtp_host, smtp_user, smtp_pass in system_config or .env');
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  return transporter;
}

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const transport = await getTransporter();
    let from = process.env.SMTP_FROM || '';
    if (!from) {
      try {
        const { getConfig } = await import('./configService');
        from = await getConfig(PLATFORM_CONFIG_TENANT, 'smtp_from') || '';
      } catch {}
    }
    if (!from) from = 'TMC AI <noreply@tmc.com>';

    await transport.sendMail({ from, to, subject, html });
    console.log(`[Email] Sent to ${to}: "${subject}"`);
    return true;
  } catch (err: any) {
    console.error(`[Email] Failed to send to ${to}:`, err.message);
    console.error(`[Email] SMTP config: host=${process.env.SMTP_HOST || 'from-db'}`);
    // Reset transporter on error so it re-reads config next time
    transporter = null;
    return false;
  }
}

/**
 * Reset transporter (call after SMTP config changes)
 */
export function resetTransporter(): void {
  transporter = null;
}

// Clear cache on module load so DB config is always fresh
transporter = null;
