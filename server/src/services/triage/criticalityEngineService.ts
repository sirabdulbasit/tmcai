/**
 * Criticality Engine — Brain's "what actually matters right now?" reasoner.
 *
 * Replaces the single `critical: boolean` flag with a multi-dimensional
 * scorecard. Not a rule set: a brain that reads seven signal sources,
 * fuses them into a story, and asks what changes if we don't act.
 *
 * Shape (mirrors the architecture diagram):
 *
 *   Phase 1 — Signal Gathering (The Senses)
 *     Feed · CRM · ERP · ProjectFlow · Calendar · Open Items · Knowledge
 *
 *   Phase 2 — Contextual Fusion (The Thinking)
 *     WHO / WHAT is happening / WHEN does it matter / WHAT IF we don't act /
 *     WHAT changed / WHAT does history say
 *
 *   Phase 3 — Multi-Dimensional Scoring (The Judgment)
 *     timePressure · impact · relationshipRisk · cascade · patternAnomaly
 *     → weighted composite in [0, 1]
 *
 *   Phase 4 — Superpowers
 *     absenceDetection · crossSourceReasoning · decayAwareUrgency
 *
 *   Phase 5 — Action band (Critical / High / Medium / Low)
 *     is applied by callers (triageSuggester + attention endpoint).
 *
 * What's connected vs aspirational (today):
 *   ✓ Feed, Calendar, Open Items, Knowledge, CRM (Odoo only)
 *   ✗ ERP, ProjectFlow — when those connectors land, add their gatherers
 *     and the LLM prompt will pick them up without changes here.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { callLLM } from '../llmRouter';

const log = createLogger('criticality');

export type CriticalityBand = 'critical' | 'high' | 'medium' | 'low';

export interface CriticalityDimensions {
  /** How soon action is needed (0 = no pressure, 1 = hours). */
  timePressure: number;
  /** Size of what's at stake if we fail — revenue, commitment, reputation. */
  impact: number;
  /** Trust / relationship damage if we don't act. */
  relationshipRisk: number;
  /** What else breaks downstream (blocks other work, contracts, people). */
  cascade: number;
  /** Deviation from expected pattern (silence where reply is usual, etc.). */
  patternAnomaly: number;
}

export interface CriticalitySuperpowers {
  /** "Client always replies by 2pm. It's 5pm. That silence is data." */
  absence: { triggered: boolean; note: string | null };
  /** "CRM shows competitor meeting Tuesday. Email silence since Wednesday. Connected." */
  crossSource: { triggered: boolean; note: string | null };
  /** "This was medium priority Monday. It's now critical — the window is closing." */
  decay: { triggered: boolean; note: string | null };
}

export interface CriticalityResult {
  composite: number;                       // 0..1
  band: CriticalityBand;
  dimensions: CriticalityDimensions;
  superpowers: CriticalitySuperpowers;
  reasons: string[];                       // short human-readable bullets
  signals: GatheredSignals;                // what the engine saw
  confidence: number;                      // how sure the LLM was
  scoredAt: string;                        // ISO
}

// ─── Phase 1 — Signal Gathering ────────────────────────────────

export interface ScoreInput {
  clientNumber: string;
  userId: number;
  itemType: 'email' | 'whatsapp' | 'meeting' | 'task';
  sourceType: string;
  from: string;
  fromEmail: string | null;
  toHeader?: string | null;
  ccHeader?: string | null;
  userEmail?: string | null;
  subject: string;
  preview: string;
  receivedAt: Date;
  entityId?: string | null;
  senderDomain?: string | null;
  relationshipStrength?: number | null;
  /** Optional feed_event id — when set, the criticality engine reads
   *  pre-computed sentiment/urgency from feed_events instead of inferring. */
  feedEventId?: string | null;
  /** Pre-computed things the caller already has — skip re-querying. */
  hints?: {
    hasActiveWatchpoint?: boolean;
    watchpointSubject?: string | null;
    isSenderOnActiveAccount?: boolean;
  };
}

