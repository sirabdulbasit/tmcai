/**
 * HaseebOS v15 L2 — Archetype classifier.
 *
 * Maps a FeedEvent payload to one of the six v15 archetypes. This is a
 * deterministic heuristic fallback used when the Feed Curator agent does not
 * explicitly set archetype, or when running offline (e.g. backfill).
 *
 * The Curator agent can call POST /api/v1/triage/archetype to borrow this same
 * logic as a tool — see triageRoutes.ts.
 */

export type Archetype =
  | 'reply_needed'
  | 'delegate'
  | 'inform_only'
  | 'schedule_meeting'
  | 'review_risk'
  | 'acknowledge';

export const ALL_ARCHETYPES: readonly Archetype[] = [
  'reply_needed',
  'delegate',
  'inform_only',
  'schedule_meeting',
  'review_risk',
  'acknowledge',
] as const;

export interface ArchetypeInput {
  sourceType?: string;
  eventType?: string;
  senderEmail?: string | null;
  subject?: string | null;
  snippet?: string | null;
  body?: string | null;
  vip?: boolean;
}

export interface ArchetypeResult {
  archetype: Archetype;
  confidence: number; // 0..1 — heuristic score
  signals: string[];
}

const RISK_KEYWORDS = /\b(urgent|breach|incident|lawsuit|subpoena|escalat|fraud|risk|leak|outage|compliance|regulator|penalty)\b/i;
const SCHEDULE_KEYWORDS = /\b(meeting|call|sync|zoom|google meet|calendly|invitation|invite|availability|schedule)\b/i;
const REPLY_KEYWORDS = /\b(please respond|please reply|let me know|thoughts\?|confirm|rsvp|asap|by (eod|tomorrow|friday))\b/i;
const DELEGATE_KEYWORDS = /\b(can you|please handle|over to you|assigning to|please take|need (help|support))\b/i;
const INFORM_KEYWORDS = /\b(fyi|for your information|no action|just sharing|newsletter|digest|weekly summary)\b/i;

export function classifyArchetype(input: ArchetypeInput): ArchetypeResult {
  const text = [input.subject, input.snippet, input.body].filter(Boolean).join('\n').trim();
  const signals: string[] = [];

  // 1. Meeting signals — calendar events or meeting keywords.
  if (input.sourceType === 'gcal' || /meeting_invite|meeting_updated/.test(input.eventType ?? '')) {
    signals.push('source:calendar');
    return { archetype: 'schedule_meeting', confidence: 0.95, signals };
  }
  if (SCHEDULE_KEYWORDS.test(text)) {
    signals.push('keyword:schedule');
  }

  // 2. Risk signals — VIP + risk keyword = review_risk.
  if (RISK_KEYWORDS.test(text)) {
    signals.push('keyword:risk');
    return {
      archetype: 'review_risk',
      confidence: input.vip ? 0.95 : 0.8,
      signals,
    };
  }

  // 3. Scheduling signals dominate over reply/delegate.
  if (signals.includes('keyword:schedule')) {
    return { archetype: 'schedule_meeting', confidence: 0.8, signals };
  }

  // 4. Reply needed.
  if (REPLY_KEYWORDS.test(text)) {
    signals.push('keyword:reply');
    return { archetype: 'reply_needed', confidence: 0.85, signals };
  }

  // 5. Delegate / reassign.
  if (DELEGATE_KEYWORDS.test(text)) {
    signals.push('keyword:delegate');
    return { archetype: 'delegate', confidence: 0.75, signals };
  }

  // 6. Inform-only catch-all.
  if (INFORM_KEYWORDS.test(text)) {
    signals.push('keyword:inform');
    return { archetype: 'inform_only', confidence: 0.8, signals };
  }

  // 7. Default — acknowledge (item exists but needs no action).
  signals.push('default:acknowledge');
  return { archetype: 'acknowledge', confidence: 0.5, signals };
}

/**
 * Convenience: derive the target OpenItem.type from an archetype so the
 * existing type column stays consistent.
 */
export function archetypeToItemType(a: Archetype): 'email' | 'task' | 'delegation' | 'alert' {
  switch (a) {
    case 'reply_needed':
      return 'email';
    case 'delegate':
      return 'delegation';
    case 'review_risk':
      return 'alert';
    case 'schedule_meeting':
      return 'task';
    case 'inform_only':
    case 'acknowledge':
    default:
      return 'task';
  }
}
