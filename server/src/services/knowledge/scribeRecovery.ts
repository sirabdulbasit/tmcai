/**
 * MyOS — Scribe Recovery (boot-time sweep).
 *
 * If the server is killed mid-scribe, the user_connector row stays at
 * metadata.scribeStatus='running' forever. The UI then shows a permanent
 * "SCRIBING…" badge and hides the Scribe button — the connector cannot
 * be re-scribed without manual DB surgery.
 *
 * This sweep runs once on every server boot. Any row whose scribeStartedAt
 * is older than the staleness threshold (30 minutes — much longer than any
 * real scribe takes) is cleared back to 'never'/'error' so the user can
 * re-trigger from the UI.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('scribe-recovery');
const STALE_AFTER_MS = 30 * 60 * 1000;

export async function recoverStuckScribes(): Promise<void> {
  const rows = await prisma.userConnector.findMany({
    where: {} as any,
    select: { id: true, userId: true, metadata: true },
  }).catch(() => [] as any[]);

  let cleared = 0;
  for (const r of rows) {
    const m: any = r.metadata ?? {};
    if (m.scribeStatus !== 'running') continue;
    const startedAt = m.scribeStartedAt ? Date.parse(m.scribeStartedAt) : 0;
    const age = Date.now() - startedAt;
    if (age < STALE_AFTER_MS) continue;
    await prisma.userConnector.update({
      where: { id: r.id },
      data: {
        metadata: {
          ...m,
          scribeStatus: m.lastScribedAt ? 'ok' : 'error',
          scribeError: 'recovered after server restart — please re-scribe',
          scribeStartedAt: null,
        } as any,
      },
    }).catch(() => {});
    cleared += 1;
  }

  if (cleared > 0) log.info('cleared stuck scribe rows on boot', { cleared });
}
