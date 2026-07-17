import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { parseDuePhrase } from '../brainPrompts/promptReplyHandler';

const log = createLogger('action-lifecycle');
const DAY_MS = 24 * 60 * 60 * 1000;

export type ActionLifecyclePhase =
  | 'needs_deadline'
  | 'monitoring'
  | 'awaiting_status'
  | 'awaiting_commitment'
  | 'verification'
  | 'blocked'
  | 'escalated'
  | 'completed';

export interface ActionLifecycleState {
  version: 1;
  phase: ActionLifecyclePhase;
  nextFollowUpAt?: string | null;
  lastContactAt?: string | null;
  lastResponseAt?: string | null;
  lastContactChannel?: string | null;
  unansweredAttempts: number;
  missedCommitments: number;
  lastMissedDueDate?: string | null;
  currentDelayReason?: string | null;
  needsUserIntervention?: boolean;
  interventionReason?: string | null;
  escalatedAt?: string | null;
  escalationCount?: number;
  commitmentHistory: Array<{
    at: string;
    dueDate: string;
    reason?: string | null;
    source: string;
  }>;
  followUpHistory: Array<{
    at: string;
    event: string;
    channel?: string;
    summary?: string;
    sourceId?: string;
  }>;
}

export type LifecycleAction =
  | 'none'
  | 'ask_deadline'
  | 'ask_status'
  | 'ask_completion_evidence'
  | 'escalate_user';

export interface LifecyclePlan {
  action: LifecycleAction;
  audience: 'concerned_party' | 'owner';
  reason: string;
  nextFollowUpAt?: Date;
}

export interface LifecycleItemLike {
  status: string;
  dueDate: Date | string | null;
  priority?: string | null;
  delegateeId?: number | null;
  delegateeName?: string | null;
  delegateeEmail?: string | null;
  metadata?: any;
}

export interface ActionReplyInterpretation {
  outcome: 'completed' | 'in_progress' | 'blocked' | 'unknown';
  summary: string;
  newDeadline: Date | null;
  delayReason: string | null;
  completionEvidence: string | null;
  needsUserIntervention: boolean;
  confidence: number;
}

function boundedHistory<T>(rows: T[], max = 40): T[] {
  return rows.slice(-max);
}

export function readActionLifecycle(metadata: any): ActionLifecycleState {
  const raw = metadata?.actionLifecycle ?? {};
  return {
    version: 1,
    phase: raw.phase ?? 'monitoring',
    nextFollowUpAt: raw.nextFollowUpAt ?? null,
    lastContactAt: raw.lastContactAt ?? null,
    lastResponseAt: raw.lastResponseAt ?? null,
    lastContactChannel: raw.lastContactChannel ?? null,
    unansweredAttempts: Math.max(0, Number(raw.unansweredAttempts ?? 0)),
    missedCommitments: Math.max(0, Number(raw.missedCommitments ?? 0)),
    lastMissedDueDate: raw.lastMissedDueDate ?? null,
    currentDelayReason: raw.currentDelayReason ?? null,
    needsUserIntervention: raw.needsUserIntervention === true,
    interventionReason: raw.interventionReason ?? null,
    escalatedAt: raw.escalatedAt ?? null,
    escalationCount: Math.max(0, Number(raw.escalationCount ?? 0)),
    commitmentHistory: Array.isArray(raw.commitmentHistory) ? raw.commitmentHistory : [],
    followUpHistory: Array.isArray(raw.followUpHistory) ? raw.followUpHistory : [],
  };
}

function isTerminal(status: string): boolean {
  return ['closed', 'done', 'archived', 'informed'].includes(String(status).toLowerCase());
}

function concernedPartyExists(item: LifecycleItemLike): boolean {
  return !!(item.delegateeId || item.delegateeName || item.delegateeEmail);
}

/** Deterministic policy. The LLM may phrase messages and interpret replies;
 * it never decides whether an overdue action loop silently stops. */
export function planActionLifecycle(item: LifecycleItemLike, now = new Date()): LifecyclePlan {
  if (isTerminal(item.status) || item.metadata?.selfPrune?.suppressProactive === true) {
    return { action: 'none', audience: 'owner', reason: 'terminal_or_suppressed' };
  }
  const state = readActionLifecycle(item.metadata);
  const audience = concernedPartyExists(item) ? 'concerned_party' : 'owner';
  const escalatedRecently = state.escalatedAt
    && now.getTime() - new Date(state.escalatedAt).getTime() < DAY_MS;
  if (
    !escalatedRecently
    && (state.needsUserIntervention || state.unansweredAttempts >= 3 || state.missedCommitments >= 2)
  ) {
    return {
      action: 'escalate_user', audience: 'owner',
      reason: state.interventionReason
        ?? (state.unansweredAttempts >= 3 ? 'concerned party has not responded after three attempts' : 'repeated missed commitments'),
    };
  }

  const next = state.nextFollowUpAt ? new Date(state.nextFollowUpAt) : null;
  if (next && Number.isFinite(next.getTime()) && next.getTime() > now.getTime()) {
    return { action: 'none', audience, reason: 'next_follow_up_not_due', nextFollowUpAt: next };
  }

  if (!item.dueDate) {
    return { action: 'ask_deadline', audience, reason: 'no_committed_deadline' };
  }
  const due = new Date(item.dueDate);
  if (due.getTime() > now.getTime()) {
    return { action: 'none', audience, reason: 'monitoring_until_deadline', nextFollowUpAt: due };
  }
  if (state.phase === 'verification') {
    return { action: 'ask_completion_evidence', audience, reason: 'completion_requires_evidence' };
  }
  return { action: 'ask_status', audience, reason: 'deadline_reached_or_overdue' };
}

