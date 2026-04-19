import prisma from '../db/prisma';
import { listAll } from '../services/adapters/adapterRegistry';
import { isFeatureEnabled } from '../services/featureFlagService';

/**
 * HaseebOS v15 L1 — generic feed poller.
 *
 * Walks the adapter registry, and for every adapter whose capability matrix
 * reports `receive: true`, pulls the most recent N events and feeds each
 * through the adapter's own normalise() + storeAndPublish() so the canonical
 * ingest path (with SETNX gate + HMAC integrity + Pub/Sub ordering) runs for
 * free.
 *
 * This supersedes the hard-coded `gmailFeedPoller` as the default pull path.
 * The Gmail poller is kept for its `enrichBody()` helper that the Feed Curator
 * uses on VIP emails; it no longer drives scheduled ingestion.
 *
 * Feature flag: per-tenant `feature_feed_ingestion_pubsub` (existing). When
 * off, the generic poller is a no-op.
 */

const MAX_EVENTS_PER_ADAPTER = 25;

export interface PollSummary {
  tenantId: string;
  source: string;
  fetched: number;
  ingested: number;
  duplicates: number;
  errors: number;
  durationMs: number;
}

export async function pollAllTenants(): Promise<PollSummary[]> {
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true },
    select: { clientNumber: true },
  });
  const summaries: PollSummary[] = [];
  for (const t of tenants) {
    const enabled = await isFeatureEnabled(t.clientNumber, 'feature_feed_ingestion_pubsub', false);
    if (!enabled) continue;
    for (const adapter of listAll()) {
      // Adapters with no receive() (push-only e.g. Slack webhooks, WhatsApp) should be skipped.
      if (!adapter.capabilities().receive) continue;
      const t0 = Date.now();
      let fetched = 0, ingested = 0, duplicates = 0, errors = 0;
      try {
        const raws = await adapter.receive!(t.clientNumber, undefined, MAX_EVENTS_PER_ADAPTER);
        fetched = raws.length;
        for (const raw of raws) {
          try {
            const normalised = adapter.normalise(raw);
            const r = await adapter.storeAndPublish(normalised, t.clientNumber);
            if (r.status === 'new') ingested += 1;
            else if (r.status === 'duplicate') duplicates += 1;
            else errors += 1;
          } catch {
            errors += 1;
          }
        }
      } catch (err: any) {
        errors += 1;
        console.warn(`[genericPoller] ${adapter.sourceType}/${t.clientNumber} receive failed: ${err.message}`);
      }
      summaries.push({
        tenantId: t.clientNumber,
        source: adapter.sourceType,
        fetched,
        ingested,
        duplicates,
        errors,
        durationMs: Date.now() - t0,
      });
    }
  }
  return summaries;
}
