/**
 * Rule-Engine Gate.
 *
 * Deterministic pre-filter that runs before the Brain (LLM) on every
 * inbound feed event. Three layers of rules — system (ships with MyOS),
 * tenant (admin-defined), user. User > tenant > system.
 *
 * Use it like this:
 *
 *   const decision = await evaluateGate({ clientNumber, userId, event });
 *   if (decision) {
 *     // recordFiring + execute decision; skip Brain entirely
 *   } else {
 *     // fall through to criticality engine + LLM
 *   }
 *
 * Predicate is a tiny JSON DSL — see Predicate type below. Boolean
 * composition via { all: [...] }, { any: [...] }, { not: ... }. Atomic
 * conditions are { field, op, value }.
 *
 * Why not a full rules language: every gate evaluation is on the hot
 * path of feed ingestion. A boring DSL is fast, deterministic, and
 * round-trips to JSON cleanly for storage + admin UI editing.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { getOrCompute } from '../../utils/redisClient';

const log = createLogger('rule-engine');

// ─── DSL types ────────────────────────────────────────────────────

export type PredicateField =
  | 'sender_email' | 'sender_domain' | 'sender_name'
  | 'subject' | 'body_preview'
  | 'source_type' | 'event_type'
  | 'recipient_count' | 'is_cc_only' | 'has_attachment'
  | 'time_of_day_hour' | 'day_of_week'
  | 'sentiment_score' | 'urgency_score' | 'tone'
  | 'importance_stars';

export type PredicateOp =
  | 'equals' | 'notEquals'
  | 'contains' | 'notContains'
  | 'startsWith' | 'endsWith'
  | 'matches'    // regex
  | 'in' | 'notIn'
  | 'gt' | 'lt' | 'between';

export interface AtomicCondition {
  field: PredicateField;
  op: PredicateOp;
  value: unknown;
  /** When true: case-sensitive; default false for string ops. */
  caseSensitive?: boolean;
}
export interface AllCondition { all: Predicate[]; }
export interface AnyCondition { any: Predicate[]; }
export interface NotCondition { not: Predicate; }
export type Predicate = AtomicCondition | AllCondition | AnyCondition | NotCondition;

export type Decision =
  | 'auto_handle'  // execute the action.openItemAction; skip Brain
  | 'auto_ack'     // log only; do not surface
  | 'defer'        // snooze for action.snoozeHours; re-eval later
  | 'escalate'     // bump priority + still pass through
  | 'block';       // reject (spam/blocklist) — no further processing

export interface ActionShape {
  decision: Decision;
  /** What to do with any open_item created from this event. */
  openItemAction?: 'archive' | 'close' | 'tag' | 'snooze' | 'tag_and_close' | null;
  tags?: string[];
  snoozeHours?: number;
  escalateToUserId?: number;
  /** When set, log a one-line note instead of creating an open_item. */
  ackNote?: string;
}

export interface FeedEventForGate {
  id: string;
  sourceType: string;
  eventType: string | null;
  senderEmail: string | null;
  senderName: string | null;
  recipientCount?: number;
  isCcOnly?: boolean;
  hasAttachment?: boolean;
  subject?: string;
  bodyPreview?: string;
  receivedAt?: Date;
  /** Pre-classified sentiment + urgency from sentimentService. Optional —
   *  many on-event evaluations run before the analyzer has finished, in
   *  which case rules referencing these fields just don't match. */
  sentimentScore?: number | null;
  urgencyScore?: number | null;
  tone?: string | null;
  /** Per-user importance stars (0..5) for the sender — read by gate
   *  engine so rules can match e.g. "5-star sender" → never auto-handle. */
  importanceStars?: number;
}

export interface GateMatch {
  decision: Decision;
  ruleId: number;
  ruleKey: string | null;
  ruleName: string;
  ruleScope: 'system' | 'tenant' | 'user';
  action: ActionShape;
  reason: string;
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Evaluate the rule engine against a feed event. Returns the first
 * matching rule's decision, or null when no rule matched (fall through
 * to Brain). Rules are evaluated in priority order, with user > tenant
 * > system as the tiebreak.
 */