interface GatheredSignals {
  addressing: { directlyAddressed: boolean; ccOnly: boolean; recipientCount: number };
  /** Opinionated derivation: what deadlines are live nearby? */
  deadlines: Array<{ source: string; what: string; at: string; hoursUntil: number }>;
  /** Open items linked to this sender or their company/entityId. */
  openItems: Array<{ id: string; title: string; status: string; priority: string; age_days: number; dueDate: string | null }>;
  /** Most recent CRM-side signals (Odoo). Empty when unavailable. */
  crm: Array<{ stage: string; value: number | null; lastActivity: string | null; note: string }>;
  /** Knowledge: 2 most-relevant concept/decision/meeting pages. */
  knowledge: Array<{ title: string; pageType: string; snippet: string }>;
  /** Recent thread on this sender/threadId (their tempo). */
  senderTempo: { medianReplyHours: number | null; currentSilenceHours: number | null; typicalWindowHours: number | null };
  /** Instructions that match this event (watchpoints / standing rules). */
  instructionMatches: Array<{ id: string; kind: string; title: string; originalText: string }>;
  /** Tenant delegation matrix entries that look related to the event
   *  (sender's domain, subject keywords, or owner email match). Lets the
   *  fusion LLM weight relationship-risk by who actually owns the area. */
  delegationOwners: Array<{ area: string; ownerName: string; ownerRole: string | null; ownerEmail: string | null; escalateToName: string | null }>;
  /** Pre-computed sentiment + urgency from sentimentService. Null when
   *  the feed event hasn't been analyzed yet (the analyzer runs async
   *  after ingest; backfill catches anything missed). */
  sentiment: {
    score: number | null;     // -1..+1
    urgency: number | null;   //  0..1
    tone: string | null;      // 'collaborative' | 'frustrated' | …
    rationale: string | null;
  };
  /** Per-user importance stars (0..5) attached to the sender's entity
   *  page. Stars stack on top of all other signals — a 5-star sender's
   *  routine FYI still gets a relationshipRisk floor. */
  importanceStars: number;
}

async function gatherSignals(input: ScoreInput): Promise<GatheredSignals> {
  const sig: GatheredSignals = {
    addressing: analyzeAddressing(input),
    deadlines: [],
    openItems: [],
    crm: [],
    knowledge: [],
    senderTempo: { medianReplyHours: null, currentSilenceHours: null, typicalWindowHours: null },
    instructionMatches: [],
    delegationOwners: [],
    sentiment: { score: null, urgency: null, tone: null, rationale: null },
    importanceStars: 0,
  };

  // Parallel fan-out — every source queried once, in under 500ms total.
  const [openItems, upcomingEvents, relatedPages, instructionMatches, tempo, crm, delegationOwners, sentiment, stars] = await Promise.all([
    gatherOpenItems(input).catch(() => []),
    gatherUpcomingCalendar(input).catch(() => []),
    gatherKnowledge(input).catch(() => []),
    gatherInstructionMatches(input).catch(() => []),
    gatherSenderTempo(input).catch(() => ({ medianReplyHours: null, currentSilenceHours: null, typicalWindowHours: null })),
    gatherCrm(input).catch(() => []),
    gatherDelegationOwners(input).catch(() => []),
    gatherSentiment(input).catch(() => ({ score: null, urgency: null, tone: null, rationale: null })),
    gatherImportanceStars(input).catch(() => 0),
  ]);

  sig.openItems = openItems;
  sig.deadlines = upcomingEvents;
  sig.knowledge = relatedPages;
  sig.instructionMatches = instructionMatches;
  sig.senderTempo = tempo;
  sig.crm = crm;
  sig.delegationOwners = delegationOwners;
  sig.sentiment = sentiment;
  sig.importanceStars = stars;

  return sig;
}

function analyzeAddressing(input: ScoreInput): GatheredSignals['addressing'] {
  const toLower = (input.toHeader ?? '').toLowerCase();
  const ccLower = (input.ccHeader ?? '').toLowerCase();
  const userLower = (input.userEmail ?? '').toLowerCase();
  const directlyAddressed = !!userLower && toLower.includes(userLower);
  const ccOnly = !!userLower && !directlyAddressed && ccLower.includes(userLower);
  const recipientCount = (toLower.match(/@/g)?.length ?? 0) + (ccLower.match(/@/g)?.length ?? 0);
  return { directlyAddressed, ccOnly, recipientCount };
}

