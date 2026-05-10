import { google } from 'googleapis';
import prisma from '../db/prisma';
import { env } from '../config/env';

/**
 * IntegrationService — per-user Google OAuth for Gmail + Calendar.
 *
 * Flow:
 * 1. Admin clicks "Connect" for a user → generates OAuth URL
 * 2. User/admin completes Google consent → callback saves tokens
 * 3. AI uses tokens to read/send email, manage calendar
 * 4. Tokens auto-refresh when expired
 */

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  // Phase 3.1: Personal GDrive folder access
  'https://www.googleapis.com/auth/drive.readonly',
  // Tier 2 — Google Contacts import (People API).
  // Existing users won't have this scope until they re-authorize;
  // googleContactsService swallows 403s gracefully so the absence
  // is visible (empty results) but not breaking.
  'https://www.googleapis.com/auth/contacts.readonly',
];

// ─── OAuth Client ─────────────────────────────────────────────

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_INTEGRATION_REDIRECT_URI || 'http://localhost:4002/api/integration/callback',
  );
}

// ─── Generate OAuth URL for a user ────────────────────────────

export function getAuthUrl(userId: number): string {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',         // Force consent to get refresh_token every time
    scope: SCOPES,
    state: String(userId),     // Pass userId through OAuth flow
  });
}

// ─── Handle OAuth callback ────────────────────────────────────

export async function handleCallback(code: string, userId: number): Promise<{ success: boolean; email?: string; error?: string }> {
  try {
    const client = getOAuth2Client();
    const { tokens } = await client.getToken(code);

    if (!tokens.access_token) {
      return { success: false, error: 'No access token received' };
    }

    // Get the user's email from Google
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email || '';

    // Save tokens to user record
    await prisma.user.update({
      where: { id: userId },
      data: {
        integrationProvider: 'google',
        integrationEmail: email,
        integrationAccessToken: tokens.access_token,
        integrationRefreshToken: tokens.refresh_token || undefined,
        integrationTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        integrationScopes: 'email,calendar',
        integrationStatus: 'active',
        integrationError: null,
      },
    });

    console.log(`[Integration] Google connected for user ${userId}: ${email}`);
    return { success: true, email };
  } catch (err: any) {
    console.error(`[Integration] OAuth callback error for user ${userId}:`, err.message);

    await prisma.user.update({
      where: { id: userId },
      data: { integrationStatus: 'error', integrationError: err.message },
    });

    return { success: false, error: err.message };
  }
}

// ─── Get authenticated client for a user ──────────────────────

