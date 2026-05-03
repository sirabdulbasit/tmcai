/**
 * MyOS Connector Registry
 *
 * Static registry of all supported connector types.
 * Category-based: multiple providers per category, user picks ONE per category.
 * Two scopes: personal (user configures) and organizational (admin configures).
 *
 * Seeded on first deploy via seedConnectorTypes().
 */

import prisma from '../db/prisma';

export interface ConnectorTypeSeed {
  slug: string;
  name: string;
  description: string;
  category: string;
  scope: 'personal' | 'organizational';
  authMethod: string;
  configSchema: Record<string, unknown>;
  capabilities: string[];
  icon: string;
}

/**
 * Honest readiness state per slug.
 *
 *   production  Connection ceremony AND data path both work end-to-end.
 *               Admins/users can pair via Connectors UI and Brain
 *               actually reads/writes data via this connector today.
 *   beta        Connection works, but data path is partial. UI should
 *               warn before pairing.
 *   declared    Slug exists in registry but neither connection nor
 *               data path is wired. Hidden from default UI; surfaced
 *               only when admin enables "show experimental connectors".
 */
export type ConnectorReadiness = 'production' | 'beta' | 'declared';

/**
 * Single source of truth for what's actually buildable today. Sync with
 * implementation: when an OAuth flow + adapter both ship, promote
 * 'declared' → 'beta' → 'production'.
 */
export const CONNECTOR_READINESS: Record<string, ConnectorReadiness> = {
  // Google family — full OAuth + adapters live
  gmail: 'production',
  google_calendar: 'production',
  google_tasks: 'production',
  google_chat: 'production',
  google_drive_personal: 'production',
  google_drive_org: 'production',
  google_sheets: 'production',
  bigquery: 'declared',

  // Microsoft family — OAuth + adapters live for outlook + calendar
  // + teams + onedrive. ms_todo OAuth ready, adapter not yet.
  outlook: 'production',
  outlook_calendar: 'production',
  ms_todo: 'beta',
  ms_teams: 'production',
  onedrive_personal: 'production',
  onedrive_org: 'beta',

  // Messaging — Slack OAuth + inbound adapter + send_slack_message action all live
  slack: 'production',
  ms_teams_org: 'declared',
  telegram: 'declared',
  whatsapp: 'beta',           // Meta Business API skeleton, not active
  whatsapp_personal: 'production',  // WebJS pairing live

  // Notion / Drive / FACL
  notion_personal: 'production',
  notion_tasks: 'declared',

  // Tasks
  trello: 'declared',
  ms_todo_personal: 'declared',
  todoist: 'declared',
  clickup_personal: 'declared',

  // Social / video
  zoom: 'declared',
  linkedin_personal: 'declared',
  twitter_x: 'declared',
};

export function getReadiness(slug: string): ConnectorReadiness {
  return CONNECTOR_READINESS[slug] ?? 'declared';
}

// ─── Personal Connectors ──────────────────────────────────────────