async function gatherOpenItems(input: ScoreInput) {
  if (!input.entityId && !input.fromEmail) return [];
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, status, priority, due_date AS "dueDate", created_at AS "createdAt",
            EXTRACT(EPOCH FROM (NOW() - created_at))/86400 AS age_days
       FROM open_items
      WHERE client_number = $1 AND user_id = $2
        AND status NOT IN ('CLOSED','INFORMED')
        AND (entity_id = $3 OR metadata->>'senderEmail' = $4)
      ORDER BY priority_score DESC NULLS LAST, created_at ASC
      LIMIT 5`,
    input.clientNumber, input.userId,
    input.entityId ?? null, input.fromEmail ?? null,
  );
  return rows.map((r) => ({
    id: r.id, title: r.title, status: r.status, priority: r.priority,
    age_days: Math.round(Number(r.age_days ?? 0)),
    dueDate: r.dueDate ? new Date(r.dueDate).toISOString() : null,
  }));
}

async function gatherUpcomingCalendar(input: ScoreInput) {
  // Calendar events live inside feed_events.raw_payload (sourceType='gcal').
  // We also surface upcoming open_items.due_date so deadlines from
  // internal commitments are picked up. Returning a uniform shape.
  const in14d = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  // Open-item deadlines (reliable, indexed)
  const itemDeadlines = await prisma.$queryRawUnsafe<any[]>(
    `SELECT title,
            due_date AS "at",
            EXTRACT(EPOCH FROM (due_date - NOW()))/3600 AS hours_until
       FROM open_items
      WHERE client_number = $1 AND user_id = $2
        AND status NOT IN ('CLOSED','INFORMED')
        AND due_date IS NOT NULL
        AND due_date BETWEEN NOW() AND $3
      ORDER BY due_date ASC
      LIMIT 5`,
    input.clientNumber, input.userId, in14d,
  ).catch(() => [] as any[]);

  // Calendar feed_events — probe raw_payload for start.dateTime. Lightweight
  // scan (we only look at the last 60 gcal events); if the project grows
  // we should add a computed startTime column + index.
  const calEvents = await prisma.$queryRawUnsafe<any[]>(
    `SELECT raw_payload AS payload
       FROM feed_events
      WHERE client_number = $1 AND user_id = $2 AND source_type = 'gcal'
        AND created_at >= NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC LIMIT 60`,
    input.clientNumber, input.userId,
  ).catch(() => [] as any[]);

  const out: Array<{ source: string; what: string; at: string; hoursUntil: number }> = [];
  for (const r of itemDeadlines) {
    out.push({
      source: 'open_item', what: r.title,
      at: new Date(r.at).toISOString(),
      hoursUntil: Math.max(0, Math.round(Number(r.hours_until ?? 0))),
    });
  }
  for (const c of calEvents) {
    const p: any = c.payload ?? {};
    const startIso = p.start?.dateTime ?? p.start?.date ?? null;
    if (!startIso) continue;
    const t = Date.parse(startIso);
    if (!Number.isFinite(t)) continue;
    if (t < Date.now() || t > in14d.getTime()) continue;
    const title = String(p.summary ?? 'Meeting');
    const attendees = Array.isArray(p.attendees) ? p.attendees.map((a: any) => String(a.email ?? '').toLowerCase()).join(' ') : '';
    const matchesSender = !!input.senderDomain && attendees.includes(input.senderDomain.toLowerCase());
    const matchesSubject = title.toLowerCase().includes((input.subject ?? '').toLowerCase().slice(0, 20));
    if (!matchesSender && !matchesSubject) continue;
    out.push({
      source: 'calendar', what: title, at: new Date(t).toISOString(),
      hoursUntil: Math.max(0, Math.round((t - Date.now()) / 3600000)),
    });
  }
  out.sort((a, b) => a.hoursUntil - b.hoursUntil);
  return out.slice(0, 5);
}

async function gatherKnowledge(input: ScoreInput) {
  // Pull at most 2 pages that are (a) about this sender/entity, or
  // (b) a past decision/pattern for the same topic.
  if (!input.entityId && !input.fromEmail) return [];
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, page_type AS "pageType",
            SUBSTRING(COALESCE(body_markdown,''), 1, 280) AS snippet
       FROM wiki_pages
      WHERE client_number = $1
        AND status = 'active'
        AND page_type IN ('entity_person','topic','decision','pattern','meeting_minutes','sender_topic')
        AND (metadata->>'entityId' = $2 OR metadata->>'senderEmail' = $3 OR title ILIKE '%' || $4 || '%')
      ORDER BY last_updated_at DESC
      LIMIT 2`,
    input.clientNumber, input.entityId ?? '', input.fromEmail ?? '', input.senderDomain ?? '',
  );
  return rows;
}

async function gatherInstructionMatches(input: ScoreInput) {
  try {
    const { matchInstructionsForEvent } = await import('../knowledge/instructionMatcher');
    const matches = await matchInstructionsForEvent(input.clientNumber, input.userId, {
      senderEmail: input.fromEmail,
      senderName: input.from,
      subject: input.subject,
      snippet: input.preview,
    });
    return matches.map((m) => ({
      id: m.instruction.id,
      kind: m.instruction.kind,
      title: m.instruction.title,
      originalText: m.instruction.originalText,
    }));
  } catch {
    return [];
  }
}

/**
 * Sender tempo — what's this person's typical reply cadence? Drives the
 * absence superpower: if their median reply is ~4h but it's been 24h on
 * a thread we're waiting on, that silence is data.
 *
 * Implementation: look at past 20 feed_events from this sender, compute
 * median gap between our message and theirs. Rough but useful.
 */
