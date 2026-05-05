/**
 * MyOS — Triage Reasoner.
 *
 * Replaces the templated rationale + hardcoded archetype regex + fixed
 * action-button branches with a single LLM reasoning call. One prompt,
 * all the context Brain has gathered, ask the LLM to return a complete
 * triage decision:
 *
 *   {
 *     archetype: 'reply_needed' | 'inform_only' | 'schedule_meeting' | 'review_risk' | 'acknowledge',
 *     rationale: "<one sentence, human-written, references actual context>",
 *     suggestedAction: 'draft_reply' | 'delegate' | 'add_open_item' | 'ignore' | 'acknowledge' | 'schedule_meeting',
 *     confidence: 0-1,
 *     actions: [{ id, label, primary?, delegatee? }, ...],
 *     critical: boolean,
 *     noise: boolean,
 *     meetingIntent: boolean,
 *   }
 *
 * Cached per dedup_hash for 1 hour — same pattern → same reasoning →
 * one LLM call covers all matching attention cards. Falls back to the
 * deterministic classifier if LLM is unavailable.
 */
import createLogger from '../../utils/logger';

const log = createLogger('triage-reasoner');

export interface ReasonerContext {
  userId: number;
  clientNumber: string;
  itemType: 'email' | 'whatsapp' | 'meeting' | 'task';
  sourceType: string;
  from: string;
  fromEmail: string | null;
  senderDomain: string | null;
  subject: string;
  preview: string;
  sender: {
    isKnown: boolean;
    entityName?: string | null;
    company?: string | null;
    role?: string | null;
    relationshipStrength?: number | null;
    interactionCount: number;
    firstContact: boolean;
    senderHistoryMarkdown?: string | null;
    topicMemoryMarkdown?: string | null;
    recentDecisionCounts: Record<string, number>;
    dominantDelegatee?: string | null;
    dominantDelegationCount: number;
    relatedOpenItems: Array<{ title: string; status: string }>;
    threadContext: Array<{ from: 'me' | 'them'; text: string }>;
  };
  org: {
    senderOnActiveAccount: boolean;
    senderOnActiveProject: boolean;
    faclDocTitles: string[];
    faclRelevantDocs: Array<{ title: string; summary: string }>;
  };
  meeting?: {
    start?: string;
    end?: string;
    isAllDay?: boolean;
    selfOrganized?: boolean;
    hasConflicts?: boolean;
    conflictTitles?: string[];
  };
  activeRule?: { action: string; agreement: number } | null;
}

export interface ReasonerDecision {
  archetype: 'reply_needed' | 'inform_only' | 'schedule_meeting' | 'review_risk' | 'acknowledge';
  rationale: string;
  suggestedAction: 'draft_reply' | 'delegate' | 'add_open_item' | 'ignore' | 'acknowledge' | 'schedule_meeting';
  confidence: number;
  actions: Array<{ id: string; label: string; primary?: boolean; delegatee?: { email?: string; name?: string } }>;
  critical: boolean;
  noise: boolean;
  meetingIntent: boolean;
}

// ── Cache per (dedupHash + content fingerprint) ────────────────────
//
// dedupHash alone is far too coarse — it only encodes
// (userId, itemType, archetype, senderDomain, actionArchetype). Two
// completely different emails from the same internal domain with the
// same archetype (e.g. an L&OD course nudge vs a critical P1 rollout
// email, both classified `reply_needed`, both `@tmcltd.ai`) would
// share a cache entry and the second card would render the first
// card's summary, draft target, and confidence. To preserve the "N
// identical retries cost 1 LLM call" goal without leaking content
// across distinct emails, the cache key now combines dedupHash with
// a sha-256 of the actual email content (sender + subject + preview).
interface CacheEntry { decision: ReasonerDecision; fetchedAt: number }
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60 * 60 * 1000; // 1 hour

function contentFingerprint(ctx: ReasonerContext): string {
  const crypto = require('crypto') as typeof import('crypto');
  const blob = [
    ctx.fromEmail ?? '',
    (ctx.subject ?? '').slice(0, 200),
    (ctx.preview ?? '').slice(0, 400),
  ].join('::');
  return crypto.createHash('sha256').update(blob).digest('hex').slice(0, 16);
}

