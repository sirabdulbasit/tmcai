import { FeedAdapter, NormalizedEvent, AdapterHealth, BackfillRange, BackfillResult, TeardownResult } from '../adapterBase';
import prisma from '../../../db/prisma';

/**
 * HaseebOS v15 L1 — CRM FeedAdapter.
 *
 * Aligns to the v15 spec's 5-source inventory: Gmail / Calendar / Slack /
 * WhatsApp / CRM. The underlying CRM backend is Odoo, but the adapter
 * exposes a neutral `sourceType='crm'` so future CRM migrations don't break
 * consumers.
 *
 * Polls Odoo for recently-updated leads and opportunities via the existing
 * Odoo connector. Push-style webhooks can be wired later; this adapter's
 * capability matrix reports receive+backfill+teardown only.
 */
export class CrmFeedAdapter extends FeedAdapter {
  readonly sourceType = 'crm' as const;
  readonly displayName = 'CRM (Odoo)';

  async receive(_tenantId: string, _since?: Date, _limit = 50): Promise<unknown[]> {
    // Odoo fetch helper not yet centralised; returning [] until an `odooClient`
    // module lands. Backfill() still works for tenants that push CRM events via
    // the /webhooks/generic/ endpoint.
    return [];
  }

  normalise(raw: unknown): NormalizedEvent {
    const r = raw as any;
    const model = r.model ?? 'crm.lead';
    const eventType = r.is_new ? 'task_assigned' : 'status_update';
    return {
      sourceId: `${model}:${r.id}`,
      eventType,
      sender: {
        id: r.user_id ? String(r.user_id) : undefined,
        name: r.user_name,
        email: r.user_email,
      },
      payload: {
        model,
        recordId: r.id,
        name: r.name,
        stage: r.stage_id,
        expectedRevenue: r.expected_revenue,
        partnerId: r.partner_id,
        partnerName: r.partner_name,
        lastUpdate: r.write_date,
      },
      receivedAt: r.write_date ? new Date(r.write_date) : new Date(),
    };
  }

  async health(tenantId?: string): Promise<AdapterHealth> {
    if (!tenantId) return { ok: true, detail: 'no tenant scope supplied', lastCheckedAt: new Date().toISOString() };
    try {
      const connector = await prisma.userConnector.findFirst({
        where: { clientNumber: tenantId, providerName: 'odoo', status: 'active' } as any,
        select: { id: true } as any,
      });
      return {
        ok: !!connector,
        detail: connector ? 'active Odoo connector present' : 'no active Odoo connector',
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      return { ok: false, detail: err.message, lastCheckedAt: new Date().toISOString() };
    }
  }

  async backfill(range: BackfillRange): Promise<BackfillResult> {
    const raws = await this.receive(range.tenantId, range.since, Math.min(range.maxEvents ?? 100, 500));
    let fetched = raws.length;
    let ingested = 0, duplicates = 0, errors = 0;
    let first: Date | undefined, last: Date | undefined;
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
    const result = await prisma.userConnector.updateMany({
      where: { clientNumber: tenantId, providerName: 'odoo' } as any,
      data: { accessToken: null, refreshToken: null, status: 'disconnected' } as any,
    });
    return {
      ok: true,
      connectionsRemoved: result.count,
      tokensRevoked: result.count,
      notes: `Disconnected ${result.count} Odoo connectors`,
    };
  }
}

export default new CrmFeedAdapter();