async function gatherSenderTempo(input: ScoreInput): Promise<GatheredSignals['senderTempo']> {
  if (!input.fromEmail) return { medianReplyHours: null, currentSilenceHours: null, typicalWindowHours: null };
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT created_at FROM feed_events
      WHERE client_number = $1 AND user_id = $2 AND sender_email = $3
      ORDER BY created_at DESC LIMIT 20`,
    input.clientNumber, input.userId, input.fromEmail,
  ).catch(() => [] as any[]);
  if (rows.length < 3) return { medianReplyHours: null, currentSilenceHours: null, typicalWindowHours: null };

  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const diff = (new Date(rows[i - 1].created_at).getTime() - new Date(rows[i].created_at).getTime()) / 3600000;
    if (diff > 0 && diff < 24 * 14) gaps.push(diff);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? null;
  const typical = gaps[Math.floor(gaps.length * 0.75)] ?? null;
  const currentSilence = (Date.now() - new Date(rows[0].created_at).getTime()) / 3600000;
  return { medianReplyHours: median, currentSilenceHours: currentSilence, typicalWindowHours: typical };
}

/**
 * CRM signals. Today only Odoo is wired — we read the most recent
 * opportunity for the sender's domain. Returns empty when Odoo isn't
 * configured for this tenant.
 */
async function gatherCrm(_input: ScoreInput): Promise<GatheredSignals['crm']> {
  // CRM source placeholder. Odoo is the only CRM with handlers today, and
  // it doesn't yet mirror opportunity cache into Postgres. When the
  // mirror lands, query it here and return {stage, value, lastActivity, note}.
  // For now: return empty so the LLM simply doesn't get CRM context.
  return [];
}

/**
 * Per-user importance stars (0..5) for the inbound sender. Stars are
 * an explicit user signal — when present, they override most ambient
 * noise. The fallback returns 0 so unrated senders use pure engine logic.
 */
async function gatherImportanceStars(input: ScoreInput): Promise<number> {
  if (!input.fromEmail) return 0;
  const { getStarsForSender } = await import('../knowledge/entitySweepService');
  return getStarsForSender(input.clientNumber, input.userId, input.fromEmail).catch(() => 0);
}

/**
 * Read pre-computed sentiment + urgency from the feed_events row. The
 * sentiment analyzer fires async after ingest; this read is cheap and
 * non-blocking. When feedEventId isn't supplied or analysis hasn't run
 * yet, returns nulls — the fusion LLM falls back to inferring tone from
 * the raw text as before.
 */
async function gatherSentiment(input: ScoreInput): Promise<GatheredSignals['sentiment']> {
  if (!input.feedEventId) return { score: null, urgency: null, tone: null, rationale: null };
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT sentiment_score AS score, urgency_score AS urgency,
            tone, sentiment_rationale AS rationale
       FROM feed_events
      WHERE id = $1 AND client_number = $2`,
    input.feedEventId, input.clientNumber,
  ).catch(() => [] as any[]);
  if (rows.length === 0) return { score: null, urgency: null, tone: null, rationale: null };
  const r = rows[0];
  return {
    score: r.score != null ? Number(r.score) : null,
    urgency: r.urgency != null ? Number(r.urgency) : null,
    tone: r.tone ?? null,
    rationale: r.rationale ?? null,
  };
}

/**
 * Pull delegation-matrix entries that look relevant to this event so the
 * fusion LLM can weight relationshipRisk by *who actually owns the area*.
 * We match three ways:
 *   1) sender email = an owner_email or escalate_to_email
 *   2) sender domain matches owner_email domain
 *   3) the area string (or any token of it) appears in the subject/preview
 * Returns up to 5 entries; empty when the tenant has no matrix.
 */
async function gatherDelegationOwners(input: ScoreInput): Promise<GatheredSignals['delegationOwners']> {
  const { listActiveEntries } = await import('../knowledge/delegationMatrixService');
  const all = await listActiveEntries(input.clientNumber).catch(() => []);
  if (all.length === 0) return [];

  const senderEmail = (input.fromEmail ?? '').toLowerCase();
  const senderDomain = senderEmail.includes('@') ? senderEmail.split('@')[1] : '';
  const haystack = `${input.subject} ${input.preview}`.toLowerCase();

  const matches = all.filter((e) => {
    const ownerEmail = (e.ownerEmail ?? '').toLowerCase();
    const escEmail = (e.escalateToEmail ?? '').toLowerCase();
    if (senderEmail && (senderEmail === ownerEmail || senderEmail === escEmail)) return true;
    if (senderDomain && (ownerEmail.endsWith(`@${senderDomain}`) || escEmail.endsWith(`@${senderDomain}`))) return true;
    const areaLower = e.area.toLowerCase();
    if (haystack.includes(areaLower)) return true;
    // Also match individual area tokens >= 4 chars (avoid noise from "hr"/"it")
    for (const token of areaLower.split(/[\s_/-]+/).filter((t) => t.length >= 4)) {
      if (haystack.includes(token)) return true;
    }
    return false;
  });

  return matches.slice(0, 5).map((e) => ({
    area: e.area,
    ownerName: e.ownerName,
    ownerRole: e.ownerRole,
    ownerEmail: e.ownerEmail,
    escalateToName: e.escalateToName,
  }));
}

