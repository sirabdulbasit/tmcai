import prisma from '../db/prisma';

/**
 * Google connectors all share one OAuth grant per user. When ONE of
 * them successfully syncs, the grant is provably alive — so the
 * siblings in degraded state (sync_stale / error / token_expired,
 * usually from a prior cascade-fail in integrationService.ts when
 * Gmail's refresh threw) should ALSO be healed. Without this mirror
 * heal, the user reconnects Gmail, Chat polls successfully, but
 * Gmail/Drive/Tasks/Calendar remain stuck in 'error' from the
 * cascade flip that happened before reconnect.
 *
 * The set is closed (Google's 5 connector types). Slug match below
 * triggers the sibling heal.
 */
const GOOGLE_SLUGS = new Set([
  'gmail', 'google_calendar', 'google_tasks', 'google_chat', 'google_drive_personal',
]);

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

    // ── Google sibling heal ──
    // If any of the slugs we just stamped is a Google connector, the
    // shared OAuth grant is proven alive. Heal sibling Google
    // connectors still stuck in degraded state from the cascade
    // failure in integrationService.ts (which flips ALL Google rows
    // to 'error' when one refresh throws). Without this, the user
    // can never recover from a Gmail-token-expired cascade unless
    // EVERY Google connector independently succeeds — and since the
    // cascade keeps re-firing on each failed Gmail poll, the others
    // never get a chance.
    const touchedGoogle = slugs.some((s) => GOOGLE_SLUGS.has(s));
    if (touchedGoogle) {
      const allGoogleTypes = await prisma.connectorType.findMany({
        where: { slug: { in: [...GOOGLE_SLUGS] } },
        select: { id: true },
      }).catch(() => [] as Array<{ id: string }>);
      const allGoogleTypeIds = allGoogleTypes.map((t) => t.id);
      const stuckSiblings = await prisma.userConnector.findMany({
        where: {
          userId,
          connectorTypeId: { in: allGoogleTypeIds, notIn: ctIds },
          status: { in: ['sync_stale', 'error', 'token_expired'] as any },
        },
        select: { id: true, metadata: true },
      }).catch(() => [] as Array<{ id: string; metadata: unknown }>);
      if (stuckSiblings.length > 0) {
        await prisma.userConnector.updateMany({
          where: { id: { in: stuckSiblings.map((s) => s.id) } },
          data: { status: 'connected', errorMessage: null } as any,
        }).catch(() => {});
        for (const sib of stuckSiblings) {
          const m = { ...((sib.metadata as Record<string, unknown> | null) ?? {}) };
          delete m.lastError;
          delete m.staleSince;
          delete m.staleMin;
          delete m.lastRefreshError;
          delete m.lastRefreshErrorAt;
          delete m.tokenExpiredAt;
          m.recoveredAt = new Date().toISOString();
          m.recoveredVia = 'google_sibling_heal';
          await prisma.userConnector.update({
            where: { id: sib.id }, data: { metadata: m as any },
          }).catch(() => {});
        }
      }
    }
  } catch (err: any) {
    console.warn(`[connectorSyncTracker] stamp failed user=${userId} slugs=${slugs.join(',')}: ${err.message}`);
  }
}
