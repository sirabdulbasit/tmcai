/**
 * User-triggered "Historical Pull" — runs the right history-fetching
 * action for every connected source connector the user owns.
 *
 *   gmail             → warmUpBrainFromSources (last 30d/500 msgs)
 *                       + triggerBackfillForUser (attachments + sender wiki)
 *   google_calendar   → warmUpBrainFromSources (covers -30d/+60d calendar)
 *   google_tasks      → (no historical pull today — live sync only)
 *   whatsapp_personal → live messages flow via pairing; historical fetch
 *                       not wired yet (requires whatsapp-web.js chat history
 *                       API — tracked as a future ticket).
 *
 * Fire-and-forget from the caller — the operation is idempotent and
 * bounded by the existing backfill worker's per-user rate limit.
 * Returns a per-connector summary so the UI can show what ran.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('historical-pull');

export interface HistoricalPullSummary {
  triggered: Array<{ slug: string; action: string }>;
  skipped: Array<{ slug: string; reason: string }>;
  startedAt: string;
}

export async function runHistoricalPullForUser(
  clientNumber: string,
  userId: number,
  opts: { days?: number; cap?: number } = {},
): Promise<HistoricalPullSummary> {
  const startedAt = new Date().toISOString();
  // Clamp: 7d minimum (anything smaller is meaningless), 730d maximum
  // (2 years; Gmail quota and backfill time start to hurt beyond).
  const days = Math.min(730, Math.max(7, opts.days ?? 30));
  const cap = Math.min(5000, Math.max(100, opts.cap ?? 500 * Math.ceil(days / 30)));

  const connectors = await prisma.userConnector.findMany({
    where: { userId, clientNumber, status: 'connected' },
    include: { connectorType: { select: { slug: true } } },
  }).catch(() => [] as any[]);

  const triggered: Array<{ slug: string; action: string }> = [];
  const skipped: Array<{ slug: string; reason: string }> = [];

  // Gmail + Calendar share warmUpBrainFromSources; run it once if either is
  // connected to avoid duplicate work.
  const hasGmail = connectors.some((c: any) => c.connectorType.slug === 'gmail');
  const hasCalendar = connectors.some((c: any) => c.connectorType.slug === 'google_calendar');
  if (hasGmail || hasCalendar) {
    void (async () => {
      try {
        const { warmUpBrainFromSources } = await import('./historicalFeedPull');
        await warmUpBrainFromSources(clientNumber, userId, {
          gmailDays: days,
          gmailCap: cap,
          calendarDaysBack: days,
        });
      } catch (err: any) {
        log.warn('warmUpBrain failed', { userId, error: err.message });
      }
    })();
    if (hasGmail) triggered.push({ slug: 'gmail', action: `warm_up_${days}d_${cap}msgs` });
    if (hasCalendar) triggered.push({ slug: 'google_calendar', action: `warm_up_${days}d` });
  }

  // Gmail — also fire the attachment + sender-wiki retro-processing so the
  // user sees the progress banner and sender/topic/attachment pages
  // rebuild over the next few minutes.
  if (hasGmail) {
    void (async () => {
      try {
        const { triggerBackfillForUser } = await import('../../jobs/attachmentBackfillWorker');
        await triggerBackfillForUser(clientNumber, userId, { reason: 'user_historical_pull' });
      } catch (err: any) {
        log.warn('attachment backfill trigger failed', { userId, error: err.message });
      }
    })();
    triggered.push({ slug: 'gmail', action: 'attachment_backfill' });
  }

  // Future: whatsapp_personal historical pull. Not implemented today —
  // pairing only captures live messages forward.
  const hasWhatsApp = connectors.some((c: any) => c.connectorType.slug === 'whatsapp_personal');
  if (hasWhatsApp) {
    skipped.push({ slug: 'whatsapp_personal', reason: 'historical_pull_not_yet_supported' });
  }

  // Anything else connected but not handled above (google_tasks, google_drive_personal, ...)
  for (const c of connectors) {
    const slug = c.connectorType.slug;
    if (triggered.some((t) => t.slug === slug)) continue;
    if (skipped.some((s) => s.slug === slug)) continue;
    skipped.push({ slug, reason: 'no_historical_pull_for_this_connector' });
  }

  log.info('historical pull kicked off', { clientNumber, userId, triggered, skipped });
  return { triggered, skipped, startedAt };
}
