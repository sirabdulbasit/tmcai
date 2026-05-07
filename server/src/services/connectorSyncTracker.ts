import prisma from '../db/prisma';

/**
 * Stamp `userConnector.lastSyncAt = now()` for a user's connector(s).
 *
 * Called by every feed poller after a successful pull so the Day Brief
 * "Last synced X ago" indicator reflects actual data freshness, not
 * the OAuth-handshake timestamp connectorService.ts writes at setup.
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
    await prisma.userConnector.updateMany({
      where: {
        userId,
        connectorTypeId: { in: connectorTypes.map((c) => c.id) },
      },
      data: { lastSyncAt: new Date() },
    });
  } catch (err: any) {
    console.warn(`[connectorSyncTracker] stamp failed user=${userId} slugs=${slugs.join(',')}: ${err.message}`);
  }
}