function fallbackInterpretation(body: string): ActionReplyInterpretation {
  const text = body.trim();
  const completed = /\b(done|completed|complete|finished|delivered|submitted|resolved|closed|sent|provided|handed over)\b/i.test(text)
    && !/\b(not|isn'?t|wasn'?t|haven'?t|pending|will|tomorrow|next)\b.{0,18}\b(done|complete|finished|delivered)\b/i.test(text);
  const blocked = /\b(blocked|stuck|waiting (?:for|on)|cannot proceed|can'?t proceed|dependency|approval needed|need approval)\b/i.test(text);
  const newDeadline = parseDuePhrase(text);
  const reasonMatch = text.match(/(?:because|due to|reason(?: is)?|delayed by)\s+([^.!?]{3,240})/i);
  return {
    outcome: completed ? 'completed' : blocked ? 'blocked' : 'in_progress',
    summary: text.slice(0, 500),
    newDeadline,
    delayReason: reasonMatch?.[1]?.trim() ?? (blocked ? text.slice(0, 300) : null),
    completionEvidence: completed ? text.slice(0, 500) : null,
    needsUserIntervention: blocked && /\b(approval|decision|access|budget|payment|authority|sign.?off)\b/i.test(text),
    confidence: completed || blocked || newDeadline ? 0.8 : 0.55,
  };
}

export async function interpretActionReply(body: string, context: {
  title: string;
  currentDueDate?: Date | null;
}): Promise<ActionReplyInterpretation> {
  try {
    const { callLLM } = await import('../llmRouter');
    const r = await callLLM(
      `Classify a responsible person's status reply for one tracked action. Return ONLY JSON:
{"outcome":"completed|in_progress|blocked|unknown","summary":"short factual summary","newDeadline":"ISO date or null","delayReason":"string or null","completionEvidence":"explicit delivered/completed evidence or null","needsUserIntervention":true|false,"confidence":0-1}
Rules: a future promise is not completion; preserve concrete dates/reasons; flag intervention for authority, approval, budget, access, conflict, or repeated dependency.`,
      `Action: ${context.title}\nCurrent deadline: ${context.currentDueDate?.toISOString() ?? 'none'}\nReply: ${body.slice(0, 2000)}`,
      { maxTokens: 260, providers: ['gemini-flash', 'gemini', 'claude'], purpose: 'action_lifecycle_reply' },
    );
    const match = r.text.match(/\{[\s\S]*\}/);
    if (!match) return fallbackInterpretation(body);
    const parsed = JSON.parse(match[0]);
    const allowed = ['completed', 'in_progress', 'blocked', 'unknown'];
    const parsedDeadline = parsed.newDeadline ? new Date(parsed.newDeadline) : null;
    return {
      outcome: allowed.includes(parsed.outcome) ? parsed.outcome : 'unknown',
      summary: String(parsed.summary ?? body).slice(0, 500),
      newDeadline: parsedDeadline && Number.isFinite(parsedDeadline.getTime()) ? parsedDeadline : parseDuePhrase(body),
      delayReason: parsed.delayReason ? String(parsed.delayReason).slice(0, 500) : null,
      completionEvidence: parsed.completionEvidence ? String(parsed.completionEvidence).slice(0, 1000) : null,
      needsUserIntervention: parsed.needsUserIntervention === true,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5))),
    };
  } catch (error: any) {
    log.warn('reply interpretation degraded to deterministic fallback', { error: error?.message });
    return fallbackInterpretation(body);
  }
}

