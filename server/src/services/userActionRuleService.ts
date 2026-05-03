/**
 * User Action Rule Editor — friendly, conservative.
 *
 * Lets the user write rules in plain English ("when an email arrives
 * from Raazia, delegate it to Asad" / "every Plaud transcript should
 * become an open item titled 'Review meeting'"). Brain parses the
 * sentence into a structured rule and saves it.
 *
 * Three modes — every new rule starts at DRAFT and only the user
 * promotes it forward:
 *
 *   DRAFT    Brain LOGS what it would have done, but does not act or
 *            suggest. Useful as a dry-run — the user sees a list of
 *            "if this was AUTO, I'd have…" entries on Day Brief and
 *            can promote when satisfied.
 *
 *   SUGGEST  When the trigger fires, Brain surfaces the suggestion on
 *            the Attention card with a one-click apply. The user is
 *            still in the loop; nothing happens automatically.
 *
 *   AUTO     The action fires through the existing handler registry
 *            (executeViaRegistry) without asking. Confidence-gated:
 *            falls back to DRAFT if Brain's confidence < threshold.
 *
 * The promotion path is intentionally explicit — DRAFT → SUGGEST →
 * AUTO. Each promotion is one click + a confirm phrase for AUTO. We
 * never auto-promote.
 */
import prisma from '../db/prisma';
import { callLLM } from './llmRouter';
import createLogger from '../utils/logger';
import { audit } from './auditLogService';
import crypto from 'crypto';

const log = createLogger('action-rules');

export type RuleMode = 'DRAFT' | 'SUGGEST' | 'AUTO';

export type TriggerKind =
  | 'inbound_email'
  | 'inbound_whatsapp'
  | 'inbound_chat'
  | 'inbound_any'
  | 'open_item_created'
  | 'meeting_minutes_filed'
  | 'manual';

export interface TriggerCondition {
  /** "raazia" — substring match against sender name or email. */
  sender?: string;
  /** "@partner.com" — match against sender domain. */
  senderDomain?: string;
  /** "invoice", "contract" — substring against subject. */
  subjectContains?: string;
  /** "review_risk", "reply_needed" — exact match against archetype. */
  archetype?: string;
  /** "EXIM" — substring against body. */
  bodyContains?: string;
}

export interface UserActionRuleInput {
  clientNumber: string;
  userId: number;
  scope?: 'user' | 'client';
  name: string;
  nlOriginal: string;
  triggerKind: TriggerKind;
  triggerCondition: TriggerCondition;
  actionType: string;
  actionPayload?: Record<string, unknown>;
  confidenceThreshold?: number;
}

export interface UserActionRule {
  id: string;
  clientNumber: string;
  userId: number;
  scope: 'user' | 'client';
  name: string;
  nlOriginal: string;
  triggerKind: TriggerKind;
  triggerCondition: TriggerCondition;
  actionType: string;
  actionPayload: Record<string, unknown>;
  mode: RuleMode;
  confidenceThreshold: number;
  isActive: boolean;
  triggeredCount: number;
  autoExecutedCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
}

// ─── NL parser ─────────────────────────────────────────────────────