function buildCacheKey(dedupHash: string, ctx: ReasonerContext): string {
  return `${dedupHash}::${contentFingerprint(ctx)}`;
}

export function invalidateReasonerCache(dedupHash?: string): void {
  if (dedupHash) {
    // Clear every cache entry whose key starts with this dedupHash —
    // we don't know the content fingerprint of every variant, so a
    // prefix sweep is the safe move.
    for (const k of cache.keys()) {
      if (k.startsWith(`${dedupHash}::`) || k === dedupHash) cache.delete(k);
    }
  } else {
    cache.clear();
  }
}

/**
 * Main entry. Returns the full triage decision for one feed event.
 * Caches by (dedupHash + content fingerprint) so N identical retries
 * of the same email share 1 LLM call, but two distinct emails that
 * happen to share archetype/domain do not bleed into each other.
 */
export async function reasonAboutEvent(
  dedupHash: string,
  ctx: ReasonerContext,
): Promise<ReasonerDecision> {
  const cacheKey = buildCacheKey(dedupHash, ctx);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.decision;

  try {
    const decision = await llmReason(ctx);
    cache.set(cacheKey, { decision, fetchedAt: Date.now() });
    return decision;
  } catch (err: any) {
    log.warn('LLM reasoning failed, using fallback', { dedupHash, cacheKey, error: err.message });
    return fallback(ctx);
  }
}

// ── LLM path ───────────────────────────────────────────────────────

async function llmReason(ctx: ReasonerContext): Promise<ReasonerDecision> {
  const { callLLM } = await import('../llmRouter');
  const { getBrainPersona } = await import('../knowledge/brainPersonaService');
  const persona = await getBrainPersona(ctx.userId, ctx.clientNumber);

  const system = `${persona.systemPreamble}

You are reasoning about a single incoming item (email/WhatsApp/calendar/task) for ${persona.userFirstName}.

Output STRICT JSON, no prose, no markdown wrappers. Schema:
{
  "archetype": "reply_needed" | "inform_only" | "schedule_meeting" | "review_risk" | "acknowledge",
  "rationale": "ONE natural sentence (<30 words) explaining the suggested action. Reference actual context: sender name, company, past pattern, FACL doc, related open item, etc. Speak like a sharp EA — not a database.",
  "suggestedAction": "draft_reply" | "delegate" | "add_open_item" | "ignore" | "acknowledge" | "schedule_meeting",
  "confidence": 0.0-1.0,
  "actions": [ { "id": "<see below>", "label": "<button text>", "primary": true | false, "delegatee": { "email": string?, "name": string? }? } ],
  "critical": boolean,
  "noise": boolean,
  "meetingIntent": boolean
}

Action IDs allowed: draft_reply, delegate, delegate_to_known, add_open_item, link_to_existing, ignore, acknowledge, accept, decline, propose_alternative.

RULES:
- "noise" = true for unsubscribe/newsletter/bulk automated senders. Human senders are never noise.
- "critical" = true ONLY when there is a concrete urgency signal:
    (a) an explicit deadline inside 48 hours,
    (b) urgency language in subject/body ("urgent", "asap", "today", "blocker", "emergency", "critical", "escalation"),
    (c) money or wire/payment/invoice context with a time pressure,
    (d) regulator / legal / compliance / tax-authority trigger,
    (e) direct question addressed TO the user (you are in To:, not CC) from a known senior contact asking for a decision they cannot make themselves,
    (f) the event matches a user-defined watchpoint.
  Known sender, frequent interactions, or active-account status ALONE are NOT enough. Being "important long-term" is different from "critical right now." If in doubt, set critical=false — the user is drowning in false-positive criticals.
- "meetingIntent" = true ONLY if the incoming is asking to meet/call/schedule (not a generic email).
- actions[0] is primary. Include up to 5 actions total. Pick labels that reference actual people ("→ Delegate to Asad") when you have them.
- If self-organized meeting: only Accept ("already attending") + Dismiss. Never Draft reply.
- If meeting with conflicts: "propose_alternative" primary.
- If sender has 2+ past delegations to same person: primary action is delegate_to_known with that person's name in the label.
- If related open items exist: consider link_to_existing as primary.
- confidence reflects your conviction that this is the RIGHT action.

Be decisive. Don't hedge. The user trusts you to pick one path.`;

  const user = buildUserPrompt(ctx);
  const r = await callLLM(system, user, {
    maxTokens: 500,
    userId: ctx.userId,
    clientNumber: ctx.clientNumber,
    purpose: 'triage',
  });
  const text = r.text.trim();

  // Extract JSON — some models wrap it in ```json blocks
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('LLM did not return JSON');
  const parsed = JSON.parse(jsonMatch[0]);

  // Validate + clamp
  return {
    archetype: validArchetype(parsed.archetype),
    rationale: String(parsed.rationale ?? 'Limited history — using default.').slice(0, 240),
    suggestedAction: validAction(parsed.suggestedAction),
    confidence: clamp01(Number(parsed.confidence)),
    actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 6).map((a: any) => ({
      id: String(a.id ?? 'draft_reply'),
      label: String(a.label ?? 'Action'),
      primary: !!a.primary,
      delegatee: a.delegatee ? { email: a.delegatee.email, name: a.delegatee.name } : undefined,
    })) : [],
    critical: !!parsed.critical,
    noise: !!parsed.noise,
    meetingIntent: !!parsed.meetingIntent,
  };
}