export async function getAuthenticatedClient(userId: number): Promise<{ client: any; error?: string }> {
  // ── Try MyOS UserConnector first (new connector framework) ──
  // Check ANY connected Google connector (gmail, calendar, tasks, chat, drive — they all share the same OAuth tokens)
  try {
    const googleSlugs = ['gmail', 'google_calendar', 'google_tasks', 'google_chat', 'google_drive_personal'];
    const googleConnectorTypes = await prisma.connectorType.findMany({ where: { slug: { in: googleSlugs } } });
    let userConnector = null;
    for (const ct of googleConnectorTypes) {
      const uc = await prisma.userConnector.findUnique({
        where: { userId_connectorTypeId: { userId, connectorTypeId: ct.id } },
      });
      if (uc?.status === 'connected' && uc.config) { userConnector = uc; break; }
    }
    if (userConnector) {
        const { decrypt } = await import('./configService');
        const cfg = userConnector.config as Record<string, unknown>;
        // Decrypt sensitive fields
        let accessToken = cfg.accessToken as string;
        let refreshToken = cfg.refreshToken as string;
        let clientId = cfg.clientId as string;
        let clientSecret = cfg.clientSecret as string;
        try { accessToken = await decrypt(accessToken); } catch {}
        try { refreshToken = await decrypt(refreshToken); } catch {}
        try { if (clientId) clientId = await decrypt(clientId); } catch {}
        try { if (clientSecret) clientSecret = await decrypt(clientSecret); } catch {}

        const oauth2Client = new (await import('googleapis')).google.auth.OAuth2(
          clientId || process.env.GOOGLE_CLIENT_ID,
          clientSecret || process.env.GOOGLE_CLIENT_SECRET,
          process.env.GOOGLE_CONNECTOR_REDIRECT_URI || 'http://localhost:4002/api/v1/connectors/oauth/callback',
        );
        oauth2Client.setCredentials({
          access_token: accessToken,
          refresh_token: refreshToken || undefined,
          expiry_date: cfg.tokenExpiry ? new Date(cfg.tokenExpiry as string).getTime() : undefined,
        });

        // Auto-refresh if expired
        const tokenExpiry = cfg.tokenExpiry ? new Date(cfg.tokenExpiry as string) : null;
        if (tokenExpiry && new Date() > tokenExpiry && refreshToken) {
          try {
            const { credentials } = await oauth2Client.refreshAccessToken();
            const { encrypt } = await import('./configService');
            const newAccessToken = credentials.access_token || accessToken;
            const encAccessToken = await encrypt(newAccessToken).catch(() => newAccessToken);
            await prisma.userConnector.update({
              where: { id: userConnector.id },
              data: {
                config: {
                  ...cfg,
                  accessToken: encAccessToken,
                  tokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : (cfg.tokenExpiry as string) || '',
                } as any,
              },
            });
            oauth2Client.setCredentials(credentials);
            console.log(`[Integration] UserConnector token refreshed for user ${userId}`);
          } catch (err: any) {
            console.error(`[Integration] UserConnector token refresh failed for user ${userId}:`, err.message);
            // Mark ALL the user's Google connector rows as broken,
            // not just the one we happened to look up first. They
            // all share the same OAuth token (see line 105 — Gmail,
            // Calendar, Tasks, Chat, Drive read from the same
            // userConnector row's config). When the refresh fails,
            // every Google channel is dead, so every row should
            // reflect that. Without this updateMany, the user sees
            // ONE channel marked broken (whichever happened to
            // trigger the refresh first) and the others stuck
            // showing "Connected" — exactly what the user flagged
            // on the connectors page.
            const errorMessage = String(err?.message ?? 'token refresh failed');
            const erroredAt = new Date().toISOString();
            const allGoogleTypeIds = googleConnectorTypes.map((ct) => ct.id);
            await prisma.userConnector.updateMany({
              where: {
                userId,
                connectorTypeId: { in: allGoogleTypeIds },
              },
              data: {
                status: 'error' as any,
              },
            }).catch(() => { /* best effort */ });
            // updateMany can't merge JSON metadata, so loop for that.
            const allRows = await prisma.userConnector.findMany({
              where: { userId, connectorTypeId: { in: allGoogleTypeIds } },
              select: { id: true, metadata: true },
            }).catch(() => [] as Array<{ id: string; metadata: unknown }>);
            for (const row of allRows) {
              await prisma.userConnector.update({
                where: { id: row.id },
                data: {
                  metadata: {
                    ...((row.metadata as Record<string, unknown> | null) ?? {}),
                    lastRefreshError: errorMessage,
                    lastRefreshErrorAt: erroredAt,
                  } as any,
                },
              }).catch(() => { /* best effort */ });
            }
            // Fire one Brain alert so the user knows immediately their
            // Google connectors went dead — instead of discovering it
            // 4 days later when My Attention is empty. Deduped on the
            // userId so a stuck refresh doesn't spam (brainContactsUser
            // dedupKey + dedupWindow handles this).
            try {
              const { brainContactsUser } = await import('./notifications/brainOutboundService');
              const isExpiry = /invalid_grant|token has been expired|expired or revoked/i.test(errorMessage);
              await brainContactsUser({
                userId,
                kind: 'connector_stale',
                summary: isExpiry ? 'Google token expired — reconnect needed' : 'Google connector failed',
                body: isExpiry
                  ? `⚠️ Your Google sign-in expired. Gmail, Calendar, Drive, Tasks, and Chat have all stopped syncing.\n\nOpen Connectors and reconnect to restore Day Brief.`
                  : `⚠️ Google connector hit an error: ${errorMessage.slice(0, 120)}\n\nOpen Connectors to investigate.`,
                urgency: 'high',
                dedupKey: `google_oauth_failure:${userId}`,
                dedupWindowMs: 4 * 60 * 60 * 1000,
                metadata: { errorMessage, isExpiry } as any,
              }).catch(() => { /* best effort */ });
            } catch { /* notifications service optional */ }
          }
        }

        return { client: oauth2Client };
    }
  } catch (err: any) {
    console.error(`[Integration] UserConnector lookup failed:`, err.message);
  }

  // ── Fallback: legacy User table fields ──────────────────────
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      integrationProvider: true,
      integrationAccessToken: true,
      integrationRefreshToken: true,
      integrationTokenExpiry: true,
      integrationStatus: true,
    },
  });

  if (!user?.integrationProvider || !user.integrationAccessToken) {
    return { client: null, error: 'No email/calendar integration configured. Connect Gmail or Outlook in My Connectors.' };
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token: user.integrationAccessToken,
    refresh_token: user.integrationRefreshToken || undefined,
    expiry_date: user.integrationTokenExpiry?.getTime(),
  });

  // Auto-refresh if expired
  const isExpired = user.integrationTokenExpiry && new Date() > user.integrationTokenExpiry;
  if (isExpired && user.integrationRefreshToken) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      await prisma.user.update({
        where: { id: userId },
        data: {
          integrationAccessToken: credentials.access_token || user.integrationAccessToken,
          integrationTokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
          integrationStatus: 'active',
          integrationError: null,
        },
      });
      oauth2Client.setCredentials(credentials);
      console.log(`[Integration] Legacy token refreshed for user ${userId}`);
    } catch (err: any) {
      await prisma.user.update({
        where: { id: userId },
        data: { integrationStatus: 'expired', integrationError: `Token refresh failed: ${err.message}` },
      });
      return { client: null, error: 'Integration token expired. Reconnect in My Connectors.' };
    }
  }

  return { client: oauth2Client };
}