export async function recordActionLifecycleReply(input: {
  openItemId: string;
  clientNumber: string;
  body: string;
  source: 'whatsapp' | 'email' | 'user' | 'chat';
  sourceId?: string;
  interpretation?: ActionReplyInterpretation;
}): Promise<{ handled: boolean; outcome?: string; closed?: boolean; newDueDate?: string; needsUserIntervention?: boolean }> {
  const item = await prisma.openItem.findFirst({ where: { id: input.openItemId, clientNumber: input.clientNumber } });
  if (!item) return { handled: false };
  const now = new Date();
  const interpreted = input.interpretation ?? await interpretActionReply(input.body, {
    title: item.title,
    currentDueDate: item.dueDate,
  });
  const state = readActionLifecycle(item.metadata);
  const event = {
    at: now.toISOString(), event: 'response_received',
    summary: interpreted.summary, sourceId: input.sourceId,
  };
  const notes = Array.isArray(item.notes) ? item.notes as any[] : [];
  const note = {
    at: now.toISOString(), by: 'action_lifecycle', source: input.source,
    sourceId: input.sourceId ?? null, outcome: interpreted.outcome,
    summary: interpreted.summary, delayReason: interpreted.delayReason,
    newDeadline: interpreted.newDeadline?.toISOString() ?? null,
    completionEvidence: interpreted.completionEvidence,
  };

  let phase: ActionLifecyclePhase = 'awaiting_commitment';
  let nextFollowUpAt: string | null = new Date(now.getTime() + DAY_MS).toISOString();
  let closed = false;

  // An explicit completion statement from the responsible person is durable
  // source evidence. A future promise ("will finish") is never accepted.
  if (interpreted.outcome === 'completed' && interpreted.completionEvidence && interpreted.confidence >= 0.7) {
    const { transitionStatus } = await import('../itemLifecycle/lifecycleService');
    const transition = await transitionStatus(item.id, 'CLOSED', {
      clientNumber: item.clientNumber,
      actor: 'agent:action_lifecycle',
      reason: `Responsible party reported completion: ${interpreted.summary}`,
      metadata: { source: input.source, sourceId: input.sourceId, evidence: interpreted.completionEvidence },
    });
    closed = transition.ok || String(item.status).toUpperCase() === 'CLOSED';
    phase = closed ? 'completed' : 'verification';
    nextFollowUpAt = closed ? null : new Date(now.getTime() + DAY_MS).toISOString();
  } else if (interpreted.outcome === 'blocked') {
    phase = 'blocked';
  } else if (interpreted.newDeadline) {
    phase = 'monitoring';
    nextFollowUpAt = interpreted.newDeadline.toISOString();
  }

  const commitments = interpreted.newDeadline
    ? boundedHistory([...state.commitmentHistory, {
        at: now.toISOString(), dueDate: interpreted.newDeadline.toISOString(),
        reason: interpreted.delayReason, source: input.source,
      }])
    : state.commitmentHistory;
  const lifecycle: ActionLifecycleState = {
    ...state,
    phase,
    nextFollowUpAt,
    lastResponseAt: now.toISOString(),
    unansweredAttempts: 0,
    currentDelayReason: interpreted.delayReason,
    needsUserIntervention: interpreted.needsUserIntervention || interpreted.outcome === 'blocked',
    interventionReason: interpreted.needsUserIntervention || interpreted.outcome === 'blocked'
      ? (interpreted.delayReason ?? interpreted.summary)
      : null,
    commitmentHistory: commitments,
    followUpHistory: boundedHistory([...state.followUpHistory, event]),
  };

  await prisma.openItem.update({
    where: { id: item.id },
    data: {
      ...(interpreted.newDeadline ? { dueDate: interpreted.newDeadline } : {}),
      notes: boundedHistory([...notes, note], 100) as any,
      metadata: { ...((item.metadata as any) ?? {}), actionLifecycle: lifecycle } as any,
    },
  });

  // A blocker requiring authority/approval is not deferred to tomorrow's
  // sweep. Surface it to the owner immediately through the sequential prompt
  // queue; the stable daily key prevents repeated alerts for the same state.
  if (lifecycle.needsUserIntervention && !closed) {
    const { enqueueBrainPrompt } = await import('../brainPrompts/brainPromptQueueService');
    await enqueueBrainPrompt({
      userId: item.userId,
      clientNumber: item.clientNumber,
      question: `Intervention needed on "${item.title}". ${interpreted.summary}${interpreted.delayReason ? ` Delay reason: ${interpreted.delayReason}.` : ''} Please decide whether to remove the blocker, contact the responsible person, reassign it, or set a new deadline.`,
      openItemId: item.id,
      sideEffect: { kind: 'action_status_update', openItemId: item.id },
      criticality: 'high',
      dedupKey: `action_intervention:${item.id}:${now.toISOString().slice(0, 10)}`,
      metadata: { source: 'action_lifecycle_reply', sourceId: input.sourceId, outcome: interpreted.outcome },
    }).catch((error: any) => log.warn('immediate intervention prompt failed', { error: error.message }));
  }

  return {
    handled: true,
    outcome: interpreted.outcome,
    closed,
    newDueDate: interpreted.newDeadline?.toISOString(),
    needsUserIntervention: lifecycle.needsUserIntervention,
  };
}

export function nextDailyFollowUp(now = new Date()): Date {
  return new Date(now.getTime() + DAY_MS);
}