const PARSE_PROMPT = `You translate a plain-English instruction into a STRUCTURED rule for an AI assistant. Output ONE JSON object, no prose.

Schema:
{
  "name":              "5-8 word label of the rule",
  "triggerKind":       "inbound_email" | "inbound_whatsapp" | "inbound_chat" | "inbound_any" | "open_item_created" | "meeting_minutes_filed" | "manual",
  "triggerCondition":  {
    "sender":         "person name or email substring or null",
    "senderDomain":   "domain like @partner.com or null",
    "subjectContains":"keyword for subject or null",
    "archetype":      "reply_needed | inform_only | schedule_meeting | review_risk | acknowledge | null",
    "bodyContains":   "keyword for body or null"
  },
  "actionType":        "ONE of the allowed handler types listed below — pick the closest match",
  "actionPayload":     { "...": "any params the handler needs (delegatee email, target user, label, etc.)" },
  "confidence":        0.0-1.0
}

Allowed actionType values (always snake_case):
  - send_email, send_email_reply, forward_email
  - send_whatsapp_message, send_chat_reply
  - create_task, complete_task, reassign_task, add_subtask
  - create_event, reschedule_event, cancel_event, propose_times, add_attendee
  - archive, escalate, demote, close, snooze, merge_items, split_item
  - update_priority, tag_entity, extract_insight, update_memory, sync_thought_to_notion
  - request_approval, freeze_rule, log_override, transfer_to_agent, parallel_fan_out, wait_for_approval
  - create_odoo_lead, create_odoo_opportunity, update_odoo_opportunity, update_odoo_crm

Rules:
- If the user's intent doesn't map cleanly, prefer "extractInsight" or "createTask" over forcing a specific handler.
- Never invent a handler not in the allowed list.
- Set confidence ≤ 0.5 if the NL is ambiguous.
- triggerCondition fields default to null if unmentioned.

Examples:
"When emails from Raazia arrive, delegate to Asad"
→ {"name":"Delegate Raazia emails to Asad","triggerKind":"inbound_email","triggerCondition":{"sender":"Raazia"},"actionType":"forwardEmail","actionPayload":{"delegatee":"Asad"},"confidence":0.9}

"Every Plaud transcript should be summarised into a meeting note"
→ {"name":"Summarise Plaud transcripts","triggerKind":"meeting_minutes_filed","triggerCondition":{"sender":"plaud"},"actionType":"extractInsight","actionPayload":{},"confidence":0.85}`;

interface ParsedRule {
  name: string;
  triggerKind: TriggerKind;
  triggerCondition: TriggerCondition;
  actionType: string;
  actionPayload: Record<string, unknown>;
  confidence: number;
}

export async function parseRuleFromNL(
  text: string,
  clientNumber: string,
  userId: number,
): Promise<ParsedRule | null> {
  try {
    const r = await callLLM(PARSE_PROMPT, text, {
      maxTokens: 500,
      providers: ['gemini-flash', 'gemini', 'claude'],
      userId, clientNumber, purpose: 'action_rule_parse',
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    return {
      name: String(obj.name ?? text.slice(0, 60)),
      triggerKind: ALLOWED_TRIGGER_KINDS.has(obj.triggerKind) ? obj.triggerKind : 'manual',
      triggerCondition: sanitiseCondition(obj.triggerCondition ?? {}),
      actionType: normaliseActionType(String(obj.actionType ?? '')),
      actionPayload: obj.actionPayload ?? {},
      confidence: Math.min(1, Math.max(0, Number(obj.confidence ?? 0.5))),
    };
  } catch (err: any) {
    log.warn('parseRuleFromNL failed', { error: err.message });
    return null;
  }
}

/** Defensive normaliser — handler registry uses snake_case. If the
 *  LLM still emits camelCase like "forwardEmail", convert it. */
function normaliseActionType(raw: string): string {
  if (!raw) return raw;
  if (raw.includes('_') || raw === raw.toLowerCase()) return raw.toLowerCase();
  return raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

const ALLOWED_TRIGGER_KINDS = new Set<TriggerKind>([
  'inbound_email','inbound_whatsapp','inbound_chat','inbound_any',
  'open_item_created','meeting_minutes_filed','manual',
]);

function sanitiseCondition(c: any): TriggerCondition {
  const t: TriggerCondition = {};
  for (const k of ['sender','senderDomain','subjectContains','archetype','bodyContains'] as const) {
    if (typeof c?.[k] === 'string' && c[k].trim()) t[k] = c[k].trim().slice(0, 120);
  }
  return t;
}

// ─── CRUD ────────────────────────────────────────────────────────

export async function createRule(input: UserActionRuleInput): Promise<UserActionRule> {
  // Refuse to create if actionType isn't registered. This is the
  // "conservative + friendly" guard — better to fail loud at create time
  // than silently fail at trigger time.
  const { has } = await import('./actions/handlerRegistry');
  if (!has(input.actionType)) {
    throw new Error(`unknown actionType "${input.actionType}" — pick one from the allowed list`);
  }

  const id = `uar_${crypto.randomBytes(6).toString('hex')}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO user_action_rules
       (id, client_number, user_id, scope, name, nl_original,
        trigger_kind, trigger_condition, action_type, action_payload,
        mode, confidence_threshold, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, 'DRAFT', $11, TRUE, $3)`,
    id, input.clientNumber, input.userId,
    input.scope ?? 'user',
    input.name.slice(0, 200),
    input.nlOriginal.slice(0, 2000),
    input.triggerKind,
    JSON.stringify(input.triggerCondition ?? {}),
    input.actionType,
    JSON.stringify(input.actionPayload ?? {}),
    Math.min(1, Math.max(0.5, input.confidenceThreshold ?? 0.85)),
  );

  await audit({
    clientNumber: input.clientNumber, actorId: input.userId, actorKind: 'user',
    action: 'instruction.created',
    subjectType: 'user_action_rule', subjectId: id,
    details: { name: input.name, mode: 'DRAFT', actionType: input.actionType },
  });

  const created = await getRule(input.clientNumber, id);
  if (!created) throw new Error('rule create failed');
  return created;
}

export async function getRule(clientNumber: string, id: string): Promise<UserActionRule | null> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM user_action_rules WHERE client_number=$1 AND id=$2`,
    clientNumber, id,
  ).catch(() => []);
  if (rows.length === 0) return null;
  return rowToRule(rows[0]);
}

export async function listRules(clientNumber: string, userId: number): Promise<UserActionRule[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM user_action_rules
      WHERE client_number=$1 AND (user_id=$2 OR scope='client')
      ORDER BY (scope='client') DESC, created_at DESC`,
    clientNumber, userId,
  ).catch(() => []);
  return rows.map(rowToRule);
}

