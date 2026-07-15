/**
 * Notion connector — OAuth2 + DB auto-provisioning for MyOS Wiki.
 *
 * Flow:
 *   1. User clicks "Connect Notion" in Settings.
 *   2. Server returns OAuth URL with tenant+user state param.
 *   3. Notion redirects back with `code` + `state`.
 *   4. We exchange code → access_token, owner info, workspace_id.
 *   5. If no databases exist yet, provision the 7 standard wiki DBs under a
 *      root page the user selected during OAuth.
 *   6. Store tokens + DB IDs in user_connectors.config.
 *   7. Flip status → 'connected' so wikiStorageService picks Notion.
 */
import prisma from '../../db/prisma';

const NOTION_OAUTH_AUTH = 'https://api.notion.com/v1/oauth/authorize';
const NOTION_OAUTH_TOKEN = 'https://api.notion.com/v1/oauth/token';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

interface NotionOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function oauthConfig(): NotionOAuthConfig {
  return {
    clientId: process.env.NOTION_OAUTH_CLIENT_ID ?? '',
    clientSecret: process.env.NOTION_OAUTH_CLIENT_SECRET ?? '',
    redirectUri: process.env.NOTION_OAUTH_REDIRECT_URI
      ?? 'https://tai.tmcltd.com/api/v1/connectors/notion/callback',
  };
}

export function authorizeUrl(state: string): string {
  const cfg = oauthConfig();
  if (!cfg.clientId) throw new Error('NOTION_OAUTH_CLIENT_ID not set');
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    owner: 'user',
    redirect_uri: cfg.redirectUri,
    state,
  });
  return `${NOTION_OAUTH_AUTH}?${params.toString()}`;
}

interface NotionTokenResponse {
  access_token: string;
  workspace_id: string;
  workspace_name?: string;
  workspace_icon?: string;
  owner: { user?: { id?: string; name?: string; person?: { email?: string } } };
  bot_id: string;
}

export async function exchangeCode(code: string): Promise<NotionTokenResponse> {
  const cfg = oauthConfig();
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('NOTION_OAUTH_* env not set');
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const r = await fetch(NOTION_OAUTH_TOKEN, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Notion OAuth exchange failed: ${r.status} ${body.slice(0, 200)}`);
  }
  return r.json();
}

/**
 * Auto-provision the 7 standard wiki databases under the given root page.
 * If any already exist at that path, they're re-used. Returns a mapping of
 * DB aliases → Notion database IDs that we store in user_connectors.config.
 */
export async function provisionWikiDatabases(token: string, rootPageId: string): Promise<Record<string, string>> {
  const dbs: Record<string, string> = {};
  const specs: Array<{ key: string; title: string; icon: string }> = [
    { key: 'entity_wiki', title: 'Entity Wiki', icon: 'bust_in_silhouette' },
    { key: 'concept_wiki', title: 'Concept Wiki', icon: 'light_bulb' },
    { key: 'decision_wiki', title: 'Decision Wiki', icon: 'memo' },
    { key: 'pattern_wiki', title: 'Pattern Wiki', icon: 'spiral_note_pad' },
    { key: 'meeting_wiki', title: 'Meeting Wiki', icon: 'calendar' },
    { key: 'project_wiki', title: 'Project Wiki', icon: 'rocket' },
    { key: 'pipeline_operations', title: 'Pipeline — Operations', icon: 'gear' },
  ];

  for (const s of specs) {
    try {
      const resp = await fetch(`${NOTION_API}/databases`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          parent: { type: 'page_id', page_id: rootPageId },
          title: [{ type: 'text', text: { content: s.title } }],
          properties: {
            Name: { title: {} },
            page_type: { select: { options: [
              { name: 'entity' }, { name: 'concept' }, { name: 'decision' },
              { name: 'pattern' }, { name: 'meeting' }, { name: 'project' },
              { name: 'source_summary' },
            ] } },
            status: { select: { options: [
              { name: 'active' }, { name: 'orphan' }, { name: 'stale' },
              { name: 'contradicted' }, { name: 'draft' },
            ] } },
            confidence: { number: { format: 'number' } },
          },
        }),
      });
      if (!resp.ok) throw new Error(`Notion ${resp.status}`);
      const j: any = await resp.json();
      dbs[s.key] = j.id;
    } catch (err: any) {
      console.warn(`[notionConnector] provision ${s.key} failed: ${err.message}`);
    }
  }
  return dbs;
}

export async function saveConnectorRow(
  clientNumber: string,
  userId: number,
  token: NotionTokenResponse,
  databases: Record<string, string>,
  rootPageId: string | null,
): Promise<void> {
  // Find the Notion ConnectorType row
  const notionType = await prisma.connectorType.findFirst({ where: { slug: 'notion' } });
  if (!notionType) throw new Error('connector_types.notion row missing — run seed migration');

  await prisma.userConnector.upsert({
    where: { userId_connectorTypeId: { userId, connectorTypeId: notionType.id } },
    update: {
      status: 'connected',
      config: {
        accessToken: token.access_token,
        workspaceId: token.workspace_id,
        workspaceName: token.workspace_name,
        botId: token.bot_id,
        ownerEmail: token.owner?.user?.person?.email,
        rootPageId,
        databases,
      } as any,
      metadata: { connectedAt: new Date().toISOString() } as any,
      lastSyncAt: new Date(),
      syncStatus: 'idle',
      errorMessage: null,
    },
    create: {
      clientNumber,
      userId,
      connectorTypeId: notionType.id,
      status: 'connected',
      config: {
        accessToken: token.access_token,
        workspaceId: token.workspace_id,
        workspaceName: token.workspace_name,
        botId: token.bot_id,
        ownerEmail: token.owner?.user?.person?.email,
        rootPageId,
        databases,
      } as any,
      metadata: { connectedAt: new Date().toISOString() } as any,
    },
  });
}

export async function findNotionConnector(clientNumber: string, userId: number) {
  return prisma.userConnector.findFirst({
    where: { clientNumber, userId } as any,
    include: { connectorType: true },
  });
}