export async function evaluateGate(input: {
  clientNumber: string;
  userId: number;
  event: FeedEventForGate;
}): Promise<GateMatch | null> {
  const { clientNumber, userId, event } = input;
  const rules = await loadRulesFor(clientNumber, userId);
  if (rules.length === 0) return null;
  const ctx = buildEvaluationContext(event);

  for (const rule of rules) {
    try {
      if (matches(rule.predicate as Predicate, ctx)) {
        const action = rule.action as ActionShape;
        await recordFiring({
          ruleId: rule.id,
          ruleKey: rule.ruleKey,
          ruleName: rule.name,
          ruleScope: rule.scope as 'system' | 'tenant' | 'user',
          clientNumber, userId,
          feedEventId: event.id,
          decision: action.decision,
        });
        return {
          decision: action.decision,
          ruleId: rule.id,
          ruleKey: rule.ruleKey,
          ruleName: rule.name,
          ruleScope: rule.scope as 'system' | 'tenant' | 'user',
          action,
          reason: `Rule "${rule.name}" matched`,
        };
      }
    } catch (err: any) {
      // A malformed predicate shouldn't take down the gate. Log and
      // continue evaluating; admin will see the rule as never-firing
      // and can fix it.
      log.warn('rule predicate eval failed', { ruleId: rule.id, error: err.message });
    }
  }
  return null;
}

/**
 * Pure predicate matcher — exported so admin UI can preview matches
 * against historical events without writing to the firings audit table.
 */
export function matches(pred: Predicate, ctx: Record<string, unknown>): boolean {
  if ('all' in pred) return pred.all.every((p) => matches(p, ctx));
  if ('any' in pred) return pred.any.some((p) => matches(p, ctx));
  if ('not' in pred) return !matches(pred.not, ctx);
  return matchAtom(pred, ctx);
}

// ─── Loading + caching ────────────────────────────────────────────

/**
 * Load every rule that applies to (clientNumber, userId), sorted by
 * (priority, scope-tiebreak). Cached for 60s — admin edits invalidate
 * the cache via invalidateRuleCache().
 *
 * The scope tiebreak: when two rules share priority, user > tenant >
 * system. Implemented by sorting on a numeric scope rank.
 */
async function loadRulesFor(clientNumber: string, userId: number): Promise<RuleRow[]> {
  const cacheKey = `gate-rules:${clientNumber}:${userId}`;
  return getOrCompute(cacheKey, 60, async () => {
    // Disabled rule_keys for this scope.
    const overrides = await prisma.gateRuleOverride.findMany({
      where: {
        OR: [
          { clientNumber, scope: 'tenant' },
          { clientNumber, scope: 'user', userId },
        ],
        disabled: true,
      },
      select: { ruleKey: true },
    });
    const disabledKeys = new Set(overrides.map((o) => o.ruleKey));

    const rules = await prisma.gateRule.findMany({
      where: {
        enabled: true,
        OR: [
          // System rules: applies to all tenants by convention. We
          // store with client_number = NULL.
          { scope: 'system', clientNumber: null },
          // Tenant rules: enforce tenant scope.
          { scope: 'tenant', clientNumber },
          // User rules: only the requesting user's.
          { scope: 'user', clientNumber, userId },
        ],
      },
    });

    const filtered = rules.filter((r) => !(r.ruleKey && disabledKeys.has(r.ruleKey))) as unknown as RuleRow[];
    filtered.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return scopeRank(a.scope) - scopeRank(b.scope);
    });
    return filtered;
  });
}

interface RuleRow {
  id: number;
  scope: string;
  ruleKey: string | null;
  name: string;
  priority: number;
  predicate: unknown;
  action: unknown;
}

function scopeRank(scope: string): number {
  // Lower = wins ties. user beats tenant beats system.
  return scope === 'user' ? 0 : scope === 'tenant' ? 1 : 2;
}

/** Bust the rules cache for one tenant+user. Called from admin/user write paths. */
export async function invalidateRuleCache(clientNumber: string, userId?: number): Promise<void> {
  const { invalidate } = await import('../../utils/redisClient');
  if (userId !== undefined) {
    await invalidate(`gate-rules:${clientNumber}:${userId}`).catch(() => {});
  } else {
    // Bust every user's cache for this tenant — admin changed a tenant rule.
    await invalidate(`gate-rules:${clientNumber}:*`).catch(() => {});
  }
}

// ─── Atomic op evaluation ─────────────────────────────────────────

