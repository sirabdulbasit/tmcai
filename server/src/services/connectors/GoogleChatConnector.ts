import { google, chat_v1 } from 'googleapis';
import prisma from '../../db/prisma';
import { getConfig } from '../configService';

/**
 * HaseebOS v15 INT-2 — Google Chat connector.
 *
 * Per-tenant OAuth credentials (or service account) stored in SystemConfig:
 *   gchat_service_account_json  (preferred for bot-mode dispatch)
 *   gchat_app_scope              (default: https://www.googleapis.com/auth/chat.bot)
 *
 * The bot posts replies into spaces/DMs where it's been invited. For inbound
 * events, spec requires a webhook listener — wired via routes/webhookRoutes.
 */

async function authClient(clientNumber: string): Promise<chat_v1.Chat> {
  const saJson = await getConfig(clientNumber, 'gchat_service_account_json');
  const scope = (await getConfig(clientNumber, 'gchat_app_scope')) ?? 'https://www.googleapis.com/auth/chat.bot';
  if (!saJson) {
    throw new Error('Google Chat connector not configured — set gchat_service_account_json in tenant config');
  }
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(saJson);
  } catch {
    throw new Error('gchat_service_account_json is not valid JSON');
  }
  const auth = new google.auth.GoogleAuth({ credentials: credentials as any, scopes: [scope] });
  const authClient = await auth.getClient();
  return google.chat({ version: 'v1', auth: authClient as any });
}

export interface SendMessageInput {
  /** Space resource name, e.g. "spaces/AAAAAAAAAAA" — or DM space */
  space: string;
  text: string;
  /** If replying into a thread, include the thread name */
  threadName?: string;
}

export async function sendMessage(clientNumber: string, input: SendMessageInput): Promise<string> {
  const chat = await authClient(clientNumber);
  const res = await chat.spaces.messages.create({
    parent: input.space,
    requestBody: {
      text: input.text,
      ...(input.threadName ? { thread: { name: input.threadName } } : {}),
    },
    messageReplyOption: input.threadName ? 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' : undefined,
  });
  if (!res.data.name) throw new Error('Google Chat create message returned no resource name');
  return res.data.name;
}

export async function getSpaceInfo(clientNumber: string, space: string) {
  const chat = await authClient(clientNumber);
  const res = await chat.spaces.get({ name: space });
  return res.data;
}

export async function healthCheck(clientNumber: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await authClient(clientNumber);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Called from the Google Chat webhook route on inbound events (@mentions + DMs).
 * Dedupes via feedIngestionService and publishes to feed.raw for the Feed Curator.
 */
export async function handleInboundEvent(payload: Record<string, unknown>): Promise<void> {
  // Identify tenant from space.type + configured mapping
  const spaceName = (payload as any)?.space?.name as string | undefined;
  if (!spaceName) return;

  // Find which tenant this space belongs to via SystemConfig search
  const configs = await prisma.systemConfig.findMany({
    where: { key: 'gchat_space_bindings' },
  });
  let clientNumber: string | null = null;
  for (const c of configs) {
    try {
      const bindings = JSON.parse(c.value) as Record<string, string[]>;
      for (const [tenant, spaces] of Object.entries(bindings)) {
        if (Array.isArray(spaces) && spaces.includes(spaceName)) {
          clientNumber = tenant;
          break;
        }
      }
    } catch {
      /* skip malformed config */
    }
    if (clientNumber) break;
  }
  if (!clientNumber) {
    console.warn(`[gchat] inbound from unbound space ${spaceName} — dropping`);
    return;
  }

  const messageName = (payload as any)?.message?.name as string | undefined;
  const text = (payload as any)?.message?.text as string | undefined;
  if (!messageName || !text) return;

  try {
    const { ingest } = await import('../feed/feedIngestionService');
    await ingest({
      clientNumber,
      sourceType: 'gchat',
      sourceId: messageName,
      payload: {
        space: spaceName,
        threadName: (payload as any)?.message?.thread?.name,
        text,
        sender: (payload as any)?.message?.sender,
      },
    });
  } catch (err: any) {
    console.warn(`[gchat] feed ingestion failed: ${err.message}`);
  }
}