function buildUserPrompt(ctx: ReasonerContext): string {
  const lines: string[] = [];
  lines.push('═══ INCOMING ═══');
  lines.push(`Type: ${ctx.itemType} (${ctx.sourceType})`);
  lines.push(`From: ${ctx.from}${ctx.fromEmail ? ` <${ctx.fromEmail}>` : ''}`);
  if (ctx.subject) lines.push(`Subject: ${ctx.subject}`);
  if (ctx.preview) lines.push(`Preview: ${ctx.preview.slice(0, 300)}`);

  if (ctx.meeting) {
    lines.push('\n═══ MEETING DETAILS ═══');
    if (ctx.meeting.start) lines.push(`Start: ${ctx.meeting.start}`);
    if (ctx.meeting.end) lines.push(`End: ${ctx.meeting.end}`);
    if (ctx.meeting.isAllDay) lines.push('All-day: yes');
    if (ctx.meeting.selfOrganized) lines.push('Self-organized: yes (no RSVP needed)');
    if (ctx.meeting.hasConflicts && ctx.meeting.conflictTitles?.length) {
      lines.push(`CONFLICTS WITH: ${ctx.meeting.conflictTitles.join(' | ')}`);
    }
  }

  lines.push('\n═══ SENDER MEMORY ═══');
  if (ctx.sender.firstContact) {
    lines.push('First contact — no prior history.');
  } else {
    if (ctx.sender.entityName) {
      const bits: string[] = [ctx.sender.entityName];
      if (ctx.sender.role) bits.push(ctx.sender.role);
      if (ctx.sender.company) bits.push(`at ${ctx.sender.company}`);
      if (ctx.sender.relationshipStrength != null) bits.push(`strength ${ctx.sender.relationshipStrength}`);
      lines.push(`Known: ${bits.join(', ')}`);
    }
    lines.push(`${ctx.sender.interactionCount} messages in last 90 days.`);
    const decTotal = Object.values(ctx.sender.recentDecisionCounts).reduce((s, n) => s + n, 0);
    if (decTotal > 0) {
      const parts = Object.entries(ctx.sender.recentDecisionCounts).map(([k, v]) => `${k}=${v}`).join(', ');
      lines.push(`Past MD decisions on this sender: ${parts}`);
    }
    if (ctx.sender.dominantDelegatee && ctx.sender.dominantDelegationCount >= 1) {
      lines.push(`MD usually delegates to: ${ctx.sender.dominantDelegatee} (${ctx.sender.dominantDelegationCount} times)`);
    }
    if (ctx.sender.relatedOpenItems.length > 0) {
      lines.push(`Active open items with this sender: ${ctx.sender.relatedOpenItems.map((o) => `${o.title} [${o.status}]`).join(' | ')}`);
    }
  }
  if (ctx.sender.senderHistoryMarkdown) {
    lines.push('\n--- Sender wiki page ---');
    lines.push(ctx.sender.senderHistoryMarkdown.slice(0, 600));
  }
  if (ctx.sender.topicMemoryMarkdown) {
    lines.push('\n--- Topic memory for this exact pattern ---');
    lines.push(ctx.sender.topicMemoryMarkdown.slice(0, 500));
  }
  if (ctx.sender.threadContext.length > 0) {
    lines.push('\n--- Recent thread (oldest → newest) ---');
    for (const t of ctx.sender.threadContext.slice(-6)) {
      lines.push(`${t.from === 'me' ? 'YOU' : 'THEM'}: ${t.text.slice(0, 200)}`);
    }
  }

  lines.push('\n═══ ORGANIZATION CONTEXT ═══');
  if (ctx.org.senderOnActiveAccount) lines.push('Sender company is on an active ACCOUNT.');
  if (ctx.org.senderOnActiveProject) lines.push('Sender company is on an active PROJECT.');
  if (ctx.org.faclDocTitles.length > 0) {
    lines.push(`FACL org docs available: ${ctx.org.faclDocTitles.slice(0, 10).join(', ')}`);
  }
  if (ctx.org.faclRelevantDocs.length > 0) {
    lines.push('\n--- FACL docs relevant to this event ---');
    for (const d of ctx.org.faclRelevantDocs.slice(0, 3)) {
      lines.push(`### ${d.title}`);
      lines.push(d.summary.slice(0, 300));
    }
  }

  if (ctx.activeRule) {
    lines.push(`\n═══ AUTOMATION ═══`);
    lines.push(`An active rule handles this pattern: action="${ctx.activeRule.action}" agreement=${Math.round(ctx.activeRule.agreement * 100)}%. Brain is already acting — this is shown for context, not as a prompt.`);
  }

  lines.push('\n═══ DECIDE ═══');
  lines.push('Return JSON per schema. Be specific, reference actual names/docs/counts.');
  return lines.join('\n');
}