const personalConnectors: ConnectorTypeSeed[] = [
  // Email
  {
    slug: 'gmail',
    name: 'Gmail',
    description: 'Read, search, and send emails via Google Gmail',
    category: 'email',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'google', scopes: ['gmail.readonly', 'gmail.send', 'gmail.modify'] },
    capabilities: ['read', 'write'],
    icon: 'gmail',
  },
  {
    slug: 'outlook',
    name: 'Microsoft Outlook',
    description: 'Read and send emails via Microsoft Outlook / Office 365',
    category: 'email',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'microsoft', scopes: ['Mail.Read', 'Mail.Send'] },
    capabilities: ['read', 'write'],
    icon: 'outlook',
  },

  // Calendar
  {
    slug: 'google_calendar',
    name: 'Google Calendar',
    description: 'View events, create meetings, manage RSVPs',
    category: 'calendar',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'google', scopes: ['calendar.readonly', 'calendar.events'] },
    capabilities: ['read', 'write'],
    icon: 'google_calendar',
  },
  {
    slug: 'outlook_calendar',
    name: 'Outlook Calendar',
    description: 'View and create events via Microsoft Calendar',
    category: 'calendar',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'microsoft', scopes: ['Calendars.ReadWrite'] },
    capabilities: ['read', 'write'],
    icon: 'outlook_calendar',
  },

  // Tasks
  {
    slug: 'google_tasks',
    name: 'Google Tasks',
    description: 'Sync tasks bidirectionally with open items',
    category: 'tasks',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'google', scopes: ['tasks'] },
    capabilities: ['read', 'write'],
    icon: 'google_tasks',
  },
  {
    slug: 'ms_todo',
    name: 'Microsoft To Do',
    description: 'Sync tasks with Microsoft To Do lists',
    category: 'tasks',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'microsoft', scopes: ['Tasks.ReadWrite'] },
    capabilities: ['read', 'write'],
    icon: 'ms_todo',
  },
  {
    slug: 'todoist',
    name: 'Todoist',
    description: 'Sync tasks, projects, and priorities with Todoist',
    category: 'tasks',
    scope: 'personal',
    authMethod: 'api_key',
    configSchema: { fields: [{ name: 'apiKey', label: 'API Key', type: 'password', required: true }] },
    capabilities: ['read', 'write'],
    icon: 'todoist',
  },
  {
    slug: 'trello',
    name: 'Trello',
    description: 'Sync cards and boards with Trello',
    category: 'tasks',
    scope: 'personal',
    authMethod: 'api_key',
    configSchema: { fields: [{ name: 'apiKey', label: 'API Key', type: 'password', required: true }, { name: 'token', label: 'Token', type: 'password', required: true }] },
    capabilities: ['read', 'write'],
    icon: 'trello',
  },
  {
    slug: 'clickup_personal',
    name: 'ClickUp',
    description: 'Sync personal tasks and lists with ClickUp',
    category: 'tasks',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'clickup' },
    capabilities: ['read', 'write'],
    icon: 'clickup',
  },
  {
    slug: 'notion_tasks',
    name: 'Notion Tasks',
    description: 'Sync Notion database items as tasks',
    category: 'tasks',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'notion', fields: [{ name: 'databaseId', label: 'Database ID', type: 'text', required: true }] },
    capabilities: ['read', 'write'],
    icon: 'notion',
  },

  // Messaging
  {
    slug: 'whatsapp',
    name: 'WhatsApp (Meta Cloud API)',
    description: 'Send and receive WhatsApp messages via Meta Cloud API (tenant-scoped).',
    category: 'messaging',
    scope: 'personal',
    authMethod: 'webhook',
    configSchema: { fields: [{ name: 'phoneNumber', label: 'Phone Number', type: 'tel', required: true }] },
    capabilities: ['read', 'write'],
    icon: 'whatsapp',
  },
  {
    slug: 'whatsapp_personal',
    name: 'WhatsApp (Personal)',
    description: 'Pair your personal WhatsApp via QR scan. Brain reads incoming chats, replies, and marks as read.',
    category: 'messaging',
    scope: 'personal',
    authMethod: 'qr_pair',
    configSchema: { fields: [] },
    capabilities: ['read', 'write'],
    icon: 'whatsapp',
  },
  {
    slug: 'telegram',
    name: 'Telegram',
    description: 'Send and receive Telegram messages via bot',
    category: 'messaging',
    scope: 'personal',
    authMethod: 'bot_token',
    configSchema: { fields: [{ name: 'botToken', label: 'Bot Token', type: 'password', required: true }, { name: 'chatId', label: 'Chat ID', type: 'text', required: true }] },
    capabilities: ['read', 'write'],
    icon: 'telegram',
  },

  // Chat
  {
    slug: 'google_chat',
    name: 'Google Chat',
    description: 'Read and send Google Chat messages',
    category: 'chat',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'google', scopes: ['chat.messages'] },
    capabilities: ['read', 'write'],
    icon: 'google_chat',
  },
  {
    slug: 'slack',
    name: 'Slack',
    description: 'Read DMs, mentions, and send messages on Slack',
    category: 'chat',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'slack', scopes: ['chat:write', 'channels:read', 'im:read'] },
    capabilities: ['read', 'write'],
    icon: 'slack',
  },
  {
    slug: 'ms_teams',
    name: 'Microsoft Teams',
    description: 'Read and send Microsoft Teams messages',
    category: 'chat',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'microsoft', scopes: ['Chat.ReadWrite'] },
    capabilities: ['read', 'write'],
    icon: 'ms_teams',
  },

  // Drive (Personal)
  {
    slug: 'google_drive_personal',
    name: 'Google Drive',
    description: 'Access personal Google Drive files and documents',
    category: 'drive',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'google', scopes: ['drive.readonly'] },
    capabilities: ['read'],
    icon: 'google_drive',
  },
  {
    slug: 'onedrive_personal',
    name: 'OneDrive',
    description: 'Access personal OneDrive files and documents',
    category: 'drive',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'microsoft', scopes: ['Files.Read'] },
    capabilities: ['read'],
    icon: 'onedrive',
  },

  // Social
  {
    slug: 'linkedin_personal',
    name: 'LinkedIn',
    description: 'Read profile, connections, and messages on LinkedIn',
    category: 'social',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'linkedin', scopes: ['r_liteprofile', 'r_emailaddress', 'w_member_social'] },
    capabilities: ['read', 'write'],
    icon: 'linkedin',
  },
  {
    slug: 'twitter_x',
    name: 'Twitter / X',
    description: 'Read mentions, DMs, and post on Twitter/X',
    category: 'social',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'twitter', scopes: ['tweet.read', 'tweet.write', 'dm.read'] },
    capabilities: ['read', 'write'],
    icon: 'twitter',
  },

  // Meetings
  {
    slug: 'zoom',
    name: 'Zoom',
    description: 'View and schedule Zoom meetings',
    category: 'meetings',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'zoom', scopes: ['meeting:read', 'meeting:write'] },
    capabilities: ['read', 'write'],
    icon: 'zoom',
  },

  // Notes
  {
    slug: 'notion_personal',
    name: 'Notion',
    description: 'Read and create personal Notion pages and databases',
    category: 'notes',
    scope: 'personal',
    authMethod: 'oauth2',
    configSchema: { provider: 'notion' },
    capabilities: ['read', 'write'],
    icon: 'notion',
  },
];

