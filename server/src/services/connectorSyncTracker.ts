import prisma from '../db/prisma';

/**
 * Stamp `userConnector.lastSyncAt = now()` for a user's connector(s).
 *
 * Called by every feed poller after a successful pull so the Day Brief
 * "Last synced X ago" indicator reflects actual data freshness, not
 * the OAuth-handshake timestamp connectorService.ts writes at setup.
 *
 * Auto-recovery: when a poll SUCCEEDS, that's proof the connector is
 * healthy. Reset status from any degraded state (sync_stale, error,
 * token_expired) back to 'connected' and clear lastError. Without
 * this, a connector flipped to sync_stale by the health detector
 * (server/src/services/connectorHealthService.ts) stays "broken" in
 * the Day Brief banner forever, even after re-pair restores polling.
 * Observed 2026-05-11: user reconnected Gmail/Calendar/Chat, polls
 * succeeded, but banner kept showing them as broken because nothing
 * reset status. This closes that loop.
 *
 * Best-effort: never throws — a failed update should never block ingest.
 */
export async function stampConnectorSync(userId: number, slugs: string[]): Promise<void> {
  if (!slugs.length) return;
  try {
    const connectorTypes = await prisma.connectorType.findMany({
      where: { slug: { in: slugs } },
      select: { id: true },
    });
    if (!connectorTypes.length) return;
    const ctIds = connectorTypes.map((c) => c.id);

    // First, find rows in a degraded state so we can also clear
    // metadata.lastError + staleSince on them. updateMany can't
    // merge JSON fields, so we do a per-row metadata clean for the
    // few rows that need it.
    const degraded = await prisma.userConnector.findMany({
      where: {
        userId, connectorTypeId: { in: ctIds },
        status: { in: ['sync_stale', 'error', 'token_expired'] as any },
      },
      select: { id: true, metadata: true },
    }).catch(() => [] as Array<{ id: string; metadata: unknown }>);

    // Bulk update: lastSyncAt + status='connected' + errorMessage=null
    // for everyone. Rows already at 'connected' get a no-op status
    // update; cheaper than splitting the call.
    await prisma.userConnector.updateMany({
      where: { userId, connectorTypeId: { in: ctIds } },
      data: { lastSyncAt: new Date(), status: 'connected', errorMessage: null } as any,
    });

    // Per-row metadata cleanup for the degraded rows — strip
    // staleSince / lastError / lastRefreshError so the banner reads
    // clean once the user revisits.
    for (const row of degraded) {
      const m = { ...((row.metadata as Record<string, unknown> | null) ?? {}) };
      delete m.lastError;
      delete m.staleSince;
      delete m.staleMin;
      delete m.lastRefreshError;
      delete m.lastRefreshErrorAt;
      delete m.tokenExpiredAt;
      m.recoveredAt = new Date().toISOString();
      await prisma.userConnector.update({
        where: { id: row.id }, data: { metadata: m as any },
      }).catch(() => { /* best-effort */ });
    }
  } catch (err: any) {
    console.warn(`[connectorSyncTracker] stamp failed user=${userId} slugs=${slugs.join(',')}: ${err.message}`);
  }
}