// ── Validation helpers ─────────────────────────────────────────────
function validArchetype(x: any): ReasonerDecision['archetype'] {
  const allowed = ['reply_needed', 'inform_only', 'schedule_meeting', 'review_risk', 'acknowledge'];
  return allowed.includes(x) ? x : 'reply_needed';
}
function validAction(x: any): ReasonerDecision['suggestedAction'] {
  const allowed = ['draft_reply', 'delegate', 'add_open_item', 'ignore', 'acknowledge', 'schedule_meeting'];
  return allowed.includes(x) ? x : 'draft_reply';
}
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return Math.min(1, Math.max(0, x));
}

// ── Fallback (used only when LLM is unreachable) ───────────────────
function fallback(ctx: ReasonerContext): ReasonerDecision {
  const archetype: ReasonerDecision['archetype'] = /newsletter|digest|unsubscribe|no[-_.]?reply/i.test(ctx.from)
    ? 'inform_only' : 'reply_needed';
  const critical = !!ctx.org.senderOnActiveAccount || !!ctx.org.senderOnActiveProject || (ctx.sender.relationshipStrength ?? 0) >= 3;
  const noise = archetype === 'inform_only';
  const suggestedAction: ReasonerDecision['suggestedAction'] =
    ctx.sender.dominantDelegatee && ctx.sender.dominantDelegationCount >= 2 ? 'delegate' : 'draft_reply';
  return {
    archetype,
    rationale: 'LLM unavailable — using deterministic fallback.',
    suggestedAction,
    confidence: 0.3,
    actions: [
      { id: 'draft_reply', label: '✎ Draft reply', primary: suggestedAction === 'draft_reply' },
      { id: 'delegate', label: '→ Delegate', primary: suggestedAction === 'delegate' },
      { id: 'add_open_item', label: '+ Open Item' },
      { id: 'ignore', label: '✕ Ignore' },
    ],
    critical,
    noise,
    meetingIntent: false,
  };
}
