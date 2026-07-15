/**
 * Shared classifier snippet used by autonomousExecutor + triageSuggester so
 * both produce the same archetype / dedup_hash for the same event.
 */
import type { Archetype } from './triageSuggester';

export function classifyArchetypeFromPayload(subject: string, preview: string, from: string): Archetype {
  const all = `${from} ${subject} ${preview}`.toLowerCase();
  if (/(newsletter|digest|unsubscribe|no[-_.]?reply|noreply)/.test(from) ||
      /(webinar|save \d+%|\bsale\b)/.test(all)) return 'inform_only';
  if (/\b(meeting|call|invite|calendar|reschedule|schedule)\b/.test(all)) return 'schedule_meeting';
  if (/\b(approve|approval|sign.?off|review|authoris)/.test(all)) return 'review_risk';
  if (/\b(announcement|all.hands|company update)\b/.test(all)) return 'acknowledge';
  return 'reply_needed';
}
