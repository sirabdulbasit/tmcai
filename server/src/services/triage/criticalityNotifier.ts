/**
 * Critical-bundle WhatsApp push.
 *
 * When the Attention list is built, any items in the `critical` band
 * (composite ≥ 0.8 and kept by the MAX_CRITICAL cap) can be pushed to
 * the user's WhatsApp in a single bundled message — so the user knows
 * something needs them even if MyOS isn't open.
 *
 * Now routes through `brainContactsUser`, which:
 *   - looks up target phone (prefs.brain_channel.whatsappNumber → contactNumber)
 *   - dedups via brain_user_messages (DB-backed, survives restarts)
 *   - honors quiet hours (skipped here — caller can pass urgency='emergency')
 *   - records an audit row visible in the Brain → User log.
 *
 * The fingerprint dedupKey is the sorted feed_event ids — same set ⇒ no
 * resend, new event arrives ⇒ key changes ⇒ resend allowed.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import type { AttentionItem } from './triageSuggester';
import { brainContactsUser } from '../notifications/brainOutboundService';

const log = createLogger('critical-notifier');

export async function maybePushCriticalBundle(
  clientNumber: string,
  userId: number,
  items: AttentionItem[],
): Promise<{ sent: boolean; reason?: string; messageId?: string }> {
  const criticals = items.filter((i) => i.critical);
  if (criticals.length === 0) return { sent: false, reason: 'no criticals' };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, clientNumber: true },
  }).catch(() => null);
  if (!user || user.clientNumber !== clientNumber) {
    return { sent: false, reason: 'user not found in tenant' };
  }

  const fp = criticals.map((c) => c.feedEventId).sort().join(',');
  const body = composeBundle(criticals, user.name ?? 'there');

  const r = await brainContactsUser({
    userId,
    kind: 'critical_bundle',
    summary: `${criticals.length} critical item${criticals.length === 1 ? '' : 's'} surfaced`,
    body,
    urgency: 'high',
    dedupKey: fp,
    metadata: { feedEventIds: criticals.map((c) => c.feedEventId) },
  });

  log.info('critical bundle dispatched', {
    clientNumber, userId, count: criticals.length,
    sent: r.sent, channels: r.channelsUsed, reason: r.reason,
  });

  return {
    sent: r.sent,
    reason: r.reason,
    messageId: r.waMessageIds[0] ?? r.recordId,
  };
}

function composeBundle(items: AttentionItem[], userName: string): string {
  const first = userName.split(' ')[0] || 'there';
  const count = items.length;
  const header = `🔴 Brain: ${count} critical item${count === 1 ? '' : 's'} need you, ${first}`;
  const bullets = items.slice(0, 5).map((it) => {
    const senderName = it.from.split('<')[0].trim() || it.fromEmail || 'sender';
    const subject = (it.subject || '').slice(0, 70);
    const why = firstReason(it);
    return `• ${senderName} — ${subject}${why ? ` (${why})` : ''}`;
  });
  const footer = count > 5 ? `\n…and ${count - 5} more in Day Brief.` : '\nOpen Day Brief to review.';
  return [header, '', ...bullets].join('\n') + footer;
}

function firstReason(it: AttentionItem): string | null {
  const r = it.criticality?.reasons ?? [];
  if (r.length === 0) return null;
  // Pick the shortest reason so the WhatsApp bullet stays scannable
  const short = [...r].sort((a, b) => a.length - b.length)[0];
  return short.length > 70 ? short.slice(0, 70) + '…' : short;
}