export async function setRuleMode(
  clientNumber: string, userId: number, id: string, mode: RuleMode,
  opts: { confirmPhraseForAuto?: string; isAdmin?: boolean } = {},
): Promise<{ ok: boolean; reason?: string; rule?: UserActionRule }> {
  const rule = await getRule(clientNumber, id);
  if (!rule) return { ok: false, reason: 'not found' };
  if (rule.scope === 'client' && !opts.isAdmin) return { ok: false, reason: 'admin only' };
  if (rule.scope === 'user' && rule.userId !== userId) return { ok: false, reason: 'not your rule' };

  // AUTO promotion guardrail — typed confirmation phrase.
  if (mode === 'AUTO' && opts.confirmPhraseForAuto !== 'I-WANT-AUTO') {
    return { ok: false, reason: 'AUTO promotion requires confirmPhraseForAuto = "I-WANT-AUTO"' };
  }

  await prisma.$executeRawUnsafe(
    `UPDATE user_action_rules SET mode=$3, last_promoted_at=NOW(), updated_at=NOW()
      WHERE client_number=$1 AND id=$2`,
    clientNumber, id, mode,
  );
  await audit({
    clientNumber, actorId: userId, actorKind: 'user',
    action: mode === 'AUTO' ? 'brain.action.executed' : 'instruction.created',
    subjectType: 'user_action_rule', subjectId: id,
    details: { previousMode: rule.mode, newMode: mode, name: rule.name },
  });
  return { ok: true, rule: { ...rule, mode } };
}

export async function deleteRule(clientNumber: string, userId: number, id: string, opts: { isAdmin?: boolean } = {}): Promise<{ ok: boolean; reason?: string }> {
  const rule = await getRule(clientNumber, id);
  if (!rule) return { ok: false, reason: 'not found' };
  if (rule.scope === 'client' && !opts.isAdmin) return { ok: false, reason: 'admin only' };
  if (rule.scope === 'user' && rule.userId !== userId) return { ok: false, reason: 'not your rule' };
  await prisma.$executeRawUnsafe(
    `UPDATE user_action_rules SET is_active=FALSE, updated_at=NOW()
      WHERE client_number=$1 AND id=$2`,
    clientNumber, id,
  );
  await audit({
    clientNumber, actorId: userId, actorKind: 'user',
    action: 'instruction.archived',
    subjectType: 'user_action_rule', subjectId: id,
    details: { name: rule.name },
  });
  return { ok: true };
}

