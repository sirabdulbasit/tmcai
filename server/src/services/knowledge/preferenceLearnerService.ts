/**
 * Phase E — policy-gradient learning (foundation).
 *
 * Every user action the chat + day-brief surfaces produce becomes a
 * signal we file into `agent_actions`. Over time these build up per-user
 * distributions that future Brain turns can read to bias their behaviour
 * toward what the user actually accepts.
 *
 * This phase ships the PLUMBING — signal recording + a read API that
 * returns current counts per (archetype × delegatee / tone / decision).
 * The actual online policy update (temperature, exploration, softmax
 * sampling) layers on top later once we have weeks of real click data.
 *
 * Signal shape stored in agent_actions.output.signal:
 *   {
 *     kind: 'accept_draft' | 'reject_draft' | 'edit_draft'
 *         | 'delegate' | 'archive' | 'snooze' | 'mark_critical',
 *     archetype?: string,
 *     senderDomain?: string,
 *     delegateeEmail?: string,
 *     tone?: 'formal' | 'casual' | 'warm' | 'terse',
 *     editRatio?: number,    // 0 unchanged, 1 fully rewritten
 *     timestamp: ISO,
 *   }
 *
 * Record is lossless — we never aggregate/erase individual signals here.
 * Aggregation happens on read so we can change the aggregator later
 * without losing history.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('preference-learner');

export type SignalKind =
  | 'accept_draft' | 'reject_draft' | 'edit_draft'
  | 'delegate' | 'archive' | 'snooze' | 'mark_critical'
  // Explicit 👍 / 👎 feedback on any Brain-produced output. Captured by
  // feedbackService.recordFeedback and fed to the preference learner so
  // repeated down-votes can shift retrieval / tone / criticality weights.
  | 'feedback_up' | 'feedback_down';

export interface Signal {
  kind: SignalKind;
  archetype?: string;
  senderDomain?: string;
  delegateeEmail?: string;
  tone?: 'formal' | 'casual' | 'warm' | 'terse';
  editRatio?: number;
  context?: Record<string, unknown>;
}

/** Persist a single signal. Fire-and-forget safe. */
export async function recordSignal(
  clientNumber: string,
  userId: number,
  signal: Signal,
): Promise<void> {
  try {
    await prisma.agentAction.create({
      data: {
        clientNumber, userId,
        actionType: 'user_signal',
        status: 'done',
        input: {},
        output: { signal: { ...signal, timestamp: new Date().toISOString() } } as any,
        requiresApproval: false,
        executedByAgent: 'preference_learner',
      } as any,
    });
  } catch (err: any) {
    log.warn('recordSignal failed', { kind: signal.kind, error: err.message });
  }
}

export interface PreferenceSummary {
  /** Count of signals by kind, last 90 days. */
  byKind: Record<string, number>;
  /** Top delegatees the user picks, by count. */
  preferredDelegatees: Array<{ email: string; n: number }>;
  /** Tone distribution on accept_draft signals. */
  acceptedTones: Record<string, number>;
  /** Archetypes most often accepted vs rejected — a cheap "trust" signal. */
  acceptanceByArchetype: Record<string, { accepted: number; rejected: number }>;
  /** Raw signal count in the window. */
  totalSignals: number;
}

/**
 * Read aggregated preferences for a user, last 90 days. Cheap single query
 * + in-memory rollup. Callers (composer, drafter, triage) read this once
 * per turn and bias their prompt accordingly.
 */
export async function getLearnedPreferences(
  clientNumber: string,
  userId: number,
): Promise<PreferenceSummary> {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const rows = await prisma.agentAction.findMany({
    where: {
      clientNumber, userId,
      actionType: 'user_signal',
      createdAt: { gte: since },
    } as any,
    select: { output: true },
    take: 5000,
    orderBy: { createdAt: 'desc' },
  }).catch(() => [] as any[]);

  const byKind: Record<string, number> = {};
  const delegateeCounts: Record<string, number> = {};
  const acceptedTones: Record<string, number> = {};
  const acceptanceByArchetype: Record<string, { accepted: number; rejected: number }> = {};

  for (const r of rows) {
    const s: Signal | undefined = (r.output as any)?.signal;
    if (!s?.kind) continue;
    byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;

    if (s.kind === 'delegate' && s.delegateeEmail) {
      const email = s.delegateeEmail.toLowerCase();
      delegateeCounts[email] = (delegateeCounts[email] ?? 0) + 1;
    }
    if (s.kind === 'accept_draft' && s.tone) {
      acceptedTones[s.tone] = (acceptedTones[s.tone] ?? 0) + 1;
    }
    if (s.archetype && (s.kind === 'accept_draft' || s.kind === 'reject_draft')) {
      const bucket = (acceptanceByArchetype[s.archetype] ??= { accepted: 0, rejected: 0 });
      if (s.kind === 'accept_draft') bucket.accepted += 1; else bucket.rejected += 1;
    }
  }

  const preferredDelegatees = Object.entries(delegateeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([email, n]) => ({ email, n }));

  return {
    byKind,
    preferredDelegatees,
    acceptedTones,
    acceptanceByArchetype,
    totalSignals: rows.length,
  };
}

/** Compact one-paragraph rendering for insertion into an LLM prompt. */
export function renderPreferencesBlock(p: PreferenceSummary): string {
  if (p.totalSignals === 0) return '';
  const lines: string[] = [];
  lines.push('## Learned preferences (last 90 days)');
  if (p.preferredDelegatees.length > 0) {
    lines.push(`- Preferred delegatees: ${p.preferredDelegatees.slice(0, 5).map((d) => `${d.email} (${d.n}×)`).join(', ')}.`);
  }
  const tones = Object.entries(p.acceptedTones).sort((a, b) => b[1] - a[1]);
  if (tones.length > 0) {
    lines.push(`- Accepted draft tone: ${tones.map(([t, n]) => `${t} (${n})`).join(', ')}.`);
  }
  const byArch = Object.entries(p.acceptanceByArchetype);
  if (byArch.length > 0) {
    const bits = byArch.slice(0, 5).map(([a, c]) => {
      const total = c.accepted + c.rejected;
      const rate = total > 0 ? Math.round((c.accepted / total) * 100) : 0;
      return `${a}=${rate}%`;
    });
    lines.push(`- Draft acceptance by archetype: ${bits.join(', ')}.`);
  }
  return lines.join('\n');
}