// ─── Disconnect integration ───────────────────────────────────

export async function disconnectIntegration(userId: number): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      integrationProvider: null,
      integrationEmail: null,
      integrationAccessToken: null,
      integrationRefreshToken: null,
      integrationTokenExpiry: null,
      integrationScopes: null,
      integrationStatus: null,
      integrationError: null,
    },
  });
  console.log(`[Integration] Disconnected for user ${userId}`);
}

// ─── Get integration status for a user ────────────────────────

export async function getIntegrationStatus(userId: number): Promise<{
  connected: boolean;
  provider?: string;
  email?: string;
  scopes?: string;
  status?: string;
  error?: string;
  permissions?: string;
}> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    'SELECT integration_provider, integration_email, integration_scopes, integration_status, integration_error, integration_permissions FROM users WHERE id = $1',
    userId
  );

  if (!rows.length || !rows[0].integration_provider) {
    return { connected: false };
  }

  const u = rows[0];
  return {
    connected: true,
    provider: u.integration_provider || undefined,
    email: u.integration_email || undefined,
    scopes: u.integration_scopes || undefined,
    status: u.integration_status || undefined,
    error: u.integration_error || undefined,
    permissions: u.integration_permissions || 'email_read,calendar_read',
  };
}

// ─── Permission check helpers ─────────────────────────────────

export type IntegrationPermission = 'email_read' | 'email_write' | 'calendar_read' | 'calendar_write' | 'calendar_delete';

export async function hasPermission(userId: number, permission: IntegrationPermission): Promise<boolean> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    'SELECT integration_provider, integration_status, integration_permissions FROM users WHERE id = $1',
    userId
  );
  if (!rows.length || !rows[0].integration_provider || rows[0].integration_status !== 'active') return false;
  const perms = (rows[0].integration_permissions || '').split(',').map((p: string) => p.trim());
  return perms.includes(permission);
}

export async function checkIntegrationReady(userId: number): Promise<{ ready: boolean; message?: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { integrationProvider: true, integrationStatus: true },
  });

  if (!user?.integrationProvider) {
    return {
      ready: false,
      message: "I'd love to help with that! But your email and calendar aren't connected yet. Go to **Settings → Email & Calendar** and click **Connect Google** to set it up. It only takes a few seconds!",
    };
  }

  if (user.integrationStatus === 'expired') {
    return {
      ready: false,
      message: "Your email/calendar connection has expired. Please go to **Settings → Email & Calendar** and click **Reconnect** to fix it.",
    };
  }

  if (user.integrationStatus === 'error') {
    return {
      ready: false,
      message: "There's an issue with your email/calendar connection. Please go to **Settings → Email & Calendar** to check the error and reconnect.",
    };
  }

  return { ready: true };
}

export async function updatePermissions(userId: number, permissions: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    'UPDATE users SET integration_permissions = $1, updated_at = NOW() WHERE id = $2',
    permissions, userId
  );
}

// ─── Test integration (verify tokens work) ────────────────────

export async function testIntegration(userId: number): Promise<{ success: boolean; email?: string; calendarCount?: number; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { success: false, error };

  try {
    // Test Gmail
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress || '';

    // Test Calendar
    const calendar = google.calendar({ version: 'v3', auth: client });
    const calendars = await calendar.calendarList.list({ maxResults: 5 });
    const calendarCount = calendars.data.items?.length || 0;

    // Update status
    await prisma.user.update({
      where: { id: userId },
      data: { integrationStatus: 'active', integrationError: null, integrationEmail: email },
    });

    return { success: true, email, calendarCount };
  } catch (err: any) {
    const errorMsg = err.message || 'Integration test failed';
    await prisma.user.update({
      where: { id: userId },
      data: { integrationStatus: 'error', integrationError: errorMsg },
    });
    return { success: false, error: errorMsg };
  }
}
