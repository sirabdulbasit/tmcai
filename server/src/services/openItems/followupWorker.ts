/**
 * MyOS — Open-Item Follow-Up Worker.
 *
 * The "Brain runs after you" piece for delegated work. Once a day, scan
 * every DELEGATED open item that has been silent past its threshold and
 * ping the user (Brain → user via WhatsApp / standing channel) so they
 * can chase or escalate.
 *
 * Why this exists: triage already creates the open item and records the
 * delegation. After that, *nothing* watched it. A delegated email sat
 * silent for 30 days and Brain never noticed. The user manually had to
 * remember every delegation. This worker turns that into proactive
 * detection.
 *
 * Behavior:
 *   - Threshold: configurable per item via metadata.followupAfterDays;
 *     defaults below.
 *   - Tiered: 3d silent → first nudge ("are they back to you?"), 7d →
 *     second ("consider escalation"), 14d → escalation suggestion.
 *   - Recorded: each fired ping writes metadata.lastFollowupAt + a tiny
 *     trail so we don't ping again until the next tier.
 *   - Brain message goes through brainContactsUser (so it respects
 *     quiet hours, dedup, channel selection — same as any other Brain
 *     outbound).
 *
 * Schedule: hourly cron (so different users in different timezones get
 * appropriate hours of the day; brainContactsUser handles quiet hours).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('open-item-followup');

const TIERS = [
  { days: 3, label: 'first_nudge',   tone: 'gentle' },
  { days: 7, label: 'second_nudge',  tone: 'firmer' },
  { days: 14, label: 'escalate',      tone: 'escalation' },
] as const;

type Tier = typeof TIERS[number];

interface ItemMeta {
  followupAfterDays?: number;
  lastFollowupAt?: string;
  followupTier?: Tier['label'];
  followupTrail?: Array<{ at: string; tier: string }>;
}

function tierForAge(daysSilent: number, override?: number): Tier | null {
  // If the item explicitly opts in to a custom threshold, the first nudge
  // fires after that — subsequent tiers are still 7d, 14d.
  const eligible = TIERS.filter((t) => daysSilent >= (override && t.label === 'first_nudge' ? override : t.days));
  return eligible[eligible.length - 1] ?? null;
}

/**
 * Run a single sweep: find DELEGATED items eligible for a nudge,
 * fire the message, mark metadata. Returns counts for observability.
 */
export async function runFollowupSweep(opts: { dryRun?: boolean } = {}): Promise<{
  scanned: number;
  nudged: number;
  skippedQuiet: number;
  errors: number;
}> {
  const out = { scanned: 0, nudged: 0, skippedQuiet: 0, errors: 0 };

  // Look at items that haven't been touched recently. Only DELEGATED for
  // this first version — IN_PROGRESS / WAITING_INFO can come next.
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const items = await prisma.openItem.findMany({
    where: {
      status: 'DELEGATED' as any,
      updatedAt: { lt: cutoff },
    } as any,
    select: {
      id: true, clientNumber: true, userId: true, title: true,
      delegateeName: true, delegateeEmail: true,
      updatedAt: true, metadata: true, priority: true,
      sourceFeed: true,
    },
    take: 500,
  }).catch(() => [] as any[]);
  out.scanned = items.length;

  for (const it of items) {
    const meta: ItemMeta = (it.metadata as any) ?? {};
    const daysSilent = Math.floor((Date.now() - new Date(it.updatedAt).getTime()) / (24 * 60 * 60 * 1000));
    const tier = tierForAge(daysSilent, meta.followupAfterDays);
    if (!tier) continue;

    // Skip if we've already fired THIS tier (avoid daily spam — only fire
    // when we cross into a new tier).
    if (meta.followupTier === tier.label) continue;

    const delegate = it.delegateeName ?? it.delegateeEmail ?? 'the assignee';
    const body = composeNudge({
      tier,
      title: it.title,
      delegate,
      daysSilent,
      priority: it.priority ?? 'medium',
    });

    if (opts.dryRun) {
      log.info('would nudge', { itemId: it.id, userId: it.userId, tier: tier.label, daysSilent });
      out.nudged += 1;
      continue;
    }

    try {
      // Route through the Brain prompt queue instead of firing
      // brainContactsUser directly. This serialises the conversation:
      // 10 stale items become 10 sequential prompts the user answers
      // one at a time, not 10 simultaneous WhatsApp pings.
      const { enqueueBrainPrompt } = await import('../brainPrompts/brainPromptQueueService');
      const criticality = tier.label === 'escalate'
        ? 'high'
        : 'routine';
      const r = await enqueueBrainPrompt({
        userId: it.userId,
        clientNumber: it.clientNumber,
        question: body,
        openItemId: it.id,
        sideEffect: { kind: 'free_form_note', openItemId: it.id },
        criticality,
        dedupKey: `followup:${it.id}:${tier.label}`,
        metadata: { tier: tier.label, daysSilent, source: 'followup_worker' },
      });
      if (r.status === 'duplicate') {
        // Already enqueued in a prior sweep; tier hasn't crossed yet.
        continue;
      }
      // Record so we don't fire this tier again. Next tier will fire when
      // daysSilent crosses its threshold.
      const trail = [...(meta.followupTrail ?? []), { at: new Date().toISOString(), tier: tier.label }];
      await prisma.openItem.update({
        where: { id: it.id },
        data: {
          metadata: {
            ...(meta as Record<string, unknown>),
            followupTier: tier.label,
            lastFollowupAt: new Date().toISOString(),
            followupTrail: trail.slice(-10),
          } as any,
        },
      }).catch(() => {});
      out.nudged += 1;
    } catch (e: any) {
      log.warn('followup nudge failed', { itemId: it.id, error: e.message });
      out.errors += 1;
    }
  }

  if (out.scanned > 0) {
    log.info('followup sweep complete', out);
  }
  return out;
}

function composeNudge(args: {
  tier: Tier;
  title: string;
  delegate: string;
  daysSilent: number;
  priority: string;
}): string {
  const { tier, title, delegate, daysSilent, priority } = args;
  const titleClip = title.length > 80 ? `${title.slice(0, 77)}…` : title;
  if (tier.label === 'first_nudge') {
    return `🔔 Brain: heads-up — "${titleClip}" was delegated to ${delegate} ${daysSilent} days ago and they haven't reported back. Worth a quick ping?`;
  }
  if (tier.label === 'second_nudge') {
    return `🟡 Brain: "${titleClip}" — ${delegate} silent for ${daysSilent} days. ${priority === 'high' || priority === 'critical' ? 'This is high priority.' : ''} Suggest you ask for status today.`;
  }
  // escalate
  return `🔴 Brain: "${titleClip}" — delegated to ${delegate}, no movement in ${daysSilent} days. Recommend you escalate or take it back. Open Day Brief to act.`;
}