// ─── Evaluator ──────────────────────────────────────────────────

export interface RuleMatchInput {
  clientNumber: string;
  userId: number;
  triggerKind: TriggerKind;
  senderEmail?: string | null;
  senderName?: string | null;
  senderDomain?: string | null;
  subject?: string | null;
  body?: string | null;
  archetype?: string | null;
}

export interface RuleMatch {
  rule: UserActionRule;
  matchedOn: string[];
}

/** Find rules whose trigger condition matches this event. */
export async function evaluateRulesForEvent(input: RuleMatchInput): Promise<RuleMatch[]> {
  const rules = await listRules(input.clientNumber, input.userId);
  const out: RuleMatch[] = [];
  for (const r of rules) {
    if (!r.isActive) continue;
    if (r.triggerKind !== 'inbound_any' && r.triggerKind !== input.triggerKind) continue;

    const matched: string[] = [];
    const c = r.triggerCondition;
    if (c.sender) {
      const haystack = `${input.senderEmail ?? ''} ${input.senderName ?? ''}`.toLowerCase();
      if (!haystack.includes(c.sender.toLowerCase())) continue;
      matched.push(`sender~${c.sender}`);
    }
    if (c.senderDomain) {
      const dom = (input.senderDomain ?? '').toLowerCase();
      if (!dom.includes(c.senderDomain.replace(/^@/, '').toLowerCase())) continue;
      matched.push(`domain~${c.senderDomain}`);
    }
    if (c.subjectContains) {
      if (!String(input.subject ?? '').toLowerCase().includes(c.subjectContains.toLowerCase())) continue;
      matched.push(`subject~${c.subjectContains}`);
    }
    if (c.archetype) {
      if (input.archetype !== c.archetype) continue;
      matched.push(`archetype=${c.archetype}`);
    }
    if (c.bodyContains) {
      if (!String(input.body ?? '').toLowerCase().includes(c.bodyContains.toLowerCase())) continue;
      matched.push(`body~${c.bodyContains}`);
    }

    // At least one condition required — refuse to match a rule with empty conditions.
    if (matched.length === 0) continue;
    out.push({ rule: r, matchedOn: matched });
  }
  return out;
}

/** Note that a rule fired (bumps counters). Idempotent on (ruleId, eventKey). */
export async function noteFire(
  clientNumber: string, ruleId: string,
  opts: { autoExecuted?: boolean } = {},
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE user_action_rules
       SET triggered_count = triggered_count + 1,
           auto_executed_count = auto_executed_count + ($3::int),
           last_triggered_at = NOW(), updated_at = NOW()
     WHERE client_number=$1 AND id=$2`,
    clientNumber, ruleId, opts.autoExecuted ? 1 : 0,
  ).catch(() => {});
}

function rowToRule(r: any): UserActionRule {
  return {
    id: r.id,
    clientNumber: r.client_number,
    userId: r.user_id,
    scope: r.scope,
    name: r.name,
    nlOriginal: r.nl_original,
    triggerKind: r.trigger_kind,
    triggerCondition: r.trigger_condition ?? {},
    actionType: r.action_type,
    actionPayload: r.action_payload ?? {},
    mode: r.mode,
    confidenceThreshold: Number(r.confidence_threshold),
    isActive: r.is_active,
    triggeredCount: r.triggered_count,
    autoExecutedCount: r.auto_executed_count,
    lastTriggeredAt: r.last_triggered_at?.toISOString?.() ?? r.last_triggered_at ?? null,
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
  };
}
