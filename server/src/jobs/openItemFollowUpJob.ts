/**
 * openItemFollowUpJob — daily smart follow-up engine for active open items.
 *
 * Per user spec 2026-05-14:
 *   - Cadence: daily
 *   - Surface: follow up ALL active items including delegated
 *   - Channel: Nexeo (option A) — Brain identity only. Never via user's
 *     paired WhatsApp / Gmail Send-As (would impersonate the user;
 *     forbidden by feedback_brain_never_speaks_as_user 2026-05-14).
 *   - Communication topology: Brain talks ONLY to its own Nexeo users.
 *     For an item delegated to an EXTERNAL person (vendor / non-Nexeo),
 *     Brain nudges the OWNER (asks them to chase), not the external.
 *   - Learning: per-user. Past verdicts + dispatch outcomes logged to
 *     agent_action; LLM prompt reads recent history so it learns what
 *     this user wants done (dismissed nudges → don't suggest again,
 *     etc.).
 *
 * For each active item the engine:
 *   1. Builds context (item + age + status + due date + delegatee
 *      type + sender history + this user's prior nudge dismissals).
 *   2. Runs ONE Flash LLM call → verdict {action, reason, whenIso}.
 *   3. Dispatches verdict (or no-op for do_nothing).
 *   4. Logs verdict + dispatch result to agent_action.
 *
 * Verdict actions:
 *   - do_nothing                — item is healthy / too fresh / user
 *                                  dismissed similar before. Log only.
 *   - remind_owner              — surface on My Attention (set a flag
 *                                  in metadata.followup that the brief
 *                                  builder reads).
 *   - ask_owner_to_chase        — Auto-send Nexeo WhatsApp to OWNER
 *                                  ("Asad still pending — want to ping
 *                                  him?"). Owner decides whether to
 *                                  draft a follow-up via the email
 *                                  chase path. Brain NEVER pings the
 *                                  delegatee directly — internal or
 *                                  external. The Nexeo WhatsApp number
 *                                  is reserved for Brain↔owner only
 *                                  (user 2026-05-18:
 *                                  "this whatsapp is only for a
 *                                  communication between brain and user").
 *   - escalate                  — bump priority to high, surface on
 *                                  attention.
 *   - mark_stale                — set metadata.followup.stale=true so
 *                                  the Open Items page can filter; row
 *                                  stays active.
 *   - bump_priority             — change priority based on signals.
 *
 * Throttle: once per day per item via metadata.followup.lastVerdictAt
 * UTC-day check.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { brainContactsUser } from '../services/notifications/brainOutboundService';
import { callLLM } from '../services/llmRouter';

const log = createLogger('open-item-followup');

const ACTIVE = ['NEW', 'TRIAGED', 'IN_PROGRESS', 'DELEGATED', 'WAITING_INFO', 'SNOOZED'];
type Action =
  | 'do_nothing'
  | 'remind_owner'
  | 'ask_owner_to_chase'
  | 'escalate'
  | 'mark_stale'
  | 'bump_priority';

interface Verdict {
  action: Action;
  reason: string;
  newPriority?: 'critical' | 'high' | 'medium' | 'low';
}

interface RunResult {
  scanned: number;
  verdicts: Record<Action, number>;
  dispatched: number;
  errors: number;
}

function newResult(): RunResult {
  return {
    scanned: 0,
    verdicts: {
      do_nothing: 0, remind_owner: 0,
      ask_owner_to_chase: 0, escalate: 0, mark_stale: 0, bump_priority: 0,
    },
    dispatched: 0,
    errors: 0,
  };
}

const SYSTEM_PROMPT = `You are an executive assistant deciding what to do today about one open item on the user's list. You watch this item every day. Your job: pick ONE next move from the allowed set.

You will see:
  - the item (title, description, age in days, priority, status, due date, delegatee if any)
  - whether the delegatee is INTERNAL (a Nexeo user on this tenant) or EXTERNAL (a phone/email outside Nexeo) or NONE
  - the user's RECENT nudge history for similar items — what verdicts you gave before and how the user responded
  - sender history with the delegatee (when present)

Return STRICT JSON, no prose:
{
  "action": "do_nothing" | "remind_owner" | "ask_owner_to_chase" | "escalate" | "mark_stale" | "bump_priority",
  "reason": "one short sentence why",
  "newPriority": "critical" | "high" | "medium" | "low"   // only when action='bump_priority'
}

Rules — non-negotiable:
1. Brain NEVER messages the delegatee directly — neither internal nor external. The Nexeo WhatsApp channel is reserved for Brain↔owner communication only. When a chase is warranted, the action is ALWAYS ask_owner_to_chase, regardless of whether the delegatee is internal or external. The owner decides whether and how to nudge.
2. If the user dismissed/ignored your last 2+ verdicts on similar items, default to do_nothing this cycle. Don't be a pest.
3. mark_stale ONLY when: no activity in 14+ days, low/medium priority, no upcoming deadline. Not for high/critical items.
4. escalate is reserved for items with concrete urgency signals (deadline within 24h, money/contract context, explicit blocker). Don't escalate generic items just because they're old.
5. do_nothing is a valid and often correct answer. Healthy items don't need daily attention.
6. Brand-new items (age < 1 day) almost always → do_nothing. Let them breathe.

Examples of good calls:
  - Item age 1d, delegated to internal Asad, no movement: do_nothing (too fresh)
  - Item age 4d, delegated to internal Asad, no movement: ask_owner_to_chase
  - Item age 4d, delegated to external client, no movement: ask_owner_to_chase
  - Item age 15d, low priority, no movement, no deadline: mark_stale
  - Item age 3d, due in 18 hours, high priority: escalate
  - Item age 3d, but user dismissed 3 prior nudges on this contact: do_nothing`;

function buildUserPrompt(args: {
  item: any;
  delegateeType: 'internal' | 'external' | 'none';
  history: Array<{ action: string; outcome: string | null; daysAgo: number; itemTitle: string }>;
}): string {
  const { item, delegateeType, history } = args;
  const now = Date.now();
  const ageDays = Math.floor((now - new Date(item.createdAt).getTime()) / (24 * 60 * 60 * 1000));
  const dueIn = item.dueDate
    ? Math.round((new Date(item.dueDate).getTime() - now) / (60 * 60 * 1000))
    : null;
  const lines: string[] = [];
  lines.push('═══ ITEM ═══');
  lines.push(`Title: ${item.title}`);
  lines.push(`Description: ${item.description ?? '(none)'}`);
  lines.push(`Status: ${item.status}  Priority: ${item.priority}  Age: ${ageDays}d`);
  lines.push(`Due: ${item.dueDate ? `${item.dueDate.toISOString().slice(0, 10)} (in ${dueIn}h)` : 'none'}`);
  if (item.delegateeName || item.delegateeEmail) {
    lines.push(`Delegatee: ${item.delegateeName ?? item.delegateeEmail} (type: ${delegateeType})`);
  } else {
    lines.push(`Delegatee: none`);
  }
  lines.push('');
  lines.push('═══ THIS USER\'S RECENT NUDGE HISTORY (similar items) ═══');
  if (history.length === 0) {
    lines.push('(no prior verdicts in last 30 days)');
  } else {
    for (const h of history) {
      lines.push(`- ${h.daysAgo}d ago: action=${h.action} outcome=${h.outcome ?? 'unknown'} item="${h.itemTitle.slice(0, 60)}"`);
    }
  }
  lines.push('');
  lines.push('Pick ONE action. Output JSON only.');
  return lines.join('\n');
}

async function getRecentNudgeHistory(
  clientNumber: string, userId: number,
): Promise<Array<{ action: string; outcome: string | null; daysAgo: number; itemTitle: string }>> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await prisma.agentAction.findMany({
    where: {
      clientNumber, userId,
      actionType: 'followup_verdict',
      createdAt: { gte: since },
    } as any,
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { input: true, output: true, createdAt: true },
  }).catch(() => [] as any[]);
  return rows.map((r: any) => {
    const inp = r.input ?? {};
    const out = r.output ?? {};
    return {
      action: String(inp.verdict?.action ?? out.action ?? 'unknown'),
      outcome: out.outcome ?? null,
      daysAgo: Math.floor((Date.now() - r.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
      itemTitle: String(inp.itemTitle ?? out.itemTitle ?? ''),
    };
  });
}

async function classifyDelegateeType(
  clientNumber: string,
  item: { delegateeId: number | null; delegateeEmail: string | null },
): Promise<'internal' | 'external' | 'none'> {
  if (!item.delegateeId && !item.delegateeEmail) return 'none';
  if (item.delegateeId) return 'internal'; // resolved to a Nexeo user id at create
  // delegateeEmail set but no id — see if there's a user with that email
  if (item.delegateeEmail) {
    const u = await prisma.user.findFirst({
      where: { clientNumber, email: item.delegateeEmail.toLowerCase() },
      select: { id: true },
    }).catch(() => null);
    if (u) return 'internal';
  }
  return 'external';
}

async function judge(item: any, delegateeType: 'internal' | 'external' | 'none'): Promise<Verdict | null> {
  const history = await getRecentNudgeHistory(item.clientNumber, item.userId);
  const userPrompt = buildUserPrompt({ item, delegateeType, history });
  try {
    const r = await callLLM(SYSTEM_PROMPT, userPrompt, {
      maxTokens: 200,
      providers: ['gemini-flash', 'gemini', 'claude'],
      userId: item.userId,
      clientNumber: item.clientNumber,
      purpose: 'open_item_followup_verdict',
      timeoutMs: 10_000,
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    const action = String(obj.action ?? 'do_nothing') as Action;
    const allowed: Action[] = ['do_nothing', 'remind_owner',
      'ask_owner_to_chase', 'escalate', 'mark_stale', 'bump_priority'];
    // Backward-compat: if a previously-cached LLM response or a slow
    // rollout returns the retired nudge_internal_delegatee verdict,
    // redirect to ask_owner_to_chase so the chase still happens via
    // the owner (the only path Brain is allowed to use).
    if ((action as string) === 'nudge_internal_delegatee') {
      return {
        action: 'ask_owner_to_chase',
        reason: 'redirected from retired nudge_internal_delegatee verdict (Brain only contacts the owner)',
      };
    }
    if (!allowed.includes(action)) return null;
    return {
      action,
      reason: String(obj.reason ?? '').slice(0, 200),
      newPriority: obj.newPriority,
    };
  } catch (err: any) {
    log.warn('LLM verdict failed', { itemId: item.id, error: err.message });
    return null;
  }
}

async function dispatch(item: any, verdict: Verdict): Promise<{ ok: boolean; detail: string }> {
  switch (verdict.action) {
    case 'do_nothing': {
      return { ok: true, detail: 'no-op' };
    }
    case 'remind_owner': {
      await prisma.openItem.update({
        where: { id: item.id },
        data: {
          metadata: {
            ...(item.metadata ?? {}),
            followup: {
              ...(item.metadata?.followup ?? {}),
              remindAt: new Date().toISOString(),
              reason: verdict.reason,
            },
          } as any,
        } as any,
      });
      return { ok: true, detail: 'flagged for My Attention' };
    }
    // case 'nudge_internal_delegatee' — RETIRED 2026-05-18.
    // Brain MUST NOT message the delegatee directly. The Nexeo
    // WhatsApp channel is reserved for Brain↔owner only. Any verdict
    // that would have landed here is redirected to ask_owner_to_chase
    // in the parser; this case is intentionally absent so the
    // dispatcher would error out if a redirect ever failed (defense
    // in depth against accidental reintroduction).
    case 'ask_owner_to_chase': {
      const who = item.delegateeName ?? item.delegateeEmail ?? 'the delegatee';
      const ageDays = Math.floor((Date.now() - new Date(item.createdAt).getTime()) / (24 * 60 * 60 * 1000));
      const { phraseOwnerChase, addressUser, rememberPending } = await import('../services/notifications/brainHumanComm');
      const userFirstName = await addressUser(item.userId);
      const body = phraseOwnerChase({
        userFirstName,
        delegateeName: who,
        itemTitle: item.title,
        ageDays,
        itemId: item.id,
      });
      const r = await brainContactsUser({
        userId: item.userId,
        kind: 'open_item_owner_chase_prompt',
        summary: `Chase prompt: "${item.title.slice(0, 60)}" delegated to ${who}`,
        body,
        dedupKey: `followup_chase:${item.id}:${new Date().toISOString().slice(0, 10)}`,
      });
      if (r.sent) {
        // Owner's "yes draft it" / "no skip" replies resolve here.
        await rememberPending(item.userId, {
          kind: 'open_item_owner_chase',
          refId: item.id,
          refTitle: item.title,
          meta: { delegateeName: who, delegateeEmail: item.delegateeEmail, ageDays },
        });
      }
      return {
        ok: r.sent,
        detail: r.sent ? 'asked owner to chase' : (r.reason ?? 'send blocked'),
      };
    }
    case 'escalate': {
      await prisma.openItem.update({
        where: { id: item.id },
        data: {
          priority: 'high',
          metadata: {
            ...(item.metadata ?? {}),
            followup: {
              ...(item.metadata?.followup ?? {}),
              escalatedAt: new Date().toISOString(),
              reason: verdict.reason,
            },
          } as any,
        } as any,
      });
      return { ok: true, detail: 'priority bumped to high + flagged' };
    }
    case 'mark_stale': {
      await prisma.openItem.update({
        where: { id: item.id },
        data: {
          metadata: {
            ...(item.metadata ?? {}),
            followup: {
              ...(item.metadata?.followup ?? {}),
              stale: true,
              staleAt: new Date().toISOString(),
              reason: verdict.reason,
            },
          } as any,
        } as any,
      });
      return { ok: true, detail: 'marked stale' };
    }
    case 'bump_priority': {
      const newPri = verdict.newPriority ?? 'high';
      await prisma.openItem.update({
        where: { id: item.id },
        data: { priority: newPri } as any,
      });
      return { ok: true, detail: `priority -> ${newPri}` };
    }
  }
}

function alreadyJudgedToday(item: any, now: Date): boolean {
  const last = item.metadata?.followup?.lastVerdictAt;
  if (!last) return false;
  return String(last).slice(0, 10) === now.toISOString().slice(0, 10);
}

export async function runOpenItemFollowUp(): Promise<RunResult> {
  const result = newResult();
  const now = new Date();

  // Pull owner's email separately via a join — we only need it to
  // address the user by first-name in the nudge text. Phone resolution
  // happens inside brainContactsUser, so we don't fetch it here.
  const items = await prisma.openItem.findMany({
    where: { status: { in: ACTIVE } as any } as any,
    select: {
      id: true, title: true, description: true, status: true, priority: true,
      dueDate: true, createdAt: true, metadata: true,
      clientNumber: true, userId: true,
      delegateeId: true, delegateeName: true, delegateeEmail: true,
    } as any,
    take: 500,
  }) as any[];
  // Batch-fetch owner emails for the items we'll be processing.
  const ownerIds = Array.from(new Set(items.map((i: any) => i.userId)));
  const owners = ownerIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, email: true },
      }).catch(() => [] as Array<{ id: number; email: string }>)
    : [];
  const ownerEmailById = new Map<number, string>(owners.map((u: any) => [u.id, u.email]));
  for (const it of items) {
    (it as any).owner = { email: ownerEmailById.get(it.userId) ?? null };
  }

  for (const item of items) {
    result.scanned += 1;
    if (alreadyJudgedToday(item, now)) continue;

    try {
      const delegateeType = await classifyDelegateeType(item.clientNumber, {
        delegateeId: item.delegateeId,
        delegateeEmail: item.delegateeEmail,
      });
      const verdict = await judge(item, delegateeType);
      if (!verdict) { result.errors += 1; continue; }
      result.verdicts[verdict.action] += 1;

      const disp = await dispatch(item, verdict);
      if (disp.ok && verdict.action !== 'do_nothing') result.dispatched += 1;

      // Log verdict + dispatch to agent_action for the learning loop.
      await prisma.agentAction.create({
        data: {
          clientNumber: item.clientNumber,
          userId: item.userId,
          actionType: 'followup_verdict',
          status: 'done',
          requiresApproval: false,
          executedByAgent: 'open_item_followup',
          riskTier: 'LOW',
          input: {
            openItemId: item.id,
            itemTitle: item.title,
            verdict,
          } as any,
          output: {
            action: verdict.action,
            reason: verdict.reason,
            dispatchOk: disp.ok,
            dispatchDetail: disp.detail,
          } as any,
        } as any,
      }).catch(() => null);

      // Stamp lastVerdictAt so the throttle holds.
      await prisma.openItem.update({
        where: { id: item.id },
        data: {
          metadata: {
            ...(item.metadata ?? {}),
            followup: {
              ...(item.metadata?.followup ?? {}),
              lastVerdictAt: now.toISOString(),
              lastAction: verdict.action,
              lastReason: verdict.reason,
            },
          } as any,
        } as any,
      }).catch(() => null);
    } catch (err: any) {
      result.errors += 1;
      log.warn('Followup iteration error', { itemId: item.id, error: err.message });
    }
  }

  return result;
}
