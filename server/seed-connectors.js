const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const connectors = [
  { slug: 'gmail', name: 'Gmail', description: 'Read, search, and send emails via Google Gmail', category: 'email', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'gmail' },
  { slug: 'outlook', name: 'Microsoft Outlook', description: 'Read and send emails via Outlook / O365', category: 'email', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'outlook' },
  { slug: 'google_calendar', name: 'Google Calendar', description: 'View events, create meetings, manage RSVPs', category: 'calendar', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'google_calendar' },
  { slug: 'outlook_calendar', name: 'Outlook Calendar', description: 'View and create events via Microsoft Calendar', category: 'calendar', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'outlook_calendar' },
  { slug: 'google_tasks', name: 'Google Tasks', description: 'Sync tasks bidirectionally with open items', category: 'tasks', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'google_tasks' },
  { slug: 'ms_todo', name: 'Microsoft To Do', description: 'Sync tasks with Microsoft To Do', category: 'tasks', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'ms_todo' },
  { slug: 'todoist', name: 'Todoist', description: 'Sync tasks, projects, and priorities', category: 'tasks', scope: 'personal', authMethod: 'api_key', configSchema: {}, capabilities: ['read','write'], icon: 'todoist' },
  { slug: 'trello', name: 'Trello', description: 'Sync cards and boards', category: 'tasks', scope: 'personal', authMethod: 'api_key', configSchema: {}, capabilities: ['read','write'], icon: 'trello' },
  { slug: 'whatsapp', name: 'WhatsApp', description: 'Send and receive WhatsApp messages', category: 'messaging', scope: 'personal', authMethod: 'webhook', configSchema: {}, capabilities: ['read','write'], icon: 'whatsapp' },
  { slug: 'telegram', name: 'Telegram', description: 'Send and receive Telegram messages', category: 'messaging', scope: 'personal', authMethod: 'bot_token', configSchema: {}, capabilities: ['read','write'], icon: 'telegram' },
  { slug: 'google_chat', name: 'Google Chat', description: 'Read and send Google Chat messages', category: 'chat', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'google_chat' },
  { slug: 'slack', name: 'Slack', description: 'Read DMs, mentions, and send messages', category: 'chat', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'slack' },
  { slug: 'ms_teams', name: 'Microsoft Teams', description: 'Read and send Teams messages', category: 'chat', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'ms_teams' },
  { slug: 'google_drive_personal', name: 'Google Drive', description: 'Access personal Google Drive files', category: 'drive', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read'], icon: 'google_drive' },
  { slug: 'onedrive_personal', name: 'OneDrive', description: 'Access personal OneDrive files', category: 'drive', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read'], icon: 'onedrive' },
  { slug: 'linkedin_personal', name: 'LinkedIn', description: 'Read profile, connections, messages', category: 'social', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'linkedin' },
  { slug: 'twitter_x', name: 'Twitter / X', description: 'Read mentions, DMs, and post', category: 'social', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'twitter' },
  { slug: 'zoom', name: 'Zoom', description: 'View and schedule Zoom meetings', category: 'meetings', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'zoom' },
  { slug: 'notion_personal', name: 'Notion', description: 'Read and create personal Notion pages', category: 'notes', scope: 'personal', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'notion' },
  { slug: 'sap', name: 'SAP ERP', description: 'Financial monitoring, project data, AR/AP, risks', category: 'erp', scope: 'organizational', authMethod: 'credentials', configSchema: {}, capabilities: ['read','write'], icon: 'sap' },
  { slug: 'odoo', name: 'Odoo ERP/CRM', description: 'CRM pipeline, invoicing, projects, HR', category: 'erp', scope: 'organizational', authMethod: 'api_key', configSchema: {}, capabilities: ['read','write'], icon: 'odoo' },
  { slug: 'bigquery', name: 'BigQuery', description: 'Query business data from BigQuery', category: 'data_warehouse', scope: 'organizational', authMethod: 'service_account', configSchema: {}, capabilities: ['read'], icon: 'bigquery' },
  { slug: 'google_drive_org', name: 'Google Drive (Org)', description: 'Organization shared Drive', category: 'drive', scope: 'organizational', authMethod: 'service_account', configSchema: {}, capabilities: ['read','write'], icon: 'google_drive' },
  { slug: 'google_sheets', name: 'Google Sheets', description: 'Read and write shared sheets', category: 'spreadsheets', scope: 'organizational', authMethod: 'service_account', configSchema: {}, capabilities: ['read','write'], icon: 'google_sheets' },
  { slug: 'salesforce', name: 'Salesforce', description: 'Leads, opportunities, accounts', category: 'crm', scope: 'organizational', authMethod: 'oauth2', configSchema: {}, capabilities: ['read','write'], icon: 'salesforce' },
  { slug: 'hubspot', name: 'HubSpot', description: 'Contacts, deals, companies, tickets', category: 'crm', scope: 'organizational', authMethod: 'api_key', configSchema: {}, capabilities: ['read','write'], icon: 'hubspot' },
  { slug: 'jira', name: 'Jira', description: 'Issues, sprints, boards, backlogs', category: 'project_mgmt', scope: 'organizational', authMethod: 'api_key', configSchema: {}, capabilities: ['read','write'], icon: 'jira' },
  { slug: 'notion_org', name: 'Notion (Org)', description: 'Organization Notion workspace', category: 'project_mgmt', scope: 'organizational', authMethod: 'api_key', configSchema: {}, capabilities: ['read','write'], icon: 'notion' },
  { slug: 'zendesk', name: 'Zendesk', description: 'Support tickets and satisfaction', category: 'support', scope: 'organizational', authMethod: 'api_key', configSchema: {}, capabilities: ['read'], icon: 'zendesk' },
  { slug: 'github', name: 'GitHub', description: 'Repos, issues, PRs, deployments', category: 'dev', scope: 'organizational', authMethod: 'oauth2', configSchema: {}, capabilities: ['read'], icon: 'github' },
  { slug: 'vertex_ai', name: 'Vertex AI / Known', description: 'Org-wide email intelligence', category: 'intelligence', scope: 'organizational', authMethod: 'service_account', configSchema: {}, capabilities: ['read'], icon: 'vertex_ai' },
  { slug: 'ess_hr', name: 'HR / ESS System', description: 'Appraisals, leave, attendance, payroll', category: 'hr', scope: 'organizational', authMethod: 'api_key', configSchema: {}, capabilities: ['read','write'], icon: 'hr' },
];

async function seed() {
  let created = 0;
  for (const c of connectors) {
    const exists = await prisma.connectorType.findUnique({ where: { slug: c.slug } });
    if (!exists) {
      await prisma.connectorType.create({ data: c });
      created++;
    }
  }
  console.log('Created', created, 'connector types');

  // Enable all personal connectors for TMC-0001
  const personal = await prisma.connectorType.findMany({ where: { scope: 'personal' } });
  for (const p of personal) {
    await prisma.tenantConnectorConfig.upsert({
      where: { clientNumber_connectorTypeId: { clientNumber: 'TMC-0001', connectorTypeId: p.id } },
      create: { clientNumber: 'TMC-0001', connectorTypeId: p.id, scope: 'personal', isEnabled: true },
      update: { isEnabled: true },
    });
  }
  console.log('Enabled', personal.length, 'personal connectors for TMC-0001');
  await prisma.$disconnect();
}

seed().catch(e => { console.error(e); process.exit(1); });