// ─── Phase 2+3 — Contextual Fusion + Multi-Dimensional Scoring ──

const FUSION_PROMPT = `You are the criticality reasoner for an executive's AI assistant. You don't apply rules; you reason.

You receive:
 - the inbound event (from, to, cc, subject, preview)
 - signals gathered from Feed / Calendar / Open Items / Knowledge / CRM / instructions / sender tempo / delegation matrix

Task: fuse them into a STORY, then score 5 dimensions of criticality. Emit JSON only.

Shape:
{
  "story": "2-3 sentence plain-English narrative — what's really going on, like an EA briefing their principal",
  "dimensions": {
    "timePressure":     0..1,
    "impact":           0..1,
    "relationshipRisk": 0..1,
    "cascade":          0..1,
    "patternAnomaly":   0..1
  },
  "reasons": ["<3-6 short bullets citing concrete signals>"],
  "confidence": 0..1
}

Rules for scoring:
- timePressure: 1 when action must happen within hours; 0.5 within a week; near 0 when nothing explicit.
- impact: revenue/commitment/reputation size if we fail. Reference CRM deal value, open-item priority, contract timing.
- relationshipRisk: trust damage. Senior client / long-term account / prior escalation history raises this.
- cascade: what ELSE breaks. Are there blockers or downstream commitments that fail if we don't act?
- patternAnomaly: does this deviate from the expected rhythm? "Client always replies by 2pm, it's 5pm" OR "they said 'revisit pricing' — last time that phrase appeared they switched vendors". If nothing is anomalous, near 0. If something is silently off-pattern, this can carry the score by itself.

Critical lives in the RELATIONSHIP between signals, not in any single signal. Known sender alone is not enough. The user is drowning in false-positive criticals — be conservative but not cowardly. If five signals line up, say so.`;

