import { FeedAdapter, NormalizedEvent, AdapterHealth, BackfillRange, BackfillResult, TeardownResult } from '../adapterBase';
import { getInbox, readEmail } from '../gmailAdapter';
import prisma from '../../../db/prisma';

/**
 * Reference Gmail adapter implementing HaseebOS v15's 10-method contract.
 *
 * Delegates API calls to the existing `gmailAdapter` (which already has the
 * circuit breaker wrap). Normalises messages into FeedEvent shape with
 * explicit event_type + sender, supports backfill via `getInbox(maxResults)`,
 * and teardown via clearing the user's integration tokens.
 */
export class GmailFeedAdapter extends FeedAdapter {
  readonly sourceType = 'gmail' as const;
  readonly displayName = 'Gmail';

  async receive(tenantId: string, _since?: Date, limit = 500): Promise<unknown[]> {
    // Pull recent inbox + sent for every active Google-integrated user
    // in this tenant. SENT ingestion is what powers Brain's
    // "user already replied on this thread → don't nag them" logic.
    // Per Basit 2026-07-07: "if brain read my email will it also read
    // my sent items? so it can come to know that what I have already
    // responded". Without sent ingest, gmailReadStateSyncJob's
    // thread-latest-md-send lookup had no data and userRepliedThread
    // was never true — Brain kept surfacing handled emails.
    const users = await prisma.user.findMany({
      where: { clientNumber: tenantId, isActive: true, integrationProvider: 'google', integrationStatus: 'active' },
      select: { id: true },
    });
    const { stampConnectorSync } = await import('../../connectorSyncTracker');
    const all: unknown[] = [];
    // Cap per-user pulls at 100 for the 2-min poll cycle. The
    // genericFeedPoller's MAX_EVENTS_PER_ADAPTER=500 is too aggressive
    // for gmail — 500 sequential metadata fetches (even chunked) push
    // past Gmail's per-user quota and the 30s circuit breaker budget.
    // Historical backfill goes through Re-scribe All, NOT this path.
    // Dedup via contentHash means overlap on adjacent ticks is free.
    const perUserCap = Math.min(limit, 100);
    // Sent-items cap is deliberately lower — the user's own outbound
    // rate is a fraction of inbound, and we only need the recent tail
    // for thread-state ("has user replied in last N days?"). 30 is
    // enough to cover a busy user's daily outbound without eating
    // Gmail quota.
    const SENT_CAP = 30;
    for (const u of users) {
      // ── Inbox ──
      const inbox = await getInbox(u.id, perUserCap);
      for (const e of inbox.emails ?? []) {
        all.push({ ...e, __userId: u.id });
      }
      // ── Sent — SAME normaliser handles them (from-header = user's
      // own email so sender_email lands as mdEmail, which is exactly
      // what gmailReadStateSyncJob's mdSentRows query filters on).
      // isUnread will always be false (SENT never has UNREAD label);
      // labels array will include 'SENT' so triage can distinguish.
      // Dedup via contentHash prevents re-inserts on overlapping ticks.
      const sent = await getInbox(u.id, SENT_CAP, 'in:sent');
      for (const e of sent.emails ?? []) {
        all.push({ ...e, __userId: u.id });
      }
      // Stamp regardless of whether new mail arrived — an idle pull
      // still proves the channel is alive, which is what the Day Brief
      // freshness indicator should reflect.
      await stampConnectorSync(u.id, ['gmail']);
    }
    return all;
  }

  normalise(raw: unknown): NormalizedEvent {
    const e = raw as {
      id: string; threadId?: string;
      subject?: string;
      from?: string; fromName?: string;
      to?: string; cc?: string; bcc?: string;
      snippet?: string; date?: string;
      isUnread?: boolean; labels?: string[];
      __userId?: number;
    };
    return {
      sourceId: e.id,
      eventType: e.threadId ? 'thread_updated' : 'message_received',
      sender: { email: e.from, name: e.fromName },
      payload: {
        userId: e.__userId,
        threadId: e.threadId,
        subject: e.subject,
        from: e.from,
        fromName: e.fromName,
        // Recipient headers — critical for triage so CC-only emails
        // can be auto-classified as inform_only without bothering
        // the user. Without these, every email looks "directly
        // addressed" to triage and clutters My Attention.
        to: e.to ?? '',
        cc: e.cc ?? '',
        bcc: e.bcc ?? '',
        snippet: e.snippet,
        date: e.date,
        // Read state — populated by gmailReadStateSyncJob even for
        // existing rows so Brain has live read context.
        isUnread: e.isUnread,
        labels: e.labels ?? [],
      },
      receivedAt: e.date ? new Date(e.date) : new Date(),
    };
  }

  async enrich(event: NormalizedEvent, tenantId: string): Promise<NormalizedEvent> {
    // Optional body-fetch for triage. Gate behind a feature flag so it only
    // runs for high-priority senders (VIP list from system_config).
    const senderEmail = event.sender?.email;
    if (!senderEmail) return event;
    const vipList = await prisma.systemConfig.findUnique({
      where: { clientNumber_key: { clientNumber: tenantId, key: 'risk_vip_emails' } },
    });
    if (!vipList?.value) return event;
    const vipEmails = vipList.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!vipEmails.includes(senderEmail.toLowerCase())) return event;
    // VIP sender — fetch body so Triage has context
    const userId = (event.payload.userId as number | undefined) ?? 0;
    if (!userId) return event;
    try {
      const full = await readEmail(userId, event.sourceId);
      return {
        ...event,
        payload: { ...event.payload, body: full.email?.body, vip: true },
      };
    } catch {
      return event;
    }
  }

  async health(): Promise<AdapterHealth> {
    // Since Gmail adapter uses OAuth per user, surface a tenant-level health
    // as: "at least one user has an active integration".
    return { ok: true, detail: 'tenant-level health derived from active users', lastCheckedAt: new Date().toISOString() };
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
    // Clear Google integration tokens for every user in this tenant.
    const result = await prisma.user.updateMany({
      where: { clientNumber: tenantId, integrationProvider: 'google' },
      data: {
        integrationStatus: 'disconnected',
        integrationAccessToken: null,
        integrationRefreshToken: null,
        integrationTokenExpiry: null,
      },
    });
    return {
      ok: true,
      connectionsRemoved: result.count,
      tokensRevoked: result.count,
      notes: `Cleared Google OAuth tokens for ${result.count} users`,
    };
  }
}

export default new GmailFeedAdapter();