// ─── Organizational Connectors ────────────────────────────────────

const orgConnectors: ConnectorTypeSeed[] = [
  // Drive (Org)
  {
    slug: 'google_drive_org',
    name: 'Google Drive (Org)',
    description: 'Organization shared Drive for context files, rule books, and documents',
    category: 'drive',
    scope: 'organizational',
    authMethod: 'service_account',
    configSchema: { fields: [{ name: 'folderId', label: 'Drive Folder ID', type: 'text', required: true }] },
    capabilities: ['read', 'write'],
    icon: 'google_drive',
  },
  {
    slug: 'onedrive_org',
    name: 'OneDrive / SharePoint',
    description: 'Organization SharePoint document libraries and shared files',
    category: 'drive',
    scope: 'organizational',
    authMethod: 'oauth2',
    configSchema: { provider: 'microsoft', scopes: ['Files.Read.All', 'Sites.Read.All'] },
    capabilities: ['read', 'write'],
    icon: 'sharepoint',
  },

  // Data Warehouse
  {
    slug: 'bigquery',
    name: 'BigQuery',
    description: 'Query business data from Google BigQuery datasets',
    category: 'data_warehouse',
    scope: 'organizational',
    authMethod: 'service_account',
    configSchema: { fields: [{ name: 'projectId', label: 'GCP Project ID', type: 'text', required: true }, { name: 'datasetId', label: 'Dataset ID', type: 'text', required: true }] },
    capabilities: ['read'],
    icon: 'bigquery',
  },

  // Spreadsheets
  {
    slug: 'google_sheets',
    name: 'Google Sheets',
    description: 'Read and write to shared Google Sheets for reports and decision logs',
    category: 'spreadsheets',
    scope: 'organizational',
    authMethod: 'service_account',
    configSchema: { fields: [{ name: 'spreadsheetId', label: 'Spreadsheet ID', type: 'text', required: true }] },
    capabilities: ['read', 'write'],
    icon: 'google_sheets',
  },

  // Chat (Org)
  {
    slug: 'google_chat_spaces',
    name: 'Google Chat Spaces',
    description: 'Send team briefers and delegation messages to Google Chat spaces',
    category: 'chat',
    scope: 'organizational',
    authMethod: 'webhook',
    configSchema: { fields: [{ name: 'webhookUrls', label: 'Webhook URLs (JSON array)', type: 'textarea', required: true }] },
    capabilities: ['write'],
    icon: 'google_chat',
  },
  {
    slug: 'slack_workspace',
    name: 'Slack Workspace',
    description: 'Send team briefers and alerts to Slack channels',
    category: 'chat',
    scope: 'organizational',
    authMethod: 'oauth2',
    configSchema: { provider: 'slack', scopes: ['chat:write', 'channels:read', 'channels:history'] },
    capabilities: ['read', 'write'],
    icon: 'slack',
  },
  {
    slug: 'ms_teams_org',
    name: 'Microsoft Teams (Org)',
    description: 'Send team briefers and alerts to Microsoft Teams channels',
    category: 'chat',
    scope: 'organizational',
    authMethod: 'oauth2',
    configSchema: { provider: 'microsoft', scopes: ['ChannelMessage.Send', 'Channel.ReadBasic.All'] },
    capabilities: ['read', 'write'],
    icon: 'ms_teams',
  },

  // Project Management
  {
    slug: 'notion_org',
    name: 'Notion (Org)',
    description: 'Organization Notion workspace for project tracking and knowledge',
    category: 'project_mgmt',
    scope: 'organizational',
    authMethod: 'api_key',
    configSchema: { fields: [{ name: 'apiKey', label: 'Integration Token', type: 'password', required: true }] },
    capabilities: ['read', 'write'],
    icon: 'notion',
  },
  {
    slug: 'jira',
    name: 'Jira',
    description: 'Track issues, sprints, and backlogs from Jira',
    category: 'project_mgmt',
    scope: 'organizational',
    authMethod: 'api_key',
    configSchema: { fields: [{ name: 'domain', label: 'Jira Domain', type: 'text', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'apiToken', label: 'API Token', type: 'password', required: true }] },
    capabilities: ['read', 'write'],
    icon: 'jira',
  },
  {
    slug: 'asana',
    name: 'Asana',
    description: 'Track tasks, projects, and portfolios from Asana',
    category: 'project_mgmt',
    scope: 'organizational',
    authMethod: 'oauth2',
    configSchema: { provider: 'asana' },
    capabilities: ['read', 'write'],
    icon: 'asana',
  },

  // ERP
  {
    slug: 'sap',
    name: 'SAP ERP',
    description: 'Financial monitoring, project data, AR/AP, risks, and OKRs from SAP',
    category: 'erp',
    scope: 'organizational',
    authMethod: 'credentials',
    configSchema: { fields: [{ name: 'baseUrl', label: 'SAP API URL', type: 'url', required: true }, { name: 'username', label: 'Username', type: 'text', required: true }, { name: 'password', label: 'Password', type: 'password', required: true }, { name: 'client', label: 'Client Number', type: 'text', required: false }] },
    capabilities: ['read', 'write'],
    icon: 'sap',
  },
  {
    slug: 'odoo',
    name: 'Odoo ERP/CRM',
    description: 'CRM pipeline, invoicing, projects, and HR data from Odoo',
    category: 'erp',
    scope: 'organizational',
    authMethod: 'api_key',
    configSchema: { fields: [{ name: 'baseUrl', label: 'Odoo URL', type: 'url', required: true }, { name: 'database', label: 'Database', type: 'text', required: true }, { name: 'apiKey', label: 'API Key', type: 'password', required: true }] },
    capabilities: ['read', 'write'],
    icon: 'odoo',
  },
  {
    slug: 'dynamics365',
    name: 'Microsoft Dynamics 365',
    description: 'Financials, CRM, and project data from Dynamics 365',
    category: 'erp',
    scope: 'organizational',
    authMethod: 'oauth2',
    configSchema: { provider: 'microsoft', scopes: ['Financials.ReadWrite.All'] },
    capabilities: ['read', 'write'],
    icon: 'dynamics',
  },

  // CRM
  {
    slug: 'salesforce',
    name: 'Salesforce',
    description: 'Leads, opportunities, accounts, and contacts from Salesforce',
    category: 'crm',
    scope: 'organizational',
    authMethod: 'oauth2',
    configSchema: { provider: 'salesforce' },
    capabilities: ['read', 'write'],
    icon: 'salesforce',
  },
  {
    slug: 'hubspot',
    name: 'HubSpot',
    description: 'Contacts, deals, companies, and tickets from HubSpot',
    category: 'crm',
    scope: 'organizational',
    authMethod: 'api_key',
    configSchema: { fields: [{ name: 'apiKey', label: 'Private App Token', type: 'password', required: true }] },
    capabilities: ['read', 'write'],
    icon: 'hubspot',
  },

  // HR / ESS
  {
    slug: 'ess_hr',
    name: 'HR / ESS System',
    description: 'Appraisals, leave, attendance, payroll, and approval requests',
    category: 'hr',
    scope: 'organizational',
    authMethod: 'api_key',
    configSchema: { fields: [{ name: 'baseUrl', label: 'API URL', type: 'url', required: true }, { name: 'apiKey', label: 'API Key', type: 'password', required: true }] },
    capabilities: ['read', 'write'],
    icon: 'hr',
  },
  {
    slug: 'bamboohr',
    name: 'BambooHR',
    description: 'Employee data, time off, and reports from BambooHR',
    category: 'hr',
    scope: 'organizational',
    authMethod: 'api_key',
    configSchema: { fields: [{ name: 'subdomain', label: 'BambooHR Subdomain', type: 'text', required: true }, { name: 'apiKey', label: 'API Key', type: 'password', required: true }] },
    capabilities: ['read'],
    icon: 'bamboohr',
  },

  // Intelligence
  {
    slug: 'vertex_ai',
    name: 'Vertex AI / Known',
    description: 'Org-wide email intelligence: risks, opportunities, employee flags, sentiment',
    category: 'intelligence',
    scope: 'organizational',
    authMethod: 'service_account',
    configSchema: { fields: [{ name: 'projectId', label: 'GCP Project ID', type: 'text', required: true }, { name: 'endpointId', label: 'Endpoint ID', type: 'text', required: false }] },
    capabilities: ['read'],
    icon: 'vertex_ai',
  },

  // Support
  {
    slug: 'zendesk',
    name: 'Zendesk',
    description: 'Monitor support tickets and customer satisfaction scores',
    category: 'support',
    scope: 'organizational',
    authMethod: 'api_key',
    configSchema: { fields: [{ name: 'subdomain', label: 'Zendesk Subdomain', type: 'text', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'apiToken', label: 'API Token', type: 'password', required: true }] },
    capabilities: ['read'],
    icon: 'zendesk',
  },

  // Dev / Ops
  {
    slug: 'github',
    name: 'GitHub',
    description: 'Monitor repos, issues, PRs, and deployments',
    category: 'dev',
    scope: 'organizational',
    authMethod: 'oauth2',
    configSchema: { provider: 'github', fields: [{ name: 'org', label: 'Organization', type: 'text', required: false }] },
    capabilities: ['read'],
    icon: 'github',
  },

  // Markdown (legacy data source)
  {
    slug: 'markdown_files',
    name: 'Markdown Data Files',
    description: 'Business data index files in Markdown format',
    category: 'kb',
    scope: 'organizational',
    authMethod: 'none',
    configSchema: { fields: [{ name: 'filePath', label: 'File Path or Drive ID', type: 'text', required: true }] },
    capabilities: ['read'],
    icon: 'markdown',
  },

  // Custom
  {
    slug: 'custom_rest',
    name: 'Custom REST API',
    description: 'Connect to any external system via REST API',
    category: 'custom',
    scope: 'organizational',
    authMethod: 'api_key',
    configSchema: { fields: [{ name: 'baseUrl', label: 'Base URL', type: 'url', required: true }, { name: 'apiKey', label: 'API Key', type: 'password', required: false }, { name: 'headers', label: 'Custom Headers (JSON)', type: 'textarea', required: false }] },
    capabilities: ['read', 'write'],
    icon: 'api',
  },
  {
    slug: 'webhook_inbound',
    name: 'Inbound Webhook',
    description: 'Receive events from any external system via webhook POST',
    category: 'custom',
    scope: 'organizational',
    authMethod: 'webhook',
    configSchema: { fields: [{ name: 'secret', label: 'Webhook Secret', type: 'password', required: true }] },
    capabilities: ['read'],
    icon: 'webhook',
  },
];