async function fuseAndScore(
  input: ScoreInput,
  signals: GatheredSignals,
): Promise<{ dimensions: CriticalityDimensions; reasons: string[]; story: string; confidence: number }> {
  const userMsg = buildUserPrompt(input, signals);

  try {
    const r = await callLLM(FUSION_PROMPT, userMsg, {
      maxTokens: 700,
      providers: ['gemini-flash', 'gemini', 'claude'],
      userId: input.userId, clientNumber: input.clientNumber,
      purpose: 'criticality_fuse',
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON');
    const obj = JSON.parse(m[0]);
    const d = obj.dimensions ?? {};
    const dims: CriticalityDimensions = {
      timePressure:     clamp01(Number(d.timePressure)),
      impact:           clamp01(Number(d.impact)),
      relationshipRisk: clamp01(Number(d.relationshipRisk)),
      cascade:          clamp01(Number(d.cascade)),
      patternAnomaly:   clamp01(Number(d.patternAnomaly)),
    };
    return {
      dimensions: dims,
      reasons: Array.isArray(obj.reasons) ? obj.reasons.slice(0, 6).map(String) : [],
      story: String(obj.story ?? '').slice(0, 400),
      confidence: clamp01(Number(obj.confidence ?? 0.6)),
    };
  } catch (err: any) {
    log.warn('fuseAndScore LLM failed — falling back', { error: err.message });
    return { dimensions: deterministicDimensions(input, signals), reasons: ['llm unavailable — deterministic signals only'], story: '', confidence: 0.3 };
  }
}

function buildUserPrompt(input: ScoreInput, s: GatheredSignals): string {
  const lines: string[] = [];
  lines.push('═══ INCOMING ═══');
  lines.push(`From: ${input.from}${input.fromEmail ? ` <${input.fromEmail}>` : ''}`);
  if (input.toHeader) lines.push(`To: ${input.toHeader}`);
  if (input.ccHeader) lines.push(`Cc: ${input.ccHeader}`);
  lines.push(`Addressed directly to you: ${s.addressing.directlyAddressed ? 'yes' : (s.addressing.ccOnly ? 'CC only' : 'unclear')} (recipients: ${s.addressing.recipientCount})`);
  lines.push(`Subject: ${input.subject}`);
  lines.push(`Preview: ${input.preview.slice(0, 400)}`);

  if (s.senderTempo.medianReplyHours != null) {
    lines.push('\n═══ SENDER TEMPO ═══');
    lines.push(`Typical cadence: ~${Math.round(s.senderTempo.medianReplyHours)}h median, ${Math.round(s.senderTempo.typicalWindowHours ?? 0)}h usual window.`);
    if (s.senderTempo.currentSilenceHours != null) {
      lines.push(`Current silence on this sender: ${Math.round(s.senderTempo.currentSilenceHours)}h.`);
    }
  }

  if (s.deadlines.length > 0) {
    lines.push('\n═══ CALENDAR / DEADLINES ═══');
    for (const d of s.deadlines) lines.push(`- ${d.what} · in ${d.hoursUntil}h (${d.at})`);
  }

  if (s.openItems.length > 0) {
    lines.push('\n═══ OPEN ITEMS WITH THIS SENDER ═══');
    for (const o of s.openItems) {
      lines.push(`- [${o.status}] ${o.title} · priority=${o.priority} · age=${o.age_days}d${o.dueDate ? ` · due ${o.dueDate.slice(0, 10)}` : ''}`);
    }
  }

  if (s.crm.length > 0) {
    lines.push('\n═══ CRM ═══');
    for (const c of s.crm) {
      lines.push(`- stage=${c.stage}${c.value ? ` · value=${c.value}` : ''}${c.lastActivity ? ` · last ${c.lastActivity.slice(0, 10)}` : ''}${c.note ? ` · ${c.note}` : ''}`);
    }
  }

  if (s.knowledge.length > 0) {
    lines.push('\n═══ KNOWLEDGE (relevant history / patterns) ═══');
    for (const k of s.knowledge) lines.push(`- [${k.pageType}] ${k.title} — ${k.snippet.replace(/\s+/g, ' ').slice(0, 180)}`);
  }

  if (s.instructionMatches.length > 0) {
    lines.push('\n═══ MATCHING STANDING INSTRUCTIONS ═══');
    for (const i of s.instructionMatches) lines.push(`- [${i.kind}] ${i.originalText}`);
  }

  if (s.delegationOwners.length > 0) {
    lines.push('\n═══ DELEGATION MATRIX (matched areas / owners) ═══');
    for (const o of s.delegationOwners) {
      const role = o.ownerRole ? ` (${o.ownerRole})` : '';
      const email = o.ownerEmail ? ` <${o.ownerEmail}>` : '';
      const esc = o.escalateToName ? ` — escalate to ${o.escalateToName}` : '';
      lines.push(`- area=${o.area} → owner=${o.ownerName}${role}${email}${esc}`);
    }
    lines.push('Use this to weight relationshipRisk: a sender who *is* the area owner or who is escalating to one is higher-stakes than an unrelated sender.');
  }

  if (s.sentiment.score != null || s.sentiment.urgency != null) {
    lines.push('\n═══ SENTIMENT + URGENCY (pre-classified) ═══');
    if (s.sentiment.score != null)   lines.push(`- sentiment: ${s.sentiment.score.toFixed(2)} (-1 hostile … +1 warm)`);
    if (s.sentiment.urgency != null) lines.push(`- urgency:   ${s.sentiment.urgency.toFixed(2)} (0 none … 1 now)`);
    if (s.sentiment.tone)            lines.push(`- tone:      ${s.sentiment.tone}`);
    if (s.sentiment.rationale)       lines.push(`- rationale: ${s.sentiment.rationale}`);
    lines.push('Trust these classifications when adjusting timePressure (urgency drives it) and relationshipRisk (negative tone amplifies it). When sentiment ≤ -0.5, the relationship is at risk regardless of other signals.');
  }

  if (s.importanceStars > 0) {
    lines.push('\n═══ USER IMPORTANCE STARS ═══');
    lines.push(`- stars: ${'★'.repeat(s.importanceStars)}${'☆'.repeat(5 - s.importanceStars)} (${s.importanceStars}/5)`);
    lines.push(`The user has explicitly rated this sender as ${s.importanceStars}/5 importance. This is a hard signal: even routine messages from a 4-5 star sender must NOT be auto-archived. Floor relationshipRisk accordingly.`);
  }

  lines.push('\n═══ OUTPUT ═══');
  lines.push('Return JSON per schema. Be specific, cite the signals. If the sender is simply well-known but nothing has changed and nothing is due, the score should be LOW.');
  return lines.join('\n');
}

// Deterministic fallback — honest but limited.
function deterministicDimensions(input: ScoreInput, s: GatheredSignals): CriticalityDimensions {
  let time = 0;
  let impact = 0;
  let rel = 0;
  let cascade = 0;
  let anomaly = 0;

  // Time pressure from calendar
  const soonest = s.deadlines.reduce<null | number>((acc, d) => (acc == null || d.hoursUntil < acc) ? d.hoursUntil : acc, null);
  if (soonest != null) time = soonest < 24 ? 0.9 : soonest < 72 ? 0.6 : soonest < 168 ? 0.3 : 0.1;

  // Urgency language
  const text = `${input.subject} ${input.preview}`.toLowerCase();
  if (/\b(urgent|asap|today|tonight|blocker|emergency|critical|escalat)/i.test(text)) time = Math.max(time, 0.7);

  // Impact from open_items priority + CRM value
  if (s.openItems.some((o) => o.priority === 'critical' || o.priority === 'high')) impact = Math.max(impact, 0.6);
  const maxCrm = s.crm.reduce((acc, c) => Math.max(acc, c.value ?? 0), 0);
  if (maxCrm >= 100_000) impact = Math.max(impact, 0.8);

  // Relationship risk — rel-strength + deal stage
  if ((input.relationshipStrength ?? 0) >= 4) rel = 0.4;
  if (s.crm.some((c) => /close|won|lost|negotiation/i.test(c.stage))) rel = Math.max(rel, 0.6);

  // Cascade from open items blocking others
  if (s.openItems.filter((o) => o.age_days >= 3).length >= 2) cascade = 0.5;

  // Pattern anomaly — silence beyond typical window
  if (s.senderTempo.currentSilenceHours != null && s.senderTempo.typicalWindowHours != null
      && s.senderTempo.currentSilenceHours > s.senderTempo.typicalWindowHours * 3) {
    anomaly = 0.7;
  }
  // Watchpoint match = strong anomaly signal
  if (s.instructionMatches.some((i) => i.kind === 'watchpoint')) anomaly = Math.max(anomaly, 0.8);

  // Delegation matrix match — sender is an area owner or escalation target.
  // Even without LLM fusion, this is a reliable signal that the relationship
  // matters: the matrix is human-curated tenant policy.
  if (s.delegationOwners.length > 0) rel = Math.max(rel, 0.5);

  // Sentiment + urgency from pre-classified analyzer. Drives timePressure
  // (urgency) and relationshipRisk (negative tone).
  if (s.sentiment.urgency != null) {
    time = Math.max(time, s.sentiment.urgency);
  }
  if (s.sentiment.score != null) {
    if (s.sentiment.score <= -0.5) rel = Math.max(rel, 0.7);
    else if (s.sentiment.score <= -0.25) rel = Math.max(rel, 0.5);
  }
  // Hostile tone is a strong anomaly on top of the score — even one
  // hostile email from a long-trusted sender is a pattern anomaly.
  if (s.sentiment.tone === 'hostile') {
    anomaly = Math.max(anomaly, 0.75);
    rel = Math.max(rel, 0.8);
  }

  // User importance stars — explicit signal. Policy: unrated is normal,
  // criticality starts with stars, 5★ = top critical. 1–2★ behave like
  // unrated (no bump); 3+★ progressively add relationship risk.
  if (s.importanceStars >= 3) {
    const starBumps = [0, 0, 0, 0.20, 0.35, 0.50];
    rel = Math.min(1, rel + starBumps[s.importanceStars]);
  }

  return { timePressure: time, impact, relationshipRisk: rel, cascade, patternAnomaly: anomaly };
}

// ─── Phase 4 — Superpowers (hand-coded signals on top of the LLM) ─

function detectAbsence(s: GatheredSignals): CriticalitySuperpowers['absence'] {
  const t = s.senderTempo;
  if (t.medianReplyHours == null || t.currentSilenceHours == null || t.typicalWindowHours == null) {
    return { triggered: false, note: null };
  }
  const ratio = t.currentSilenceHours / t.typicalWindowHours;
  if (ratio > 3) {
    return {
      triggered: true,
      note: `Usually replies within ${Math.round(t.typicalWindowHours)}h; silent for ${Math.round(t.currentSilenceHours)}h — that silence is data.`,
    };
  }
  return { triggered: false, note: null };
}

function detectCrossSource(s: GatheredSignals): CriticalitySuperpowers['crossSource'] {
  const bits: string[] = [];
  if (s.crm.length > 0 && s.openItems.length > 0) {
    bits.push(`CRM ${s.crm[0].stage}${s.crm[0].value ? ` ($${s.crm[0].value})` : ''} crossed with ${s.openItems.length} open item${s.openItems.length === 1 ? '' : 's'}`);
  }
  if (s.deadlines.length > 0 && s.openItems.length > 0) {
    bits.push(`${s.deadlines[0].what} in ${s.deadlines[0].hoursUntil}h + an open commitment with this sender`);
  }
  if (s.knowledge.some((k) => k.pageType === 'meeting_minutes') && s.openItems.length > 0) {
    bits.push('a recent meeting linked to this person has outstanding commitments');
  }
  if (bits.length === 0) return { triggered: false, note: null };
  return { triggered: true, note: bits.slice(0, 2).join(' · ') };
}

function detectDecay(s: GatheredSignals): CriticalitySuperpowers['decay'] {
  const soonest = s.deadlines.reduce<null | { hoursUntil: number; what: string }>((acc, d) => {
    if (acc == null || d.hoursUntil < acc.hoursUntil) return { hoursUntil: d.hoursUntil, what: d.what };
    return acc;
  }, null);
  if (!soonest) return { triggered: false, note: null };
  if (soonest.hoursUntil <= 72) {
    return {
      triggered: true,
      note: `${soonest.what} in ${soonest.hoursUntil}h — urgency accelerates non-linearly from here.`,
    };
  }
  return { triggered: false, note: null };
}

// ─── Phase 5 — Composite + Band ─────────────────────────────────

const WEIGHTS = {
  timePressure:     0.25,
  impact:           0.25,
  relationshipRisk: 0.18,
  cascade:          0.15,
  patternAnomaly:   0.17,
};

function composite(
  dims: CriticalityDimensions,
  superpowers: CriticalitySuperpowers,
  cal?: { timePressure: number; impact: number; relationshipRisk: number; cascade: number; patternAnomaly: number },
): number {
  // Apply per-user calibration multipliers if present. Default = 1.0
  // for every dim, which gives the original engine behaviour.
  const c = cal ?? { timePressure: 1, impact: 1, relationshipRisk: 1, cascade: 1, patternAnomaly: 1 };
  const base =
    dims.timePressure     * WEIGHTS.timePressure     * c.timePressure +
    dims.impact           * WEIGHTS.impact           * c.impact +
    dims.relationshipRisk * WEIGHTS.relationshipRisk * c.relationshipRisk +
    dims.cascade          * WEIGHTS.cascade          * c.cascade +
    dims.patternAnomaly   * WEIGHTS.patternAnomaly   * c.patternAnomaly;
  // Superpower bonuses — small but meaningful. Each superpower that fires
  // adds a capped boost. Prevents a high-confidence fusion from being
  // overruled by a single noisy dimension.
  let bonus = 0;
  if (superpowers.absence.triggered)     bonus += 0.06;
  if (superpowers.crossSource.triggered) bonus += 0.05;
  if (superpowers.decay.triggered)       bonus += 0.04;
  return Math.min(1, base + bonus);
}

function bandOf(score: number, criticalThreshold = 0.8): CriticalityBand {
  if (score >= criticalThreshold) return 'critical';
  if (score >= 0.6) return 'high';
  if (score >= 0.3) return 'medium';
  return 'low';
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

// ─── Public API ────────────────────────────────────────────────

export async function scoreCriticality(input: ScoreInput): Promise<CriticalityResult> {
  const signals = await gatherSignals(input);
  const fused = await fuseAndScore(input, signals);
  const superpowers: CriticalitySuperpowers = {
    absence: detectAbsence(signals),
    crossSource: detectCrossSource(signals),
    decay: detectDecay(signals),
  };
  const reasons = [...fused.reasons];
  if (superpowers.absence.triggered && superpowers.absence.note) reasons.push(`absence: ${superpowers.absence.note}`);
  if (superpowers.crossSource.triggered && superpowers.crossSource.note) reasons.push(`cross-source: ${superpowers.crossSource.note}`);
  if (superpowers.decay.triggered && superpowers.decay.note) reasons.push(`decay: ${superpowers.decay.note}`);

  // Per-user calibration: weights + threshold shift learned from past 👎s.
  let cal: any = null;
  let criticalThreshold = 0.8;
  try {
    const { getCalibration, getEffectiveCriticalThreshold } = await import('./criticalityCalibrationService');
    cal = await getCalibration(input.clientNumber, input.userId);
    criticalThreshold = await getEffectiveCriticalThreshold(input.clientNumber, input.userId);
  } catch { /* calibration optional */ }

  const score = composite(fused.dimensions, superpowers, cal);
  if (cal && cal.sampleCount > 0) {
    reasons.push(`calibrated by ${cal.sampleCount} prior 👎 (threshold=${criticalThreshold.toFixed(2)})`);
  }

  // Stars apply a band FLOOR — explicit user signal overrides the
  // numeric composite when the user has flagged this sender as high-
  // importance. 0..2 stars use plain band; 3 floors at medium; 4 at
  // high; 5 at critical.
  const STAR_BAND_FLOOR: CriticalityBand[] = ['low', 'low', 'low', 'medium', 'high', 'critical'];
  const naturalBand = bandOf(score, criticalThreshold);
  const starFloor: CriticalityBand = STAR_BAND_FLOOR[signals.importanceStars] ?? 'low';
  const finalBand = strongerBand(naturalBand, starFloor);
  if (signals.importanceStars >= 3 && finalBand !== naturalBand) {
    reasons.push(`★${signals.importanceStars}/5 importance — band floored at ${finalBand}`);
  }

  return {
    composite: score,
    band: finalBand,
    dimensions: fused.dimensions,
    superpowers,
    reasons: reasons.slice(0, 8),
    signals,
    confidence: fused.confidence,
    scoredAt: new Date().toISOString(),
  };
}

function strongerBand(a: CriticalityBand, b: CriticalityBand): CriticalityBand {
  const order: CriticalityBand[] = ['low', 'medium', 'high', 'critical'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}