function buildEvaluationContext(e: FeedEventForGate): Record<string, unknown> {
  const senderEmail = (e.senderEmail ?? '').toLowerCase();
  const domain = senderEmail.includes('@') ? senderEmail.split('@')[1] : '';
  const recvAt = e.receivedAt ?? new Date();
  return {
    sender_email: senderEmail,
    sender_domain: domain,
    sender_name: (e.senderName ?? '').toLowerCase(),
    subject: (e.subject ?? '').toLowerCase(),
    body_preview: (e.bodyPreview ?? '').toLowerCase(),
    source_type: e.sourceType,
    event_type: e.eventType ?? '',
    recipient_count: e.recipientCount ?? 1,
    is_cc_only: !!e.isCcOnly,
    has_attachment: !!e.hasAttachment,
    time_of_day_hour: recvAt.getHours(),
    day_of_week: recvAt.getDay(), // 0=Sun
    sentiment_score: e.sentimentScore ?? 0,
    urgency_score: e.urgencyScore ?? 0,
    tone: (e.tone ?? '').toLowerCase(),
    importance_stars: e.importanceStars ?? 0,
  };
}

function matchAtom(c: AtomicCondition, ctx: Record<string, unknown>): boolean {
  const raw = ctx[c.field];
  // String ops normalize; numeric/boolean ops compare directly.
  switch (c.op) {
    case 'equals':     return cmpEquals(raw, c.value, c.caseSensitive);
    case 'notEquals':  return !cmpEquals(raw, c.value, c.caseSensitive);
    case 'contains':   return strOp(raw, c.value, c.caseSensitive, (h, n) => h.includes(n));
    case 'notContains':return !strOp(raw, c.value, c.caseSensitive, (h, n) => h.includes(n));
    case 'startsWith': return strOp(raw, c.value, c.caseSensitive, (h, n) => h.startsWith(n));
    case 'endsWith':   return strOp(raw, c.value, c.caseSensitive, (h, n) => h.endsWith(n));
    case 'matches': {
      try {
        const flags = c.caseSensitive ? '' : 'i';
        const re = new RegExp(String(c.value ?? ''), flags);
        return re.test(String(raw ?? ''));
      } catch { return false; }
    }
    case 'in':    return Array.isArray(c.value) && c.value.some((v) => cmpEquals(raw, v, c.caseSensitive));
    case 'notIn': return Array.isArray(c.value) && !c.value.some((v) => cmpEquals(raw, v, c.caseSensitive));
    case 'gt':    return Number(raw) > Number(c.value);
    case 'lt':    return Number(raw) < Number(c.value);
    case 'between': {
      if (!Array.isArray(c.value) || c.value.length !== 2) return false;
      const n = Number(raw);
      return n >= Number(c.value[0]) && n <= Number(c.value[1]);
    }
    default: return false;
  }
}

function cmpEquals(raw: unknown, value: unknown, caseSensitive?: boolean): boolean {
  if (typeof raw === 'string' && typeof value === 'string' && !caseSensitive) {
    return raw.toLowerCase() === value.toLowerCase();
  }
  return raw === value;
}

function strOp(raw: unknown, value: unknown, caseSensitive: boolean | undefined,
               fn: (h: string, n: string) => boolean): boolean {
  let h = String(raw ?? '');
  let n = String(value ?? '');
  if (!caseSensitive) { h = h.toLowerCase(); n = n.toLowerCase(); }
  return fn(h, n);
}

// ─── Telemetry ────────────────────────────────────────────────────

interface FiringInput {
  ruleId: number;
  ruleKey: string | null;
  ruleName: string;
  ruleScope: 'system' | 'tenant' | 'user';
  clientNumber: string;
  userId: number;
  feedEventId: string;
  decision: Decision;
}

async function recordFiring(input: FiringInput): Promise<void> {
  // Write the firing row + bump the rule's fire_count in one transaction
  // so the cost-dashboard "rules saved $X" counter stays consistent.
  try {
    await prisma.$transaction([
      prisma.gateRuleFiring.create({
        data: {
          ruleId: input.ruleId,
          ruleKey: input.ruleKey ?? null,
          ruleName: input.ruleName,
          ruleScope: input.ruleScope,
          clientNumber: input.clientNumber,
          userId: input.userId,
          feedEventId: input.feedEventId,
          decision: input.decision,
        },
      }),
      prisma.gateRule.update({
        where: { id: input.ruleId },
        data: { fireCount: { increment: 1 }, lastFiredAt: new Date() },
      }),
    ]);
  } catch (err: any) {
    log.warn('record firing failed', { ruleId: input.ruleId, error: err.message });
  }
}
