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

// In-flight lock + last-sent fingerprint cache. Without these, two
// concurrent /brief/attention requests (e.g. two open tabs, or React
// strict-mode double-fetch) each hit the dedup check at the same instant
// before either has written the audit row, and the user gets the same
// bundle twice in WhatsApp 0-1s apart. The lock makes the check-then-
// write atomic per user; the cache squashes redundant pushes when the
// item set hasn't changed.
const inFlight = new Set<number>();
const lastSentByUser = new Map<number, { fp: string; at: number }>();
const RESEND_GUARD_MS = 5 * 60 * 1000; // 5 min

export async function maybePushCriticalBundle(
  clientNumber: string,
  userId: number,
  items: AttentionItem[],
): Promise<{ sent: boolean; reason?: string; messageId?: string }> {
  // Drop items the user has explicitly snoozed via WhatsApp ("stop",
  // "shouldn't be", etc.). Without this, Brain keeps re-bundling the
  // same thread every 90s and the user's "leave me alone" signal does
  // nothing visible.
  const { getActiveSnoozeIds } = await import('../brainPrompts/negativeFeedbackHandler');
  const snoozed = await getActiveSnoozeIds(userId);
  const criticals = items.filter((i) => i.critical && !snoozed.has(i.feedEventId));
  if (criticals.length === 0) return { sent: false, reason: 'no criticals' };

  // Race guard: only one bundle dispatch in flight per user at a time.
  if (inFlight.has(userId)) {
    return { sent: false, reason: 'concurrent_dispatch_in_progress' };
  }

  const fp = criticals.map((c) => c.feedEventId).sort().join(',');

  // Fast-path dedup: if we sent this exact fingerprint to this user
  // within the resend guard window, skip without even hitting the DB.
  // This is in-memory, so it doesn't survive restarts — the DB-backed
  // dedup in brainContactsUser is the durable layer; this just stops
  // the same-millisecond race that the DB check can't catch.
  const last = lastSentByUser.get(userId);
  if (last && last.fp === fp && Date.now() - last.at < RESEND_GUARD_MS) {
    return { sent: false, reason: 'recently_sent_same_fingerprint' };
  }

  inFlight.add(userId);
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, clientNumber: true },
    }).catch(() => null);
    if (!user || user.clientNumber !== clientNumber) {
      return { sent: false, reason: 'user not found in tenant' };
    }

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

    if (r.sent) {
      lastSentByUser.set(userId, { fp, at: Date.now() });
    }

    log.info('critical bundle dispatched', {
      clientNumber, userId, count: criticals.length,
      sent: r.sent, channels: r.channelsUsed, reason: r.reason,
    });

    return {
      sent: r.sent,
      reason: r.reason,
      messageId: r.waMessageIds[0] ?? r.recordId,
    };
  } finally {
    inFlight.delete(userId);
  }
}

/**
 * Collapse attention items to one-per-thread before composing the bundle.
 * Without this, a single thread (#4724004 → "Re: Fwd: VM Day 9") shows
 * up 4× because each reply in the chain produces its own feed_event
 * with a different feedEventId. The user reads "4 critical items" but
 * really there's 1 conversation. After collapse, the bullet count is
 * meaningful and the bundle is much shorter.
 */
function collapseByThread(items: AttentionItem[]): AttentionItem[] {
  const buckets = new Map<string, AttentionItem>();
  for (const it of items) {
    const key = threadKey(it);
    const existing = buckets.get(key);
    // Keep the highest-criticality item per thread; if tied, the most
    // recent (first in the list — items arrive sorted desc).
    if (!existing) {
      buckets.set(key, it);
    } else {
      const a = it.criticality?.composite ?? 0;
      const b = existing.criticality?.composite ?? 0;
      if (a > b) buckets.set(key, it);
    }
  }
  return [...buckets.values()];
}

function threadKey(it: AttentionItem): string {
  const subj = (it.subject ?? '')
    .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/gi, '')   // strip reply prefixes
    .replace(/\(#\d+\)/g, '')                       // strip ticket refs
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  // Same subject across senders → same thread (forwards count too).
  return subj || `event:${it.feedEventId}`;
}

function composeBundle(items: AttentionItem[], userName: string): string {
  const first = userName.split(' ')[0] || 'there';
  const collapsed = collapseByThread(items);
  const count = collapsed.length;
  const noun = count === 1 ? 'thread' : 'threads';
  const header = `🔴 Brain: ${count} critical ${noun} need${count === 1 ? 's' : ''} you, ${first}`;
  const bullets = collapsed.slice(0, 5).map((it) => {
    const senderName = (it.fromDisplay || it.from.split('<')[0].trim() || it.fromEmail || 'sender').slice(0, 40);
    const subject = (it.subject || '').replace(/^(\s*(re|fwd|fw)\s*:\s*)+/gi, '').slice(0, 60);
    const why = firstReason(it);
    return `• ${senderName} — ${subject}${why ? `\n   ↪ ${why}` : ''}`;
  });
  const footer = count > 5 ? `\n…and ${count - 5} more in Day Brief.` : '\nReply with the thread name to act, or open Day Brief.';
  return [header, '', ...bullets].join('\n') + footer;
}

function firstReason(it: AttentionItem): string | null {
  const r = it.criticality?.reasons ?? [];
  if (r.length === 0) return null;
  // Pick the shortest reason so the WhatsApp bullet stays scannable.
  // Truncate at a word boundary so we don't end mid-syllable ("d…").
  const short = [...r].sort((a, b) => a.length - b.length)[0];
  return softTruncate(short, 80);
}

function softTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > max * 0.6) return slice.slice(0, lastSpace) + '…';
  return slice + '…';
}

/**
 * Per-tenant cron sweep entry. Iterates every active user and pushes
 * the critical bundle. Replaces the previous "fire on every
 * /brief/attention" model that produced duplicate sends when the page
 * was opened in two tabs or React strict-mode double-fetched.
 *
 * The maybePushCriticalBundle() guards (in-flight set + lastSentByUser
 * fingerprint cache + DB-backed dedup window) ensure that even multiple
 * cron ticks landing close together never produce duplicate sends.
 */
export async function sweepCriticalBundles(): Promise<{ users: number; sent: number; skipped: number; errors: number }> {
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, clientNumber: true },
    take: 1000,
  }).catch(() => [] as Array<{ id: number; clientNumber: string }>);
  let sent = 0, skipped = 0, errors = 0;
  for (const u of users) {
    try {
      const { buildAttentionList } = await import('./triageSuggester');
      const items = await buildAttentionList(u.clientNumber, u.id, 30);
      const r = await maybePushCriticalBundle(u.clientNumber, u.id, items);
      if (r.sent) sent++; else skipped++;
    } catch (err: any) {
      errors++;
      log.warn('sweep tick error', { userId: u.id, err: err.message });
    }
  }
  return { users: users.length, sent, skipped, errors };
}
