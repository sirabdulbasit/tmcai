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
 * Cached durably on the exact prompt bytes (OPT-004) — same inputs →
 * same reasoning → one LLM call covers every look at that event, across
 * restarts, until something the model actually sees changes. Falls back
 * to the deterministic classifier if LLM is unavailable.
 */
import createLogger from '../../utils/logger';
import { windowedLogGate } from '../../utils/boundedLog';

const log = createLogger('triage-reasoner');
// DEF-334 (2): at most 5 fallback lines per hour — the count survives in
// `occurrences`/`suppressedLastWindow`, the megabytes do not.
const fallbackLogGate = windowedLogGate(5, 60 * 60 * 1000);

export interface ReasonerContext {
  userId: number;
  clientNumber: string;
  /** Feed event this reasoning call is about. Attributes the LLM spend row to
   *  its source event so a saving can be measured per event, not asserted. */
  feedEventId?: string | null;
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

// ── OPT-004 — the triage decision cache ────────────────────────────
//
// The previous cache was an in-process `Map` with a 1-hour TTL, keyed by
// (dedupHash + a fingerprint of sender/subject/preview). Measured 2026-08-27,
// it was not working:
//
//   triage: 2,439–3,727 LLM calls/day, 10.9–16.6M input tokens, $15–23/day
//           — for ONE user, against a feed of 4,877 events total that grows
//           by ~42/day.
//
// Two independent reasons, both structural:
//
//   1. The Map dies with the process. This tree restarts often, and every
//      restart re-reasoned the entire backlog from scratch.
//   2. A 1-hour TTL re-reasons the same unchanged email every hour it is
//      looked at, forever. Nothing about an email from May changes hourly.
//
// This is the same shape, and the same fix, as OPT-003 (`criticality_fuse`,
// 2026-08-08): that one went from 17,087 calls/day to ~130/day, and its table
// currently shows 3,699 entries serving 160,241 hits — a 97.7% hit rate. The
// design is copied deliberately rather than reinvented.
//
// THE KEY IS THE PROMPT, not the event and not the dedupHash. `buildUserPrompt`
// returns the exact string the model sees, so identical bytes mean identical
// inputs and therefore the same answer. That makes the cache correct BY
// CONSTRUCTION: when the sender's history, the thread, the related open items
// or the past decisions change, the prompt changes and the call misses without
// anyone having to remember to invalidate it. It is also strictly narrower than
// the old key — the old fingerprint covered only sender/subject/preview and
// happily served a decision derived from stale thread context.
//
// userId is inside the hash, not merely a column. clientNumber alone (the
// OPT-003 precedent) leaves two users of one tenant able to share an entry if
// their prompts coincide; a triage decision names people and drafts replies, so
// that is not a leak worth risking for nothing.
import crypto from 'crypto';

const TRIAGE_PROMPT_VERSION = 'v1';

/** Cached decisions older than this are ignored and re-reasoned. Model
 *  behaviour drifts and so does the world; a fortnight-old judgement is the
 *  outer edge of evidence. Same figure as the fusion cache. */
const TRIAGE_CACHE_TTL_DAYS = 14;

/** L1, in front of the table. Saves a DB round trip when the same event is
 *  triaged repeatedly inside one process (My Attention and Brief both call
 *  through here on a single page load). Deliberately short — the durable
 *  table is the real cache; this only absorbs bursts. */
interface CacheEntry { decision: ReasonerDecision; fetchedAt: number }
const cache = new Map<string, CacheEntry>();
const L1_TTL_MS = 60 * 60 * 1000; // 1 hour
const L1_MAX = 2_000;

function buildCacheKey(ctx: ReasonerContext, userPrompt: string): string {
  return crypto.createHash('sha256')
    .update(`${TRIAGE_PROMPT_VERSION}\u0000${ctx.clientNumber}\u0000${ctx.userId}\u0000${userPrompt}`)
    .digest('hex');
}

/** Exported for the cache tests — the key IS the cache's behaviour. */
export const __triageCacheInternals = { buildCacheKey, TRIAGE_PROMPT_VERSION };

/**
 * Drop cached reasoning for a pattern.
 *
 * Content-addressing already handles the normal case: a new decision on this
 * pattern changes `recentDecisionCounts` in the prompt, so the next call misses
 * on its own. This stays as the explicit belt-and-braces path used when the
 * user acts on a card (`briefRoutes` apply-decision), because the decision_log
 * write and the next triage read race, and a user who just told Brain something
 * should never be answered from before they said it.
 *
 * L1 is cleared synchronously so callers that do not await still see the effect
 * immediately; the L2 delete is fire-and-forget and can never throw into a
 * caller — a failed cache eviction must not fail a user's click.
 */
export function invalidateReasonerCache(dedupHash?: string): void {
  cache.clear();
  void (async () => {
    const prisma = (await import('../../db/prisma')).default;
    if (dedupHash) {
      await prisma.triageDecisionCache.deleteMany({ where: { dedupHash } });
    } else {
      await prisma.triageDecisionCache.deleteMany({});
    }
  })().catch((err: any) => log.warn('reasoner cache invalidation failed', { dedupHash, error: err?.message }));
}

/**
 * Main entry. Returns the full triage decision for one feed event.
 *
 * Cached on the exact prompt bytes, so N looks at an unchanged email cost 1
 * LLM call however many days apart they happen and however many restarts fall
 * between them.
 */
export async function reasonAboutEvent(
  dedupHash: string,
  ctx: ReasonerContext,
): Promise<ReasonerDecision> {
  const userPrompt = buildUserPrompt(ctx);
  const cacheKey = buildCacheKey(ctx, userPrompt);

  const l1 = cache.get(cacheKey);
  if (l1 && Date.now() - l1.fetchedAt < L1_TTL_MS) return l1.decision;

  // L2 read. Never allowed to break triage: any failure falls through to the
  // live call, which is exactly the behaviour before this cache existed.
  try {
    const prisma = (await import('../../db/prisma')).default;
    const row = await prisma.triageDecisionCache.findUnique({
      where: { cacheKey },
      select: { decision: true, createdAt: true, promptVersion: true },
    });
    if (
      row &&
      row.promptVersion === TRIAGE_PROMPT_VERSION &&
      Date.now() - row.createdAt.getTime() < TRIAGE_CACHE_TTL_DAYS * 86_400_000
    ) {
      const decision = row.decision as unknown as ReasonerDecision;
      rememberL1(cacheKey, decision);
      // Fire-and-forget: hit accounting must not add latency to the hit it is
      // accounting for.
      void prisma.triageDecisionCache.update({
        where: { cacheKey },
        data: { hits: { increment: 1 }, lastHitAt: new Date() },
      }).catch(() => {});
      return decision;
    }
  } catch (err: any) {
    log.warn('triage decision cache read failed — reasoning live', { error: err?.message });
  }

  try {
    const decision = await llmReason(ctx, userPrompt);
    rememberL1(cacheKey, decision);
    void writeCache(cacheKey, dedupHash, ctx, decision);
    return decision;
  } catch (err: any) {
    // DEF-334 (2): the second of the two measured flood sites (~6,900 lines in
    // one sample window) — same bound as fuseAndScore's, same recordkeeping.
    const gate = fallbackLogGate('llmReason');
    if (gate.log) {
      log.warn('LLM reasoning failed, using fallback', {
        dedupHash, cacheKey, error: err.message,
        occurrences: gate.occurrences,
        ...(gate.suppressedLastWindow > 0 ? { suppressedLastWindow: gate.suppressedLastWindow } : {}),
      });
    }
    // Deliberately NOT cached. The fallback is what we say when the model is
    // unreachable; persisting it for a fortnight would turn a transient outage
    // into two weeks of "LLM unavailable — using deterministic fallback."
    return fallback(ctx);
  }
}

function rememberL1(key: string, decision: ReasonerDecision): void {
  if (cache.size >= L1_MAX) {
    // Oldest-first: Map preserves insertion order.
    let i = 0;
    for (const k of cache.keys()) {
      if (i >= Math.floor(L1_MAX * 0.2)) break;
      cache.delete(k);
      i++;
    }
  }
  cache.set(key, { decision, fetchedAt: Date.now() });
}

async function writeCache(
  cacheKey: string,
  dedupHash: string,
  ctx: ReasonerContext,
  decision: ReasonerDecision,
): Promise<void> {
  try {
    const prisma = (await import('../../db/prisma')).default;
    await prisma.triageDecisionCache.upsert({
      where: { cacheKey },
      create: {
        cacheKey,
        clientNumber: ctx.clientNumber,
        userId: ctx.userId,
        dedupHash,
        promptVersion: TRIAGE_PROMPT_VERSION,
        decision: decision as unknown as object,
      },
      // A concurrent writer got there first, or a TTL-expired row is being
      // refreshed — either way the newer reasoning wins and the clock resets.
      update: {
        decision: decision as unknown as object,
        promptVersion: TRIAGE_PROMPT_VERSION,
        dedupHash,
        createdAt: new Date(),
        hits: 0,
      },
    });
  } catch (err: any) {
    log.warn('triage decision cache write failed', { error: err?.message });
  }
}

/**
 * Evict expired and superseded entries. Run on the hourly self-heal pass,
 * alongside `sweepFusionCache`.
 *
 * A cache that never evicts is a second copy of the data growing forever —
 * which is precisely how `llm_spend` became 80% of this database (OPT-001).
 * Entries from a superseded prompt version go immediately: they can never be
 * served again, so keeping them is pure storage.
 */
export async function sweepTriageDecisionCache(): Promise<{ deleted: number }> {
  try {
    const prisma = (await import('../../db/prisma')).default;
    const cutoff = new Date(Date.now() - TRIAGE_CACHE_TTL_DAYS * 86_400_000);
    const r = await prisma.triageDecisionCache.deleteMany({
      where: {
        OR: [
          { createdAt: { lt: cutoff } },
          { promptVersion: { not: TRIAGE_PROMPT_VERSION } },
        ],
      },
    });
    return { deleted: r.count };
  } catch {
    return { deleted: 0 };
  }
}

/** Hit rate, for answering "is the cache actually working?" with a number. */
export async function triageCacheStats(clientNumber?: string): Promise<{ entries: number; hits: number }> {
  try {
    const prisma = (await import('../../db/prisma')).default;
    const agg = await prisma.triageDecisionCache.aggregate({
      where: clientNumber ? { clientNumber } : undefined,
      _count: { cacheKey: true },
      _sum: { hits: true },
    });
    return { entries: agg._count.cacheKey ?? 0, hits: agg._sum.hits ?? 0 };
  } catch {
    return { entries: 0, hits: 0 };
  }
}

// ── LLM path ───────────────────────────────────────────────────────

async function llmReason(ctx: ReasonerContext, userPrompt: string): Promise<ReasonerDecision> {
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

RATIONALE ↔ ACTION CONSISTENCY — non-negotiable:
Your rationale and suggestedAction MUST agree. Before emitting JSON, re-read your own rationale and check:
  - If rationale contains "no action required" / "no follow-up needed" / "no response needed" / "just acknowledging" / "thread is closed" / "loop is closed" / "informational only" / "FYI" / "nothing to do" / "no reply needed" → suggestedAction MUST be "acknowledge" or "ignore". NEVER "draft_reply".
  - If rationale says you'd want the user to write back something specific → suggestedAction MUST be "draft_reply" or "delegate", NEVER "acknowledge".
  - If rationale identifies a delegatee by name → suggestedAction MUST be "delegate" (or delegate_to_known), NEVER "draft_reply" without a delegatee.
  - One-word acks ("Ok", "Thanks", "Noted", "Coming", "Done") sent BY the contact (not the user) are loop-closers. The right action is "acknowledge" with confidence high. NEVER "draft_reply" to "Ok".

Self-contradiction (rationale says one thing, action says another) is the worst failure mode — it tells the user we're not actually thinking. Verify alignment before emitting.

Be decisive. Don't hedge. The user trusts you to pick one path.`;

  const r = await callLLM(system, userPrompt, {
    maxTokens: 500,
    userId: ctx.userId,
    clientNumber: ctx.clientNumber,
    purpose: 'triage',
    feedEventId: ctx.feedEventId ?? null,
  });
  const text = r.text.trim();

  // Extract JSON — some models wrap it in ```json blocks
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('LLM did not return JSON');
  const parsed = JSON.parse(jsonMatch[0]);

  // ─── Rationale↔Action consistency guard (defense-in-depth) ──
  // The prompt above tells the LLM never to emit draft_reply when the
  // rationale says the loop is closed / no action needed. The LLM
  // still does it occasionally. Per user 2026-05-15: Abdul Haseeb
  // "Proceed" card had rationale "closing the loop on the previous
  // discussion" + suggestedAction='draft_reply'. The rationale was
  // right (loop IS closed); the action was wrong.
  //
  // After parsing, scan the rationale for the forbidden phrase list.
  // If a match fires AND the action is draft_reply, override to
  // acknowledge. Brand the override in the rationale so the audit
  // is visible to the user. Log to console for telemetry (so we can
  // measure how often the LLM violates its own rule).
  let rationale = String(parsed.rationale ?? 'Limited history — using default.').slice(0, 240);
  let suggestedAction = validAction(parsed.suggestedAction);
  const RATIONALE_LOOP_CLOSED = /\b(closing the loop|loop is closed|loop closed|no action required|no response needed|no reply needed|no follow-?up needed|just acknowledg(?:ing|e)|thread is closed|informational only|nothing to do)\b/i;
  if (suggestedAction === 'draft_reply' && RATIONALE_LOOP_CLOSED.test(rationale)) {
    const matched = rationale.match(RATIONALE_LOOP_CLOSED)?.[0] ?? 'closed-loop phrase';
    log.warn('Rationale↔action contradiction caught; overriding draft_reply → acknowledge', {
      userId: ctx.userId, matched, originalAction: 'draft_reply',
    });
    suggestedAction = 'acknowledge';
    rationale = `${rationale} (Brain caught itself: rationale says "${matched}", so switched suggestion to acknowledge.)`.slice(0, 240);
  }

  // Validate + clamp
  return {
    archetype: validArchetype(parsed.archetype),
    rationale,
    suggestedAction,
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
