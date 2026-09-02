import prisma from '../../db/prisma';
import { renderLifecycleIntervention } from '../notifications/proactiveMessageText';
import createLogger from '../../utils/logger';
import { parseDuePhrase, saneDueDate } from '../brainPrompts/promptReplyHandler';

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

/** Section 33a thread_capture classifier: LLM only, NO deterministic
 *  fallback. Timeout, parse failure, or strict-output failure return
 *  null — the caller records a processing event and notifies the
 *  owner without mutating thread or item state. Counterpart text is
 *  untrusted data inside the prompt, never instructions. */
export async function interpretActionReplyStrict(body: string, context: {
  title: string;
  currentDueDate?: Date | null;
}): Promise<ActionReplyInterpretation | null> {
  try {
    const result = await interpretActionReplyViaLLM(body, context);
    return result; // null when the LLM output failed strict parsing
  } catch {
    return null;
  }
}

async function interpretActionReplyViaLLM(body: string, context: {
  title: string;
  currentDueDate?: Date | null;
}): Promise<ActionReplyInterpretation | null> {
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
    if (!match) return null; // strict-output failure — caller decides fallback policy
    const parsed = JSON.parse(match[0]);
    const allowed = ['completed', 'in_progress', 'blocked', 'unknown'];
    // DEF-249 — the model's date gets the SAME sanity window as a parsed phrase.
    // It used to be accepted on Number.isFinite alone, which asks "is this a date at all"
    // rather than "is this a date he could have meant". On 2026-08-27 the owner said
    // "28th October", the model supplied 2024, and the item was written due 2024-10-28 —
    // permanently overdue by two years. `saneDueDate` returns null outside the window, which
    // drops through to `parseDuePhrase(body)` below and, failing that, to the existing
    // "unparseable — ask him" path. Refusing is better than writing a date he never meant.
    const parsedDeadline = saneDueDate(parsed.newDeadline ? new Date(parsed.newDeadline) : null);
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
    log.warn('LLM reply interpretation failed', { error: error?.message });
    throw error;
  }
}

/** Legacy interpretation used by pre-33a callers: LLM first, then the
 *  deterministic fallback. thread_capture NEVER uses this — it calls
 *  interpretActionReplyStrict (no fallback). */
export async function interpretActionReply(body: string, context: {
  title: string;
  currentDueDate?: Date | null;
}): Promise<ActionReplyInterpretation> {
  try {
    const viaLlm = await interpretActionReplyViaLLM(body, context);
    if (viaLlm) return viaLlm;
  } catch { /* fall through to deterministic */ }
  log.warn('reply interpretation degraded to deterministic fallback');
  return fallbackInterpretation(body);
}

