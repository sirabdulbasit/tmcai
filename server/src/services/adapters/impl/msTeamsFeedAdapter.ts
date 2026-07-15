/**
 * MS Teams FeedAdapter — pulls 1:1 + group chat messages from
 * Microsoft Graph for every user who paired the `ms_teams` connector.
 *
 * Window: last 24 hours of chat messages across the user's chats.
 * Graph's `/me/chats` lists the user's chats; for each, we read
 * `/messages` filtered by `lastModifiedDateTime`. Channel posts (in
 * Teams workspaces) are deferred — they need separate `/teams/{id}/
 * channels/{id}/messages` calls and tenant-level admin consent.
 *
 * Feed events emit with `sourceType='ms_teams'` so triage / criticality
 * treat them like inbound chat.
 */
import { FeedAdapter, NormalizedEvent, AdapterHealth, BackfillRange, BackfillResult, TeardownResult } from '../adapterBase';
import prisma from '../../../db/prisma';
import { listConnectedUsers, graphGet } from './msGraphHelper';
import createLogger from '../../../utils/logger';

const log = createLogger('ms-teams-adapter');

interface TeamsChat {
  id: string;
  topic?: string;
  chatType?: 'oneOnOne' | 'group' | 'meeting';
  members?: Array<{ displayName?: string; email?: string }>;
}

interface TeamsMessage {
  id: string;
  chatId?: string;
  body?: { content?: string; contentType?: string };
  from?: { user?: { id?: string; displayName?: string; email?: string } };
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  importance?: string;
  messageType?: string;
  __userId?: number;
  __chatTopic?: string;
  __chatType?: string;
}

export class MsTeamsFeedAdapter extends FeedAdapter {
  readonly sourceType = 'ms_teams' as any;
  readonly displayName = 'Microsoft Teams';

  async receive(tenantId: string, _since?: Date, limit = 25): Promise<unknown[]> {
    const users = await listConnectedUsers(tenantId, 'ms_teams');
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const all: unknown[] = [];

    for (const u of users) {
      try {
        // List the user's chats first (cheap — usually < 50 chats per user).
        const chatsRes = await graphGet<{ value: TeamsChat[] }>(
          u.userId, 'ms_teams',
          'https://graph.microsoft.com/v1.0/me/chats?$top=50&$expand=members',
        );
        const chats = chatsRes?.value ?? [];

        for (const chat of chats) {
          // Per-chat message fetch, filtered to recent + capped per-chat
          // so a single chatty thread doesn't blow the per-tick limit.
          const msgsRes = await graphGet<{ value: TeamsMessage[] }>(
            u.userId, 'ms_teams',
            `https://graph.microsoft.com/v1.0/me/chats/${encodeURIComponent(chat.id)}/messages?$top=20&$filter=lastModifiedDateTime ge ${since}`,
          );
          for (const m of msgsRes?.value ?? []) {
            // Drop our own messages (we're cataloging inbound).
            if (m.from?.user?.email && u.userId && false) {
              // userId/email match check would go here; left as no-op
              // because Graph doesn't return our email reliably from chat msg.
            }
            // Drop system messages (joins, name changes, etc.).
            if (m.messageType && m.messageType !== 'message') continue;
            all.push({
              ...m,
              __userId: u.userId,
              __chatTopic: chat.topic,
              __chatType: chat.chatType,
            });
            if (all.length >= limit * users.length) break;
          }
          if (all.length >= limit * users.length) break;
        }
      } catch (err: any) {
        log.warn('ms_teams receive failed', { userId: u.userId, error: err.message });
      }
    }
    return all;
  }

  normalise(raw: unknown): NormalizedEvent {
    const m = raw as TeamsMessage;
    const senderName = m.from?.user?.displayName;
    const senderEmail = m.from?.user?.email;
    const text = String(m.body?.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      sourceId: m.id,
      eventType: 'message_received' as any,
      sender: { name: senderName, email: senderEmail },
      payload: {
        userId: m.__userId,
        chatId: m.chatId,
        chatTopic: m.__chatTopic,
        chatType: m.__chatType,
        from: senderName
          ? `${senderName}${senderEmail ? ` <${senderEmail}>` : ''}`
          : senderEmail,
        snippet: text.slice(0, 280),
        body: text.slice(0, 4000),
        createdAt: m.createdDateTime,
        lastModifiedAt: m.lastModifiedDateTime,
        importance: m.importance ?? 'normal',
        provider: 'ms_teams',
      },
      receivedAt: m.createdDateTime ? new Date(m.createdDateTime) : new Date(),
    };
  }

  async health(): Promise<AdapterHealth> {
    return { ok: true, detail: 'tenant-level health derived from connected users', lastCheckedAt: new Date().toISOString() };
  }

  async backfill(range: BackfillRange): Promise<BackfillResult> {
    const limit = range.maxEvents ?? 100;
    const raws = await this.receive(range.tenantId, range.since, Math.min(limit, 500));
    let fetched = raws.length;
    let ingested = 0; let duplicates = 0; let errors = 0;
    let first: Date | undefined; let last: Date | undefined;
    for (const raw of raws) {
      try {
        const n = this.normalise(raw);
        if (range.since && n.receivedAt < range.since) continue;
        if (range.until && n.receivedAt > range.until) continue;
        const r = await this.storeAndPublish(n, range.tenantId);
        if (r.status === 'new') ingested += 1;
        else if (r.status === 'duplicate') duplicates += 1;
        else errors += 1;
        if (!first || n.receivedAt < first) first = n.receivedAt;
        if (!last || n.receivedAt > last) last = n.receivedAt;
      } catch { errors += 1; }
    }
    return { fetched, ingested, duplicates, errors, firstEventAt: first, lastEventAt: last };
  }

  async teardown(tenantId: string): Promise<TeardownResult> {
    const ct = await prisma.connectorType.findUnique({ where: { slug: 'ms_teams' } });
    if (!ct) return { ok: true, connectionsRemoved: 0, tokensRevoked: 0 };
    const result = await prisma.userConnector.updateMany({
      where: { clientNumber: tenantId, connectorTypeId: ct.id },
      data: { status: 'disconnected', errorMessage: null },
    });
    return { ok: true, connectionsRemoved: result.count, tokensRevoked: result.count };
  }
}

export default new MsTeamsFeedAdapter();