// ─── Seed function ────────────────────────────────────────────────

export const ALL_CONNECTOR_TYPES = [...personalConnectors, ...orgConnectors];

export async function seedConnectorTypes(): Promise<void> {
  let created = 0;
  let skipped = 0;

  for (const ct of ALL_CONNECTOR_TYPES) {
    const existing = await prisma.connectorType.findUnique({ where: { slug: ct.slug } });
    if (existing) {
      skipped++;
      continue;
    }

    await prisma.connectorType.create({
      data: {
        slug: ct.slug,
        name: ct.name,
        description: ct.description,
        category: ct.category,
        scope: ct.scope,
        authMethod: ct.authMethod,
        configSchema: ct.configSchema as any,
        capabilities: ct.capabilities as any,
        icon: ct.icon,
      },
    });
    created++;
  }

  console.log(`[ConnectorRegistry] Seeded ${created} new connector types, ${skipped} already existed`);
}

// ─── Lookup helpers ───────────────────────────────────────────────

export function getPersonalCategories(): string[] {
  const cats = new Set(personalConnectors.map(c => c.category));
  return [...cats];
}

export function getOrgCategories(): string[] {
  const cats = new Set(orgConnectors.map(c => c.category));
  return [...cats];
}

export function getProvidersByCategory(category: string, scope: 'personal' | 'organizational'): ConnectorTypeSeed[] {
  const source = scope === 'personal' ? personalConnectors : orgConnectors;
  return source.filter(c => c.category === category);
}