export async function recordActionLifecycleReply(input: {
  openItemId: string;
  clientNumber: string;
  body: string;
  source: 'whatsapp' | 'email' | 'user' | 'chat';
  sourceId?: string;
  interpretation?: ActionReplyInterpretation;
  /** Section 33a: 'thread_capture' fences this call to evidence-only —
   *  no transitionStatus close, no dueDate mutation, no deterministic
   *  fallback (interpretation MUST be supplied by the caller; absent ⇒
   *  handled:false rather than guessing). Confident completion is the
   *  THREAD's business (resolved_pending_owner) — the open item is not
   *  closed here. */
  mode?: 'legacy' | 'thread_capture';
}): Promise<{ handled: boolean; outcome?: string; closed?: boolean; closeBlocked?: string | null; newDueDate?: string; needsUserIntervention?: boolean }> {
  const threadCapture = input.mode === 'thread_capture';
  if (threadCapture && !input.interpretation) return { handled: false };
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
  let closeBlocked: string | null = null;

  // An explicit completion statement from the responsible person is durable
  // source evidence. A future promise ("will finish") is never accepted.
  if (interpreted.outcome === 'completed' && interpreted.completionEvidence && interpreted.confidence >= 0.7 && !threadCapture) {
    const { transitionStatus } = await import('../itemLifecycle/lifecycleService');

    // ── DEF-281 — the owner's own completion IS the approval ────────────────────────────────
    //
    // `{ from: 'NEW', to: 'CLOSED', requiresApproval: true }` exists to stop an AGENT closing an
    // untriaged item unilaterally, and this call passed `actor: 'agent:action_lifecycle'` with no
    // `approvalId` for every source. So when the owner replied "Done" to a prompt whose own words
    // offered to close the item, `lifecycleService` rejected it — `approval required` — and he was
    // told *"Actually, it looks like that still needs approval before it can be closed."*
    //
    // He is the approving authority. There is no one above him to ask, no approver was named, and
    // when he asked *"which approval?"* Brain word-matched the term against two unrelated items
    // titled "Approve new team members". A governance guard was narrated to him as a business
    // fact he could act on, and he could not: the owner was locked out of closing his own item.
    //
    // So an explicit instruction from the owner supplies the approval, and RECORDS it — who
    // approved and which instruction did it — which is more auditable than the status quo, where
    // the transition was simply impossible.
    //
    // Deliberately ONLY `source: 'user'`. A delegatee reporting completion over WhatsApp or email
    // still requires the owner's approval to close an untriaged item; that is the case the guard
    // was written for and it is untouched. There is a named test for exactly that.
    const ownerApproved = input.source === 'user' || input.source === 'chat';
    const transition = await transitionStatus(item.id, 'CLOSED', {
      clientNumber: item.clientNumber,
      actor: ownerApproved ? `user:${item.userId}` : 'agent:action_lifecycle',
      // There is no approvals table: `approvalId` is a presence token the guard checks and the
      // event carries, never a foreign key. So the id is the APPROVING USER's id — meaningful
      // rather than arbitrary — and the auditable detail (which instruction, from which source)
      // goes in `reason` and `metadata`, which are the fields actually persisted to
      // `item_status_history`.
      approvalId: ownerApproved ? item.userId : undefined,
      reason: ownerApproved
        ? `Owner reported completion and thereby approved the close (${input.source}${input.sourceId ? `:${input.sourceId}` : ''}): ${interpreted.summary}`
        : `Responsible party reported completion: ${interpreted.summary}`,
      metadata: {
        source: input.source, sourceId: input.sourceId, evidence: interpreted.completionEvidence,
        approvedBy: ownerApproved ? `user:${item.userId}` : null,
      },
    });
    closed = transition.ok || String(item.status).toUpperCase() === 'CLOSED';
    // DEF-284/DEF-282 — carry the REFUSAL out of here. Without it the caller can only tell that
    // the item is not closed, not why, and the owner asking "which approval?" gets a keyword
    // search instead of an answer.
    if (!closed) {
      closeBlocked = transition.approvalRequired
        ? 'it needs an approval this reply did not carry'
        : (transition.guardsFailed?.length
          ? `the transition is missing: ${transition.guardsFailed.join(', ')}`
          : (transition.error ?? 'the status change was refused'));
    }
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
      // thread_capture: counterpart-stated deadlines are evidence, not
      // mutations — the owner decides deadline changes.
      ...(interpreted.newDeadline && !threadCapture ? { dueDate: interpreted.newDeadline } : {}),
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
      // DEF-155 — the template moved to `proactiveMessageText` so the proactive
      // slice can score this text without running the job. Output identical.
      question: renderLifecycleIntervention({
        itemTitle: item.title,
        summary: interpreted.summary,
        delayReason: interpreted.delayReason,
      }),
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
    /** Why the close was refused, when one was attempted and did not take. */
    closeBlocked,
    newDueDate: interpreted.newDeadline?.toISOString(),
    needsUserIntervention: lifecycle.needsUserIntervention,
  };
}

export function nextDailyFollowUp(now = new Date()): Date {
  return new Date(now.getTime() + DAY_MS);
}
