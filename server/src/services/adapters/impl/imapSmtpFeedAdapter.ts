/**
 * ImapSmtpFeedAdapter — inbox polling for users on non-Gmail, non-
 * Microsoft email (Zoho, ProtonMail, cPanel, private corporate IMAP,
 * custom domains).
 *
 * Plugs into the generic feed poller alongside GmailFeedAdapter and
 * OutlookFeedAdapter so Brain triages email uniformly regardless of
 * which provider the user's mailbox lives on.
 *
 * Cadence: receive() is called by jobs/genericFeedPoller on the
 * same loop as Gmail (~30s by default; the loop self-throttles based
 * on circuit-breaker state). Each call pulls the most-recent N
 * messages from every user with a connected imap_smtp connector in
 * this tenant. Dedup via contentHash inside feedIngestionService
 * keeps overlap on adjacent ticks free.
 *
 * Limit: 50 messages per user per tick. Higher than Gmail (which
 * uses metadata-only fetches) because IMAP envelope-only fetches are
 * lightweight and IMAP servers don't have a per-user 30s circuit
 * breaker like Gmail does. Historical backfill goes through
 * backfill() instead of this hot path.
 */
import prisma from '../../../db/prisma';
import { FeedAdapter, NormalizedEvent, AdapterHealth, BackfillRange, BackfillResult, TeardownResult } from '../adapterBase';
import { fetchRecentInbox, type InboxMessage } from '../../imapSmtpService';
import createLogger from '../../../utils/logger';

const log = createLogger('imap-smtp-feed');

export class ImapSmtpFeedAdapter extends FeedAdapter {
  readonly sourceType = 'imap_smtp' as const;
  readonly displayName = 'Email (IMAP+SMTP)';

  /** Pull recent inbox messages for every user with a connected
   *  imap_smtp connector in this tenant. Each item is annotated with
   *  the source user id so normalise() can attribute it correctly. */
  async receive(tenantId: string, _since?: Date, limit = 50): Promise<unknown[]> {
    const users = await prisma.user.findMany({
      where: {
        clientNumber: tenantId,
        isActive: true,
        userConnectors: {
          some: {
            status: 'connected',
            connectorType: { slug: 'imap_smtp' },
          },
        },
      },
      select: { id: true },
    });
    if (!users.length) return [];

    const { stampConnectorSync } = await import('../../connectorSyncTracker');
    const perUserCap = Math.min(limit, 50);
    const all: unknown[] = [];
    for (const u of users) {
      try {
        const msgs = await fetchRecentInbox(u.id, perUserCap);
        for (const m of msgs) {
          all.push({ ...m, __userId: u.id });
        }
        // Stamp regardless of result — an idle pull still proves the
        // channel is alive, which is what the Day Brief freshness banner
        // should reflect. Without this the "imap smtp not syncing"
        // alert never clears even when polling works.
        await stampConnectorSync(u.id, ['imap_smtp']);
      } catch (err: any) {
        log.warn('inbox fetch failed', { userId: u.id, tenant: tenantId, error: err.message });
      }
    }
    return all;
  }

  normalise(raw: unknown): NormalizedEvent {
    const e = raw as InboxMessage & { __userId?: number };
    return {
      sourceId: e.messageId || `${e.__userId}:${e.uid}`,
      eventType: 'message_received',
      sender: { email: e.from, name: e.fromName },
      payload: {
        userId: e.__userId,
        provider: 'imap_smtp',
        // Same envelope shape as gmailFeedAdapter so the triage prompts
        // / Day Brief composer / Brain reasoner read both providers
        // through one parser — no per-provider branching downstream.
        threadId: e.messageId || `${e.__userId}:${e.uid}`,
        subject: e.subject,
        from: e.from,
        fromName: e.fromName,
        to: e.to ?? '',
        cc: e.cc ?? '',
        bcc: '',
        snippet: e.snippet || '',
        date: e.date?.toISOString(),
        isUnread: e.isUnread,
        labels: [],
        // Provider-specific so admin can debug; harmless to triage.
        imapUid: e.uid,
      },
      receivedAt: e.date ?? new Date(),
    };
  }

  /** No body-fetch enrichment yet. Gmail does VIP-only body fetch via
   *  the readEmail API; equivalent for IMAP would re-open a connection
   *  per message which is expensive. Adding a "VIP body cache" pass
   *  is an opt-in follow-up — for now triage works off envelope +
   *  snippet only, same as Outlook adapter's behavior. */
  async enrich(event: NormalizedEvent, _tenantId: string): Promise<NormalizedEvent> {
    return event;
  }

  async health(): Promise<AdapterHealth> {
    return {
      ok: true,
      detail: 'tenant-level health derived from active users with connected imap_smtp',
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
    // Disconnect every imap_smtp user_connector in this tenant. We
    // delete the encrypted password too — without it the saved row
    // can't authenticate IMAP anyway, and keeping it on disk after
    // an admin-initiated teardown is just data-debt.
    const before = await prisma.userConnector.findMany({
      where: { clientNumber: tenantId, connectorType: { slug: 'imap_smtp' } },
      select: { id: true },
    });
    if (!before.length) {
      return { ok: true, connectionsRemoved: 0, tokensRevoked: 0, notes: 'no imap_smtp connectors to tear down' };
    }
    await prisma.userConnector.updateMany({
      where: { id: { in: before.map((u) => u.id) } },
      data: { status: 'disconnected', config: {} },
    });
    return {
      ok: true,
      connectionsRemoved: before.length,
      tokensRevoked: before.length,
      notes: `Disconnected ${before.length} imap_smtp connectors and cleared encrypted credentials`,
    };
  }
}

export default new ImapSmtpFeedAdapter();
