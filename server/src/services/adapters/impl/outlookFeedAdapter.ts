/**
 * Outlook FeedAdapter — reads inbox via Microsoft Graph for any user
 * who has connected the `outlook` connector. Mirrors `gmailFeedAdapter`
 * shape so triage / scribe / criticality treat both channels the same.
 *
 * Token resolution: per-user OAuth tokens live in `user_connectors.config`
 * (envelope-encrypted) under the `outlook` connector type. We refresh
 * with the saved `refreshToken` if the access token has expired.
 *
 * Conservative scope (v1):
 *   - Reads `/me/messages` from inbox folder, last 30d
 *   - No body fetch unless the sender is on the VIP list (matches the
 *     gmail adapter's enrich pattern — saves API calls + token quota)
 *   - Backfill via the same `/me/messages?$filter=receivedDateTime ge ...`
 *
 * Future: subscriptions (Graph webhooks) for real-time push, currently
 * we poll on the same cadence as Gmail (every ~30s via genericFeedPoller).
 */
import { FeedAdapter, NormalizedEvent, AdapterHealth, BackfillRange, BackfillResult, TeardownResult } from '../adapterBase';
import prisma from '../../../db/prisma';
import createLogger from '../../../utils/logger';

const log = createLogger('outlook-adapter');

interface OutlookMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  receivedDateTime?: string;
  hasAttachments?: boolean;
  importance?: string;
  __userId?: number;
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export class OutlookFeedAdapter extends FeedAdapter {
  readonly sourceType = 'outlook' as const;
  readonly displayName = 'Outlook';

  async receive(tenantId: string, since?: Date, limit = 25): Promise<unknown[]> {
    // Find every user in this tenant who has the outlook connector
    // wired AND status='connected'. We pull their access token from
    // user_connectors.config.
    const users = await this.connectedUsers(tenantId);
    const all: unknown[] = [];
    for (const u of users) {
      try {
        const token = await this.ensureFreshToken(u.userId);
        if (!token) continue;
        const filter = since ? `&$filter=receivedDateTime ge ${since.toISOString()}` : '';
        const res = await fetch(
          `${GRAPH_BASE}/me/mailFolders/Inbox/messages?$top=${Math.min(limit, 50)}&$select=id,conversationId,subject,bodyPreview,from,toRecipients,receivedDateTime,hasAttachments,importance${filter}&$orderby=receivedDateTime desc`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) {
          log.warn('graph fetch failed', { userId: u.userId, status: res.status });
          continue;
        }
        const j: any = await res.json();
        for (const m of (j.value ?? []) as OutlookMessage[]) {
          all.push({ ...m, __userId: u.userId });
        }
      } catch (err: any) {
        log.warn('outlook receive failed', { userId: u.userId, error: err.message });
      }
    }
    return all;
  }

  normalise(raw: unknown): NormalizedEvent {
    const m = raw as OutlookMessage;
    return {
      sourceId: m.id,
      eventType: m.conversationId ? 'thread_updated' : 'message_received',
      sender: {
        email: m.from?.emailAddress?.address,
        name: m.from?.emailAddress?.name,
      },
      payload: {
        userId: m.__userId,
        threadId: m.conversationId,
        subject: m.subject,
        from: m.from?.emailAddress?.name
          ? `${m.from.emailAddress.name} <${m.from.emailAddress.address}>`
          : m.from?.emailAddress?.address,
        fromName: m.from?.emailAddress?.name,
        to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address).filter(Boolean).join(', '),
        snippet: m.bodyPreview,
        date: m.receivedDateTime,
        hasAttachments: !!m.hasAttachments,
        importance: m.importance ?? 'normal',
      },
      receivedAt: m.receivedDateTime ? new Date(m.receivedDateTime) : new Date(),
    };
  }

  async enrich(event: NormalizedEvent, tenantId: string): Promise<NormalizedEvent> {
    // Same VIP-only body fetch policy as Gmail adapter.
    const senderEmail = event.sender?.email;
    if (!senderEmail) return event;
    const vipList = await prisma.systemConfig.findUnique({
      where: { clientNumber_key: { clientNumber: tenantId, key: 'risk_vip_emails' } },
    });
    if (!vipList?.value) return event;
    const vipEmails = vipList.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!vipEmails.includes(senderEmail.toLowerCase())) return event;
    const userId = (event.payload.userId as number | undefined) ?? 0;
    if (!userId) return event;
    try {
      const token = await this.ensureFreshToken(userId);
      if (!token) return event;
      const res = await fetch(
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(event.sourceId)}?$select=body`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return event;
      const j: any = await res.json();
      const body = j.body?.content
        ? String(j.body.content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000)
        : '';
      return { ...event, payload: { ...event.payload, body, vip: true } };
    } catch {
      return event;
    }
  }

  async health(): Promise<AdapterHealth> {
    return {
      ok: true,
      detail: 'tenant-level health derived from connected users',
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async backfill(range: BackfillRange): Promise<BackfillResult> {
    const limit = range.maxEvents ?? 100;
    const raws = await this.receive(range.tenantId, range.since, Math.min(limit, 500));
    let fetched = raws.length;
    let ingested = 0;
    let duplicates = 0;
    let errors = 0;
    let first: Date | undefined;
    let last: Date | undefined;

    for (const raw of raws) {
      try {
        const normalised = this.normalise(raw);
        if (range.since && normalised.receivedAt < range.since) continue;
        if (range.until && normalised.receivedAt > range.until) continue;
        const result = await this.storeAndPublish(normalised, range.tenantId);
        if (result.status === 'new') ingested += 1;
        else if (result.status === 'duplicate') duplicates += 1;
        else errors += 1;
        if (!first || normalised.receivedAt < first) first = normalised.receivedAt;
        if (!last || normalised.receivedAt > last) last = normalised.receivedAt;
      } catch {
        errors += 1;
      }
    }
    return { fetched, ingested, duplicates, errors, firstEventAt: first, lastEventAt: last };
  }

  async teardown(tenantId: string): Promise<TeardownResult> {
    // Disconnect every outlook user_connector in this tenant. We do
    // NOT delete the row — we flip status so the user can reconnect
    // later, and we null out tokens so we never accidentally try to
    // call Graph with a stale token.
    const ct = await prisma.connectorType.findUnique({ where: { slug: 'outlook' } });
    if (!ct) return { ok: true, connectionsRemoved: 0, tokensRevoked: 0 };
    const result = await prisma.userConnector.updateMany({
      where: { clientNumber: tenantId, connectorTypeId: ct.id },
      data: { status: 'disconnected', errorMessage: null },
    });
    return { ok: true, connectionsRemoved: result.count, tokensRevoked: result.count };
  }

  // ─── internals ───────────────────────────────────────────────

  private async connectedUsers(tenantId: string): Promise<Array<{ userId: number }>> {
    const ct = await prisma.connectorType.findUnique({ where: { slug: 'outlook' } });
    if (!ct) return [];
    const rows = await prisma.userConnector.findMany({
      where: {
        clientNumber: tenantId,
        connectorTypeId: ct.id,
        status: 'connected',
      },
      select: { userId: true },
    });
    return rows;
  }

  /** Returns a valid access token for this user, refreshing if expired.
   *  Reads + writes user_connectors.config. Returns null if the user
   *  isn't connected or refresh fails (so caller skips them gracefully). */
  private async ensureFreshToken(userId: number): Promise<string | null> {
    const ct = await prisma.connectorType.findUnique({ where: { slug: 'outlook' } });
    if (!ct) return null;
    const uc = await prisma.userConnector.findUnique({
      where: { userId_connectorTypeId: { userId, connectorTypeId: ct.id } },
    });
    if (!uc || uc.status !== 'connected' || !uc.config) return null;

    const { decryptConnectorConfig, encryptConnectorConfig } = await import('../../connectorService');
    const cfg = await decryptConnectorConfig(uc.config as Record<string, unknown>);
    const accessToken = cfg.accessToken as string | undefined;
    const refreshToken = cfg.refreshToken as string | undefined;
    const expiryIso = cfg.tokenExpiry as string | undefined;
    const clientId = cfg.clientId as string | undefined;
    const clientSecret = cfg.clientSecret as string | undefined;

    const isExpired = !expiryIso || Date.now() > Date.parse(expiryIso) - 60_000;
    if (!isExpired && accessToken) return accessToken;
    if (!refreshToken || !clientId || !clientSecret) return accessToken ?? null;

    // Refresh
    try {
      const tokRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      });
      if (!tokRes.ok) {
        log.warn('outlook token refresh failed', { userId, status: tokRes.status });
        return accessToken ?? null;
      }
      const j: any = await tokRes.json();
      if (!j.access_token) return accessToken ?? null;
      const newExpiry = j.expires_in
        ? new Date(Date.now() + Number(j.expires_in) * 1000).toISOString()
        : '';
      const updated = {
        ...cfg,
        accessToken: j.access_token,
        refreshToken: j.refresh_token || refreshToken,
        tokenExpiry: newExpiry,
      };
      const enc = await encryptConnectorConfig(updated);
      await prisma.userConnector.update({
        where: { userId_connectorTypeId: { userId, connectorTypeId: ct.id } },
        data: { config: enc as any },
      });
      return j.access_token;
    } catch (err: any) {
      log.warn('outlook token refresh threw', { userId, error: err.message });
      return accessToken ?? null;
    }
  }
}

export default new OutlookFeedAdapter();
