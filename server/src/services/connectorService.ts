/**
 * MyOS Connector Service
 *
 * Unified CRUD, scope checking, and credential management for all connectors.
 * Three-tier model:
 *   1. ConnectorType (platform registry) — seeded on deploy
 *   2. TenantConnectorConfig (admin) — enable personal connectors, configure org connectors
 *   3. UserConnector (user) — connect personal accounts
 */

import prisma from '../db/prisma';
import { encrypt, decrypt } from './configService';

// ═══════════════════════════════════════════════════════════════════
// ─── Connector Type Registry (read-only for services) ─────────────
// ═══════════════════════════════════════════════════════════════════

export async function listConnectorTypes(scope?: 'personal' | 'organizational') {
  const where: Record<string, unknown> = { isActive: true };
  if (scope) where.scope = scope;
  return prisma.connectorType.findMany({ where, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
}

export async function getConnectorTypeBySlug(slug: string) {
  return prisma.connectorType.findUnique({ where: { slug } });
}

// ═══════════════════════════════════════════════════════════════════
// ─── Tenant Connector Config (Admin operations) ───────────────────
// ═══════════════════════════════════════════════════════════════════

/** List all connector configs for a tenant (admin view) */
export async function listTenantConfigs(clientNumber: string) {
  return prisma.tenantConnectorConfig.findMany({
    where: { clientNumber },
    include: { connectorType: true },
    orderBy: { connectorType: { category: 'asc' } },
  });
}

/** Enable/disable a personal connector for users in this tenant */
export async function togglePersonalConnector(clientNumber: string, connectorTypeId: string, enabled: boolean) {
  return prisma.tenantConnectorConfig.upsert({
    where: { clientNumber_connectorTypeId: { clientNumber, connectorTypeId } },
    create: {
      clientNumber,
      connectorTypeId,
      scope: 'personal',
      isEnabled: enabled,
    },
    update: { isEnabled: enabled },
  });
}

/** Configure an org connector (admin provides credentials + schedule) */
export async function configureOrgConnector(
  clientNumber: string,
  connectorTypeId: string,
  config: Record<string, unknown>,
  syncSchedule?: string,
) {
  // Encrypt sensitive config values
  const encryptedConfig = await encryptConnectorConfig(config);

  return prisma.tenantConnectorConfig.upsert({
    where: { clientNumber_connectorTypeId: { clientNumber, connectorTypeId } },
    create: {
      clientNumber,
      connectorTypeId,
      scope: 'organizational',
      isEnabled: true,
      config: encryptedConfig as any,
      syncSchedule: syncSchedule || null,
    },
    update: {
      config: encryptedConfig as any,
      syncSchedule: syncSchedule || undefined,
      isEnabled: true,
    },
  });
}

/** Remove org connector config */
export async function removeOrgConnector(clientNumber: string, connectorTypeId: string) {
  return prisma.tenantConnectorConfig.delete({
    where: { clientNumber_connectorTypeId: { clientNumber, connectorTypeId } },
  }).catch(() => null); // ignore if not found
}

/** Check if a personal connector is enabled for a tenant */
export async function isPersonalConnectorEnabled(clientNumber: string, connectorTypeId: string): Promise<boolean> {
  const config = await prisma.tenantConnectorConfig.findUnique({
    where: { clientNumber_connectorTypeId: { clientNumber, connectorTypeId } },
  });
  return config?.isEnabled ?? false;
}

/** Get all enabled personal connector type IDs for a tenant */
export async function getEnabledPersonalConnectors(clientNumber: string) {
  const configs = await prisma.tenantConnectorConfig.findMany({
    where: { clientNumber, scope: 'personal', isEnabled: true },
    include: { connectorType: true },
  });
  return configs.map(c => c.connectorType);
}

/** Get all configured org connectors for a tenant */
export async function getConfiguredOrgConnectors(clientNumber: string) {
  const configs = await prisma.tenantConnectorConfig.findMany({
    where: { clientNumber, scope: 'organizational', isEnabled: true },
    include: { connectorType: true },
  });
  return configs;
}

// ═══════════════════════════════════════════════════════════════════
// ─── User Connector (User operations) ─────────────────────────────
// ═══════════════════════════════════════════════════════════════════

/** List available personal connectors for a user (only admin-enabled ones) */
export async function listAvailableForUser(userId: number, clientNumber: string) {
  const enabledTypes = await getEnabledPersonalConnectors(clientNumber);
  const userConnectors = await prisma.userConnector.findMany({
    where: { userId, clientNumber },
    include: { connectorType: true },
  });

  // Single platform OAuth app (in tmcai-491811) — used by every tenant +
  // every user. Per-tenant BYO-OAuth was removed (see memory:
  // project_gcp_simplification). The Google-family slugs always inherit
  // the platform OAuth client when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
  // are present in env.
  const googleSlugs = new Set(['gmail', 'google_calendar', 'google_tasks', 'google_chat', 'google_drive_personal', 'google_sheets']);
  const hasGoogleEnv = !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;

  return enabledTypes.map(ct => {
    const uc = userConnectors.find(u => u.connectorTypeId === ct.id) || null;
    const oauthAvailable = googleSlugs.has(ct.slug) && hasGoogleEnv;
    return {
      ...ct,
      isConnected: uc?.status === 'connected',
      userConnector: uc,
      // Kept for UI back-compat. Always 'env' (= platform OAuth) when
      // available; older 'tenant' source has been retired.
      tenantOauthAvailable: oauthAvailable,
      tenantOauthSource: oauthAvailable ? 'env' : null,
    };
  });
}

/** List user's active connections */
export async function listUserConnectors(userId: number, clientNumber: string) {
  return prisma.userConnector.findMany({
    where: { userId, clientNumber },
    include: { connectorType: true },
  });
}

/** Connect a personal connector for a user */
export async function connectUserConnector(
  userId: number,
  clientNumber: string,
  connectorTypeId: string,
  config: Record<string, unknown>,
) {
  // Verify connector is enabled for this tenant
  const enabled = await isPersonalConnectorEnabled(clientNumber, connectorTypeId);
  if (!enabled) {
    throw new Error('This connector is not enabled for your organization');
  }

  const encryptedConfig = await encryptConnectorConfig(config);

  // Detect first-time connection (status was not 'connected' before this save)
  const existing = await prisma.userConnector.findUnique({
    where: { userId_connectorTypeId: { userId, connectorTypeId } },
    select: { status: true, connectorType: { select: { slug: true } } },
  }).catch(() => null);
  const freshConnect = !existing || existing.status !== 'connected';

  const saved = await prisma.userConnector.upsert({
    where: { userId_connectorTypeId: { userId, connectorTypeId } },
    create: {
      userId,
      clientNumber,
      connectorTypeId,
      config: encryptedConfig as any,
      status: 'connected',
    },
    update: {
      config: encryptedConfig as any,
      status: 'connected',
      errorMessage: null,
    },
    include: { connectorType: true },
  });

  // Fresh connect → kick off historical pull + Brain memory warm-up in
  // the background. The user's Connector flips to "Connected" immediately;
  // past emails/events flow in over the next few minutes and sender_wiki
  // pages get built so Brain has context from the moment the MD opens
  // Day Brief. Fire-and-forget; no user-visible failure if it errors.
  // Driven by the puller registry — any slug with a registered historical
  // puller auto-warms on fresh connect.
  if (freshConnect) {
    void (async () => {
      try {
        const { warmUpBrainFromSources, isScribeSupported } = await import('./knowledge/historicalFeedPull');
        if (!isScribeSupported(saved.connectorType.slug)) return;
        await warmUpBrainFromSources(clientNumber, userId);
      } catch (err: any) {
        console.warn(`[warmUpBrain] failed for user=${userId} slug=${saved.connectorType.slug}: ${err.message}`);
      }
    })();
  }

  // Fresh Gmail connect → also kick off attachment backfill immediately
  // and publish an ETA so the UI can show "we're setting things up, ~N
  // minutes remaining". New events flow live through the ingest hook;
  // this worker drains any historical backlog.
  if (freshConnect && saved.connectorType.slug === 'gmail') {
    void (async () => {
      try {
        const { triggerBackfillForUser } = await import('../jobs/attachmentBackfillWorker');
        await triggerBackfillForUser(clientNumber, userId, { reason: 'gmail_connected' });
      } catch (err: any) {
        console.warn(`[attachmentBackfill] trigger failed for user=${userId}: ${err.message}`);
      }
    })();
  }

  return saved;
}

/** Disconnect a personal connector — keeps config for easy reconnect */
export async function disconnectUserConnector(userId: number, connectorTypeId: string) {
  return prisma.userConnector.update({
    where: { userId_connectorTypeId: { userId, connectorTypeId } },
    data: { status: 'disconnected' },
  }).catch(() => null);
}

/** Get user's connector credentials by slug (used by existing services) */
export async function getCredentials(userId: number, slug: string): Promise<Record<string, unknown> | null> {
  const connectorType = await prisma.connectorType.findUnique({ where: { slug } });
  if (!connectorType) return null;

  const userConnector = await prisma.userConnector.findUnique({
    where: { userId_connectorTypeId: { userId, connectorTypeId: connectorType.id } },
  });

  if (!userConnector || userConnector.status !== 'connected' || !userConnector.config) {
    return null;
  }

  return decryptConnectorConfig(userConnector.config as Record<string, unknown>);
}

/** Get org connector credentials by slug (used by background services) */
export async function getOrgCredentials(clientNumber: string, slug: string): Promise<Record<string, unknown> | null> {
  const connectorType = await prisma.connectorType.findUnique({ where: { slug } });
  if (!connectorType) return null;

  const tenantConfig = await prisma.tenantConnectorConfig.findUnique({
    where: { clientNumber_connectorTypeId: { clientNumber, connectorTypeId: connectorType.id } },
  });

  if (!tenantConfig || !tenantConfig.isEnabled || !tenantConfig.config) {
    return null;
  }

  return decryptConnectorConfig(tenantConfig.config as Record<string, unknown>);
}

/** Update connector sync status */
export async function updateSyncStatus(
  connectorId: string,
  scope: 'user' | 'tenant',
  status: string,
  error?: string,
) {
  const now = new Date();

  if (scope === 'user') {
    await prisma.userConnector.update({
      where: { id: connectorId },
      data: {
        syncStatus: status,
        lastSyncAt: status === 'idle' ? now : undefined,
        errorMessage: error || null,
      },
    });
  } else {
    await prisma.tenantConnectorConfig.update({
      where: { id: connectorId },
      data: {
        syncStatus: status,
        lastSyncAt: status === 'idle' ? now : undefined,
        syncError: error || null,
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── Test Connected Connector (live API verification) ─────────────
// ═══════════════════════════════════════════════════════════════════

/** Test a connector that's already saved — make a real API call to verify it works */
export async function testConnectedConnector(
  userId: number,
  connectorTypeId: string,
): Promise<{ success: boolean; error?: string; detail?: string }> {
  const connectorType = await prisma.connectorType.findUnique({ where: { id: connectorTypeId } });
  if (!connectorType) return { success: false, error: 'Unknown connector type' };

  const userConnector = await prisma.userConnector.findUnique({
    where: { userId_connectorTypeId: { userId, connectorTypeId } },
  });
  if (!userConnector || !userConnector.config) return { success: false, error: 'Connector not configured' };

  const slug = connectorType.slug;
  const cfg = await decryptConnectorConfig(userConnector.config as Record<string, unknown>);

  try {
    // Google OAuth connectors — use getAuthenticatedClient then test specific API
    const googleSlugs = ['gmail', 'google_calendar', 'google_tasks', 'google_chat', 'google_drive_personal'];
    if (googleSlugs.includes(slug)) {
      const { getAuthenticatedClient } = await import('./integrationService');
      const { client, error } = await getAuthenticatedClient(userId);
      if (!client || error) {
        await prisma.userConnector.update({ where: { id: userConnector.id }, data: { status: 'error', errorMessage: error || 'Auth failed' } });
        return { success: false, error: error || 'Authentication failed — reconnect required' };
      }

      const { google } = await import('googleapis');

      if (slug === 'gmail') {
        const gmail = google.gmail({ version: 'v1', auth: client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        await prisma.userConnector.update({ where: { id: userConnector.id }, data: { status: 'connected', errorMessage: null, lastSyncAt: new Date() } });
        return { success: true, detail: `Gmail OK — ${profile.data.emailAddress}, ${profile.data.messagesTotal} total messages` };
      }
      if (slug === 'google_calendar') {
        const cal = google.calendar({ version: 'v3', auth: client });
        const events = await cal.events.list({ calendarId: 'primary', maxResults: 1, timeMin: new Date().toISOString() });
        await prisma.userConnector.update({ where: { id: userConnector.id }, data: { status: 'connected', errorMessage: null, lastSyncAt: new Date() } });
        return { success: true, detail: `Calendar OK — ${events.data.items?.length || 0} upcoming events found` };
      }
      if (slug === 'google_tasks') {
        const tasks = google.tasks({ version: 'v1', auth: client });
        const lists = await tasks.tasklists.list({ maxResults: 5 });
        await prisma.userConnector.update({ where: { id: userConnector.id }, data: { status: 'connected', errorMessage: null, lastSyncAt: new Date() } });
        return { success: true, detail: `Tasks OK — ${lists.data.items?.length || 0} task lists found` };
      }
      // Generic Google test
      await prisma.userConnector.update({ where: { id: userConnector.id }, data: { status: 'connected', errorMessage: null, lastSyncAt: new Date() } });
      return { success: true, detail: 'Google auth OK' };
    }

    // API key connectors — re-run the credential test
    const testResult = await testCredentials(slug, connectorType.authMethod, cfg);
    if (testResult.success) {
      await prisma.userConnector.update({ where: { id: userConnector.id }, data: { status: 'connected', errorMessage: null, lastSyncAt: new Date() } });
      return { success: true, detail: `${connectorType.name} API responding OK` };
    } else {
      await prisma.userConnector.update({ where: { id: userConnector.id }, data: { status: 'error', errorMessage: testResult.error } });
      return { success: false, error: testResult.error };
    }

  } catch (err: any) {
    const errMsg = err.message?.substring(0, 200) || 'Unknown error';
    await prisma.userConnector.update({ where: { id: userConnector.id }, data: { status: 'error', errorMessage: errMsg } });
    return { success: false, error: errMsg };
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── Test Connection ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

/** Test a connector's credentials before saving as connected */
export async function testAndConnect(
  userId: number,
  clientNumber: string,
  connectorTypeId: string,
  config: Record<string, unknown>,
): Promise<{ success: boolean; error?: string; email?: string }> {
  const connectorType = await prisma.connectorType.findUnique({ where: { id: connectorTypeId } });
  if (!connectorType) return { success: false, error: 'Unknown connector type' };

  const enabled = await isPersonalConnectorEnabled(clientNumber, connectorTypeId);
  if (!enabled) return { success: false, error: 'This connector is not enabled for your organization' };

  // Always save config first (encrypted), regardless of test result
  const encryptedConfig = await encryptConnectorConfig(config);
  await prisma.userConnector.upsert({
    where: { userId_connectorTypeId: { userId, connectorTypeId } },
    create: { userId, clientNumber, connectorTypeId, config: encryptedConfig as any, status: 'configured' },
    update: { config: encryptedConfig as any },
  });

  // Then test the connection
  try {
    const testResult = await testCredentials(connectorType.slug, connectorType.authMethod, config);
    if (!testResult.success) {
      await prisma.userConnector.update({
        where: { userId_connectorTypeId: { userId, connectorTypeId } },
        data: { status: 'error', errorMessage: testResult.error },
      });
      return testResult;
    }

    // Test passed — merge any extra data from test, mark connected
    if (testResult.extra) {
      const mergedConfig = await encryptConnectorConfig({ ...config, ...testResult.extra });
      await prisma.userConnector.update({
        where: { userId_connectorTypeId: { userId, connectorTypeId } },
        data: { config: mergedConfig as any, status: 'connected', errorMessage: null },
      });
    } else {
      await prisma.userConnector.update({
        where: { userId_connectorTypeId: { userId, connectorTypeId } },
        data: { status: 'connected', errorMessage: null },
      });
    }
    return { success: true, email: testResult.email };

  } catch (err: any) {
    await prisma.userConnector.update({
      where: { userId_connectorTypeId: { userId, connectorTypeId } },
      data: { status: 'error', errorMessage: err.message },
    });
    return { success: false, error: err.message };
  }
}

/** Test credentials per connector type */
async function testCredentials(
  slug: string,
  authMethod: string,
  config: Record<string, unknown>,
): Promise<{ success: boolean; error?: string; email?: string; extra?: Record<string, unknown> }> {

  // ── OAuth2 connectors: require tokens from OAuth flow ──────
  if (authMethod === 'oauth2') {
    // OAuth connectors are handled by the OAuth flow (getOAuthUrl → callback)
    // If we get here with tokens, validate them
    if (config.accessToken) {
      return { success: true, email: config.email as string };
    }
    return { success: false, error: 'OAuth connectors require the Connect button to start the authorization flow' };
  }

  // ── API Key connectors ─────────────────────────────────────
  if (authMethod === 'api_key') {
    const apiKey = config.apiKey as string;
    if (!apiKey || apiKey.length < 5) return { success: false, error: 'API key is required' };

    // Test per slug
    if (slug === 'todoist') {
      const res = await fetch('https://api.todoist.com/rest/v2/projects', { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) return { success: false, error: `Todoist API error: ${res.status} ${res.statusText}` };
      return { success: true };
    }
    if (slug === 'trello') {
      const token = config.token as string;
      if (!token) return { success: false, error: 'Trello token is required along with API key' };
      const res = await fetch(`https://api.trello.com/1/members/me?key=${apiKey}&token=${token}`);
      if (!res.ok) return { success: false, error: `Trello API error: ${res.status} ${res.statusText}` };
      return { success: true };
    }
    if (slug === 'hubspot') {
      const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) return { success: false, error: `HubSpot API error: ${res.status} ${res.statusText}` };
      return { success: true };
    }
    if (slug === 'jira') {
      const domain = config.domain as string;
      const email = config.email as string;
      if (!domain || !email) return { success: false, error: 'Jira domain and email are required' };
      const auth = Buffer.from(`${email}:${apiKey}`).toString('base64');
      const res = await fetch(`https://${domain}/rest/api/3/myself`, { headers: { Authorization: `Basic ${auth}` } });
      if (!res.ok) return { success: false, error: `Jira API error: ${res.status} ${res.statusText}` };
      return { success: true };
    }
    if (slug === 'notion_org') {
      const res = await fetch('https://api.notion.com/v1/users/me', { headers: { Authorization: `Bearer ${apiKey}`, 'Notion-Version': '2022-06-28' } });
      if (!res.ok) return { success: false, error: `Notion API error: ${res.status} ${res.statusText}` };
      return { success: true };
    }
    if (slug === 'zendesk') {
      const subdomain = config.subdomain as string;
      const email = config.email as string;
      if (!subdomain || !email) return { success: false, error: 'Zendesk subdomain and email are required' };
      const auth = Buffer.from(`${email}/token:${apiKey}`).toString('base64');
      const res = await fetch(`https://${subdomain}.zendesk.com/api/v2/users/me.json`, { headers: { Authorization: `Basic ${auth}` } });
      if (!res.ok) return { success: false, error: `Zendesk API error: ${res.status} ${res.statusText}` };
      return { success: true };
    }
    // Generic API key test — just check it's not empty
    return { success: true };
  }

  // ── Bot token (Telegram) ───────────────────────────────────
  if (authMethod === 'bot_token') {
    const botToken = config.botToken as string;
    if (!botToken) return { success: false, error: 'Bot token is required' };
    if (slug === 'telegram') {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const data = await res.json() as any;
      if (!data.ok) return { success: false, error: `Telegram error: ${data.description || 'Invalid bot token'}` };
      return { success: true, extra: { botName: data.result?.first_name } };
    }
    return { success: true };
  }

  // ── Credentials (username/password, e.g. SAP) ──────────────
  if (authMethod === 'credentials') {
    const baseUrl = config.baseUrl as string;
    const username = config.username as string;
    const password = config.password as string;
    if (!baseUrl) return { success: false, error: 'Base URL is required' };
    if (!username || !password) return { success: false, error: 'Username and password are required' };
    // Basic connectivity test
    try {
      const res = await fetch(baseUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (res.status >= 500) return { success: false, error: `Server error: ${res.status}` };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: `Cannot reach ${baseUrl}: ${err.message}` };
    }
  }

  // ── Webhook (WhatsApp) ─────────────────────────────────────
  if (authMethod === 'webhook') {
    if (slug === 'whatsapp') {
      const phoneNumber = config.phoneNumber as string;
      const phoneNumberId = config.phoneNumberId as string;
      const accessToken = config.accessToken as string;
      if (!phoneNumber) return { success: false, error: 'Phone number is required' };
      if (!phoneNumberId) return { success: false, error: 'WhatsApp Phone Number ID is required. Get it from Meta Developer Portal → WhatsApp → API Setup.' };
      if (!accessToken) return { success: false, error: 'Access Token is required. Get a permanent token from Meta Business Settings → System Users.' };

      // Test the Meta WhatsApp API
      try {
        const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as any;
          const errMsg = data?.error?.message || `API error: ${res.status} ${res.statusText}`;
          return { success: false, error: `WhatsApp API test failed: ${errMsg}` };
        }
        const data = await res.json() as any;
        return { success: true, extra: { verifiedName: data.verified_name || data.display_phone_number } };
      } catch (err: any) {
        return { success: false, error: `Cannot reach WhatsApp API: ${err.message}` };
      }
    }
    return { success: true };
  }

  // ── Service account (BigQuery, Vertex AI) ──────────────────
  if (authMethod === 'service_account') {
    // Org connectors — validated at admin level
    return { success: true };
  }

  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════
// ─── OAuth URL Generation ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

/** Get OAuth URL for a connector that requires OAuth2 */
export async function getOAuthUrl(
  userId: number,
  connectorTypeId: string,
  userConfig?: Record<string, unknown>,
  options?: { returnTo?: string },
): Promise<{ url?: string; error?: string }> {
  const connectorType = await prisma.connectorType.findUnique({ where: { id: connectorTypeId } });
  if (!connectorType || connectorType.authMethod !== 'oauth2') {
    return { error: 'This connector does not use OAuth' };
  }

  // OAuth app credentials come from the platform-wide GCP project
  // (`tmcai-491811`). Per-user / per-tenant BYO-OAuth was retired in
  // 2026-05-04 — see memory `project_gcp_simplification.md`. Every
  // tenant + user shares the same `GOOGLE_CLIENT_ID` /
  // `GOOGLE_CLIENT_SECRET` from `.env`. User-only data lives in
  // `user_connectors.config` (the access/refresh tokens), nothing else.
  //
  // `let` (not `const`) because the Microsoft + Slack OAuth blocks
  // below reassign these locals. Those providers still carry the older
  // BYO-OAuth resolution chain — same simplification can be done in a
  // follow-up commit.
  const googleSlugs = ['gmail', 'google_calendar', 'google_tasks', 'google_chat', 'google_drive_personal', 'google_sheets'];
  let clientId = process.env.GOOGLE_CLIENT_ID || '';
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';

  const redirectUri = process.env.GOOGLE_CONNECTOR_REDIRECT_URI || 'http://localhost:4002/api/v1/connectors/oauth/callback';

  // For Google connectors
  if (googleSlugs.includes(connectorType.slug)) {
    if (!clientId || !clientSecret) {
      return { error: 'Google OAuth not configured. Enter your own Client ID and Client Secret below, or ask your admin to configure it.' };
    }
    try {
      const { google } = await import('googleapis');
      const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

      // Request ALL Google scopes at once — one token works for Gmail, Calendar, Tasks, Drive.
      // Google OAuth is designed for this: user consents once, token covers all scopes.
      const ALL_GOOGLE_SCOPES = [
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/tasks',
        'https://www.googleapis.com/auth/drive.readonly',
        // Google Chat — read user's spaces + recent messages so the chat
        // poller can pull DMs/spaces into Day Brief alongside email,
        // calendar, and tasks. Note: chat.messages.readonly only returns
        // messages from spaces where the calling app/user is a member;
        // workspace admin may need to enable the app per space for full
        // coverage. Fails open if denied.
        'https://www.googleapis.com/auth/chat.spaces.readonly',
        'https://www.googleapis.com/auth/chat.messages.readonly',
        // People API — powers the DelegateePicker's search across the user's
        // Google Contacts + Workspace directory. Without this, the picker
        // falls back to DB-only (MyOS users + scribed contacts + history).
        'https://www.googleapis.com/auth/contacts.readonly',
        'https://www.googleapis.com/auth/contacts.other.readonly',
        'https://www.googleapis.com/auth/directory.readonly',
      ];

      const url = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ALL_GOOGLE_SCOPES,
        // Pass which connector triggered this + all Google connector IDs so callback can mark them all.
        // returnTo lets the caller (e.g. admin client-connectors page) tell
        // the OAuth callback to redirect back to where the flow started
        // instead of the default /connectors page — fixes the "I went
        // through Google consent and ended up on the wrong page" UX.
        state: JSON.stringify({
          userId, connectorTypeId, clientId, clientSecret, markAllGoogle: true,
          returnTo: options?.returnTo ?? null,
        }),
      });
      return { url };
    } catch (err: any) {
      return { error: `OAuth setup failed: ${err.message}` };
    }
  }

  // For Microsoft connectors — Office 365 / Outlook / Teams / OneDrive / ms_todo.
  // Uses Microsoft Identity v2.0 (common tenant) so personal AND work accounts
  // both work. Same three-tier credential resolution as Google.
  const microsoftSlugs = ['outlook', 'outlook_calendar', 'ms_todo', 'ms_teams', 'onedrive_personal'];
  if (microsoftSlugs.includes(connectorType.slug)) {
    // Tier 1: form-supplied. Tier 2: saved on this UC. Tier 3: tenant-shared
    // admin config. Tier 4: env. Same precedence as Google family above.
    clientId = (userConfig?.clientId as string) || '';
    clientSecret = (userConfig?.clientSecret as string) || '';
    if (!clientId) {
      const existing = await prisma.userConnector.findUnique({
        where: { userId_connectorTypeId: { userId, connectorTypeId } },
      });
      if (existing?.config) {
        const cfg = await decryptConnectorConfig(existing.config as Record<string, unknown>);
        if (cfg.clientId) clientId = cfg.clientId as string;
        if (cfg.clientSecret) clientSecret = cfg.clientSecret as string;
      }
    }
    if (!clientId) {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { clientNumber: true } });
      if (u?.clientNumber) {
        const tenantTypeIds = (await prisma.connectorType.findMany({
          where: { slug: { in: microsoftSlugs } }, select: { id: true },
        })).map((t) => t.id);
        const tcfg = await prisma.tenantConnectorConfig.findFirst({
          where: { clientNumber: u.clientNumber, connectorTypeId: { in: tenantTypeIds } },
        });
        if (tcfg?.config) {
          const cfg = await decryptConnectorConfig(tcfg.config as Record<string, unknown>);
          const id = (cfg.oauthClientId || cfg.clientId) as string | undefined;
          const sec = (cfg.oauthClientSecret || cfg.clientSecret) as string | undefined;
          if (id) clientId = id;
          if (sec) clientSecret = sec;
        }
      }
    }
    if (!clientId) clientId = process.env.MICROSOFT_CLIENT_ID || '';
    if (!clientSecret) clientSecret = process.env.MICROSOFT_CLIENT_SECRET || '';
    if (!clientId || !clientSecret) {
      return { error: 'Microsoft OAuth not configured. Enter your own Client ID and Secret below, or ask your admin to configure it.' };
    }

    // Per-slug scope mapping. We request the minimal scopes needed for
    // each connector; admins can extend by passing custom scopes via
    // tenantConnectorConfig.config.scopes if needed.
    const scopesBySlug: Record<string, string[]> = {
      outlook:           ['Mail.Read', 'Mail.Send', 'Mail.ReadWrite', 'User.Read', 'offline_access'],
      outlook_calendar:  ['Calendars.ReadWrite', 'User.Read', 'offline_access'],
      ms_todo:           ['Tasks.ReadWrite', 'User.Read', 'offline_access'],
      ms_teams:          ['Chat.Read', 'Chat.ReadWrite', 'ChannelMessage.Read.All', 'User.Read', 'offline_access'],
      onedrive_personal: ['Files.Read', 'Files.ReadWrite', 'User.Read', 'offline_access'],
    };
    const scopes = scopesBySlug[connectorType.slug] ?? ['User.Read', 'offline_access'];
    const redirectUri = process.env.MICROSOFT_CONNECTOR_REDIRECT_URI
      || process.env.GOOGLE_CONNECTOR_REDIRECT_URI?.replace('/api/v1/connectors/oauth/callback', '/api/v1/connectors/oauth/callback')
      || 'http://localhost:4002/api/v1/connectors/oauth/callback';

    // Microsoft Identity v2 endpoint. `common` tenant accepts both
    // personal Microsoft accounts (Outlook.com) and any work/school
    // tenant — minimal friction for the user.
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: scopes.join(' '),
      state: JSON.stringify({ userId, connectorTypeId, clientId, clientSecret, provider: 'microsoft' }),
      prompt: 'consent',
    });
    const url = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
    return { url };
  }

  // Slack OAuth — admin installs MyOS to a workspace. We use the v2
  // OAuth flow which returns a bot token + user token. Bot token drives
  // the SlackFeedAdapter for inbound + send_chat_reply for outbound.
  if (connectorType.slug === 'slack') {
    clientId = (userConfig?.clientId as string) || '';
    clientSecret = (userConfig?.clientSecret as string) || '';
    if (!clientId) {
      const existing = await prisma.userConnector.findUnique({
        where: { userId_connectorTypeId: { userId, connectorTypeId } },
      });
      if (existing?.config) {
        const cfg = await decryptConnectorConfig(existing.config as Record<string, unknown>);
        if (cfg.clientId) clientId = cfg.clientId as string;
        if (cfg.clientSecret) clientSecret = cfg.clientSecret as string;
      }
    }
    if (!clientId) clientId = process.env.SLACK_CLIENT_ID || '';
    if (!clientSecret) clientSecret = process.env.SLACK_CLIENT_SECRET || '';
    if (!clientId || !clientSecret) {
      return { error: 'Slack OAuth not configured. Enter your own Slack app Client ID and Secret below, or ask your admin to configure it.' };
    }
    const slackRedirect = process.env.SLACK_CONNECTOR_REDIRECT_URI || redirectUri;
    const params = new URLSearchParams({
      client_id: clientId,
      scope: 'channels:history,channels:read,chat:write,im:history,im:read,mpim:history,mpim:read,users:read,users:read.email,team:read',
      user_scope: 'identify',
      redirect_uri: slackRedirect,
      state: JSON.stringify({ userId, connectorTypeId, clientId, clientSecret, provider: 'slack' }),
    });
    return { url: `https://slack.com/oauth/v2/authorize?${params.toString()}` };
  }

  return { error: `OAuth not yet implemented for ${connectorType.name}. Enter your own Client ID and Secret below.` };
}

/** Handle OAuth callback — save tokens to UserConnector */
export async function handleOAuthCallback(code: string, state: string): Promise<{ success: boolean; error?: string; slug?: string }> {
  try {
    const { userId, connectorTypeId, clientId: stateClientId, clientSecret: stateClientSecret, markAllGoogle } = JSON.parse(state);
    const connectorType = await prisma.connectorType.findUnique({ where: { id: connectorTypeId } });
    if (!connectorType) return { success: false, error: 'Unknown connector' };

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { success: false, error: 'Unknown user' };

    // Use credentials from state (user-provided) or fall back to env vars
    const oauthClientId = stateClientId || process.env.GOOGLE_CLIENT_ID;
    const oauthClientSecret = stateClientSecret || process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_CONNECTOR_REDIRECT_URI || 'http://localhost:4002/api/v1/connectors/oauth/callback';

    // Google OAuth
    const googleSlugs = ['gmail', 'google_calendar', 'google_tasks', 'google_chat', 'google_drive_personal'];
    if (googleSlugs.includes(connectorType.slug)) {
      const { google } = await import('googleapis');
      const client = new google.auth.OAuth2(oauthClientId, oauthClientSecret, redirectUri);

      const { tokens } = await client.getToken(code);
      if (!tokens.access_token) return { success: false, error: 'No access token received' };

      // Get email
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const userInfo = await oauth2.userinfo.get();
      const email = userInfo.data.email || '';

      // Save to UserConnector — ALWAYS save clientId/Secret so token refresh works
      const configToSave: Record<string, unknown> = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : '',
        email,
        provider: 'google',
        clientId: oauthClientId,
        clientSecret: oauthClientSecret,
      };
      const encryptedConfig = await encryptConnectorConfig(configToSave);

      // Save for the triggering connector
      await prisma.userConnector.upsert({
        where: { userId_connectorTypeId: { userId, connectorTypeId } },
        create: { userId, clientNumber: user.clientNumber, connectorTypeId, config: encryptedConfig as any, status: 'connected' },
        update: { config: encryptedConfig as any, status: 'connected', errorMessage: null },
      });

      // If markAllGoogle: save same token for ALL Google connectors (one auth covers all scopes)
      if (markAllGoogle) {
        const allGoogleSlugs = ['gmail', 'google_calendar', 'google_tasks', 'google_chat', 'google_drive_personal'];
        const allGoogleTypes = await prisma.connectorType.findMany({ where: { slug: { in: allGoogleSlugs } } });
        // Also check which connectors are enabled for this tenant
        for (const gt of allGoogleTypes) {
          if (gt.id === connectorTypeId) continue; // already saved above
          const tenantConfig = await prisma.tenantConnectorConfig.findUnique({
            where: { clientNumber_connectorTypeId: { clientNumber: user.clientNumber, connectorTypeId: gt.id } },
          });
          if (tenantConfig?.isEnabled) {
            await prisma.userConnector.upsert({
              where: { userId_connectorTypeId: { userId, connectorTypeId: gt.id } },
              create: { userId, clientNumber: user.clientNumber, connectorTypeId: gt.id, config: encryptedConfig as any, status: 'connected' },
              update: { config: encryptedConfig as any, status: 'connected', errorMessage: null },
            });
          }
        }
        console.log(`[Connector] Google OAuth: marked all enabled Google connectors as connected for user ${userId}`);
      }

      // Also update legacy integration fields on User (for backward compatibility)
      if (connectorType.slug === 'gmail' || connectorType.slug === 'google_calendar') {
        await prisma.user.update({
          where: { id: userId },
          data: {
            integrationProvider: 'google',
            integrationEmail: email,
            integrationAccessToken: tokens.access_token,
            integrationRefreshToken: tokens.refresh_token || undefined,
            integrationTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
            integrationScopes: connectorType.slug === 'gmail' ? 'email,calendar' : 'calendar',
            integrationStatus: 'active',
            integrationError: null,
          },
        });
      }

      return { success: true, slug: connectorType.slug };
    }

    // Microsoft OAuth — exchanges the auth code for an access+refresh
    // token via Identity v2.0 token endpoint, then saves to UserConnector.
    const microsoftSlugs = ['outlook', 'outlook_calendar', 'ms_todo', 'ms_teams', 'onedrive_personal'];
    if (microsoftSlugs.includes(connectorType.slug)) {
      const msClientId = stateClientId || process.env.MICROSOFT_CLIENT_ID;
      const msClientSecret = stateClientSecret || process.env.MICROSOFT_CLIENT_SECRET;
      const msRedirectUri = process.env.MICROSOFT_CONNECTOR_REDIRECT_URI || redirectUri;
      if (!msClientId || !msClientSecret) {
        return { success: false, error: 'Microsoft OAuth credentials missing on callback' };
      }

      const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: msClientId,
          client_secret: msClientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: msRedirectUri,
        }).toString(),
      });
      if (!tokenRes.ok) {
        const txt = await tokenRes.text().catch(() => '');
        return { success: false, error: `Microsoft token exchange failed: ${txt.slice(0, 240)}` };
      }
      const tokenJson: any = await tokenRes.json();
      if (!tokenJson.access_token) {
        return { success: false, error: 'No access token from Microsoft' };
      }

      // Pull user identity (email) so the UI can show "connected as foo@bar".
      let email = '';
      try {
        const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${tokenJson.access_token}` },
        });
        if (meRes.ok) {
          const me: any = await meRes.json();
          email = me.userPrincipalName || me.mail || me.email || '';
        }
      } catch { /* email is best-effort */ }

      const expiry = tokenJson.expires_in
        ? new Date(Date.now() + Number(tokenJson.expires_in) * 1000).toISOString()
        : '';
      const configToSave: Record<string, unknown> = {
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token || '',
        tokenExpiry: expiry,
        scope: tokenJson.scope || '',
        email,
        provider: 'microsoft',
        clientId: msClientId,
        clientSecret: msClientSecret,
      };
      const encryptedConfig = await encryptConnectorConfig(configToSave);
      await prisma.userConnector.upsert({
        where: { userId_connectorTypeId: { userId, connectorTypeId } },
        create: { userId, clientNumber: user.clientNumber, connectorTypeId, config: encryptedConfig as any, status: 'connected' },
        update: { config: encryptedConfig as any, status: 'connected', errorMessage: null },
      });

      console.log(`[Connector] Microsoft OAuth: ${connectorType.slug} connected for user ${userId} as ${email || '(unknown email)'}`);
      return { success: true, slug: connectorType.slug };
    }

    // Slack OAuth callback — exchanges code for bot + user tokens.
    if (connectorType.slug === 'slack') {
      const slackClientId = stateClientId || process.env.SLACK_CLIENT_ID;
      const slackClientSecret = stateClientSecret || process.env.SLACK_CLIENT_SECRET;
      const slackRedirectUri = process.env.SLACK_CONNECTOR_REDIRECT_URI || redirectUri;
      if (!slackClientId || !slackClientSecret) {
        return { success: false, error: 'Slack OAuth credentials missing on callback' };
      }
      const tokRes = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: slackClientId,
          client_secret: slackClientSecret,
          code,
          redirect_uri: slackRedirectUri,
        }).toString(),
      });
      const tok: any = await tokRes.json().catch(() => ({}));
      if (!tok.ok || !tok.access_token) {
        return { success: false, error: `Slack OAuth failed: ${tok.error ?? 'unknown'}` };
      }
      const configToSave: Record<string, unknown> = {
        botToken: tok.access_token,                        // xoxb-…
        userToken: tok.authed_user?.access_token || '',    // xoxp-…
        teamId: tok.team?.id || '',
        teamName: tok.team?.name || '',
        botUserId: tok.bot_user_id || '',
        scope: tok.scope || '',
        provider: 'slack',
        clientId: slackClientId,
        clientSecret: slackClientSecret,
      };
      const encryptedConfig = await encryptConnectorConfig(configToSave);
      await prisma.userConnector.upsert({
        where: { userId_connectorTypeId: { userId, connectorTypeId } },
        create: { userId, clientNumber: user.clientNumber, connectorTypeId, config: encryptedConfig as any, status: 'connected' },
        update: { config: encryptedConfig as any, status: 'connected', errorMessage: null },
      });
      console.log(`[Connector] Slack OAuth: workspace ${tok.team?.name} connected for user ${userId}`);
      return { success: true, slug: connectorType.slug };
    }

    return { success: false, error: 'OAuth handler not implemented for this provider' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── Encryption helpers ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

export async function encryptConnectorConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sensitiveKeys = ['apiKey', 'apiToken', 'password', 'secret', 'token', 'refreshToken', 'accessToken', 'botToken', 'webhookSecret'];
  const encrypted: Record<string, unknown> = { ...config };

  for (const key of sensitiveKeys) {
    if (typeof encrypted[key] === 'string' && encrypted[key]) {
      try {
        encrypted[key] = await encrypt(encrypted[key] as string);
      } catch {
        // If encryption service not available, store as-is (dev mode)
      }
    }
  }

  return encrypted;
}

export async function decryptConnectorConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sensitiveKeys = ['apiKey', 'apiToken', 'password', 'secret', 'token', 'refreshToken', 'accessToken', 'botToken', 'webhookSecret'];
  const decrypted: Record<string, unknown> = { ...config };

  for (const key of sensitiveKeys) {
    if (typeof decrypted[key] === 'string' && decrypted[key]) {
      try {
        decrypted[key] = await decrypt(decrypted[key] as string);
      } catch {
        // If decryption fails, return as-is (might not be encrypted)
      }
    }
  }

  return decrypted;
}
