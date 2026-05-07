/**
 * MyOS — Google Chat polling bridge (personal OAuth, not the bot
 * connector). Reads each user's recent messages across the spaces they
 * can access and writes to feed_events with sourceType='gchat'.
 *
 * Cadence: 20 min by default. Chat is more chatty than tasks but less
 * urgent than email — 20 min keeps API quota bounded while still
 * catching the day's threads.
 *
 * Fails open per-user: if Google rejects the call (no permission, dead
 * token, scope not granted), this user is skipped and the next user
 * processes normally. Same pattern as gtasksFeedPoller.
 */
import prisma from '../db/prisma';
import { getAllRecentMessages } from '../services/googleChatPersonalService';
import { ingest } from '../services/feed/feedIngestionService';
import { stampConnectorSync } from '../services/connectorSyncTracker';

export interface GchatPollResult {
  userId: number;
  clientNumber: string;
  fetched: number;
  ingested: number;
  duplicates: number;
  errors: number;
}

const LOOKBACK_HOURS = 24;

export async function pollAllActiveChatUsers(): Promise<GchatPollResult[]> {
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      integrationProvider: 'google',
      integrationStatus: 'active',
    },
    select: { id: true, clientNumber: true },
  });

  const results: GchatPollResult[] = [];
  for (const u of users) {
    try {
      const r = await pollUser(u.id, u.clientNumber);
      results.push(r);
    } catch (err: any) {
      console.warn(`[gchatPoll] user=${u.id} failed: ${err.message}`);
      results.push({ userId: u.id, clientNumber: u.clientNumber, fetched: 0, ingested: 0, duplicates: 0, errors: 1 });
    }
  }
  return results;
}

async function pollUser(userId: number, clientNumber: string): Promise<GchatPollResult> {
  const messages = await getAllRecentMessages(userId, LOOKBACK_HOURS).catch(() => [] as any[]);

  let ingested = 0, duplicates = 0, errors = 0;

  for (const m of messages) {
    if (!m.name) continue;  // Google Chat message resource name uniquely IDs a message
    try {
      const senderEmail = m.sender?.name ? null : null;  // sender.name is "users/{id}", not email
      const senderDisplay = m.sender?.displayName ?? m.sender?.name ?? 'Unknown';
      const r = await ingest({
        clientNumber,
        userId,
        sourceType: 'gchat',
        sourceId: m.name,
        sender: { email: senderEmail ?? undefined, name: senderDisplay },
        eventType: 'message_received',
        payload: {
          userId,
          messageName: m.name,
          spaceName: m.spaceName,
          spaceDisplayName: m.spaceDisplayName,
          spaceType: m.spaceType,
          threadName: m.thread?.name ?? null,
          createTime: m.createTime ?? null,
          updatedTime: m.lastUpdateTime ?? m.createTime ?? null,
          senderName: m.sender?.name ?? null,
          senderDisplayName: senderDisplay,
          text: m.text ?? '',
          formattedText: m.formattedText ?? null,
          // Fall back to text for snippet so the triage classifier has
          // something to work with.
          snippet: String(m.text ?? '').slice(0, 200),
          subject: m.spaceDisplayName ?? '(chat)',
          link: null,
        },
      });
      if (r.status === 'new') ingested += 1;
      else if (r.status === 'duplicate') duplicates += 1;
      else errors += 1;
    } catch (err: any) {
      errors += 1;
      console.warn(`[gchatPoll] ingest failed user=${userId} msg=${m.name}: ${err.message}`);
    }
  }

  await stampConnectorSync(userId, ['google_chat']);
  return { userId, clientNumber, fetched: messages.length, ingested, duplicates, errors };
}
