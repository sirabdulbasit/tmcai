/**
 * Sentiment + Urgency analyzer.
 *
 * Per-message classifier that adds three signals to every inbound feed
 * event:
 *   · sentiment   −1..+1  (very negative .. very positive)
 *   · urgency      0..1   (no time pressure .. respond now)
 *   · tone        bucket  (collaborative | neutral | frustrated | hostile |
 *                          transactional | positive_warm)
 *
 * Why a separate service: the criticality engine already reasons about
 * tone implicitly via its 5-dim LLM fusion, but blends it into the
 * composite score. Surfacing sentiment + urgency as their own columns
 * lets Risk Radar, gate rules, and the auto-response ladder consume
 * each independently — and lets the UI show "anything that arrived
 * angry today" as a filter.
 *
 * Implementation: one LLM call per event using the cheap model
 * (gemini-flash by default), so cost stays bounded. Deterministic fallback
 * runs against a regex/keyword scorer if the LLM is unavailable.
 *
 * Multi-tenant: every read scopes by clientNumber. We never analyze
 * across tenants.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { callLLM } from '../llmRouter';
import { safeSlice } from '../../utils/utf8';

const log = createLogger('sentiment');

export type Tone =
  | 'collaborative'
  | 'neutral'
  | 'frustrated'
  | 'hostile'
  | 'transactional'
  | 'positive_warm';

export interface SentimentResult {
  sentiment: number;     // -1..+1
  urgency: number;       //  0..1
  tone: Tone;
  rationale: string;
}

const ANALYZER_SYSTEM = `You analyze the SENDER'S sentiment and urgency in inbound business messages (email, chat, WhatsApp).

Output ONLY a JSON object on a single line:
{"sentiment": <number -1..1>, "urgency": <number 0..1>, "tone": "<bucket>", "rationale": "<one sentence>"}

sentiment scale (the SENDER's emotional valence toward the user/topic):
  -1.0 = furious / hostile / threatening
  -0.5 = clearly frustrated / disappointed
   0.0 = neutral, factual, transactional
  +0.5 = friendly / collaborative
  +1.0 = warm / appreciative / very positive

urgency scale (independent of sentiment — a polite request can be high-urgency):
   0.0 = no time pressure (FYI, archival, general update)
   0.3 = soon-ish (this week)
   0.6 = today or tomorrow
   0.9 = within hours / blocking
   1.0 = NOW (escalation, outage, deadline at minutes)

tone bucket (pick exactly one):
  collaborative  — constructive, working together
  neutral        — flat, informational
  frustrated     — annoyed but still professional
  hostile        — angry, threatening, attacking
  transactional  — pure business, formal, terse
  positive_warm  — appreciative, friendly, complimentary

Rules:
- Score the SENDER's tone, not the topic. A polite message about a fire is sentiment≈0, urgency=high.
- If the sender is clearly frustrated/hostile, sentiment must be < 0 even if they're polite.
- "ASAP" / "urgent" / "blocker" / "fire" / "outage" → urgency >= 0.8.
- "by EOD" / "today" / "soon" → urgency 0.5–0.7.
- "no rush" / "whenever you have time" / "FYI" → urgency 0.0–0.2.
- Do NOT include any text outside the JSON object.`;

const MAX_PREVIEW_CHARS = 1200;

/**
 * Analyze a single message. Returns sentiment + urgency + tone, falling
 * back to a deterministic scorer if the LLM is unavailable. Cheap by
 * design — one short call to the flash model.
 */
export async function analyzeMessage(input: {
  clientNumber: string;
  userId: number | null;
  subject: string;
  body: string;
  sourceType?: string;
}): Promise<SentimentResult> {
  const userMessage = buildUserPrompt(input);

  // Try LLM first; on failure fall through to deterministic scoring so
  // the field stays populated and the rest of the pipeline keeps working.
  try {
    const r = await callLLM(ANALYZER_SYSTEM, userMessage, {
      maxTokens: 200,
      providers: ['gemini-flash', 'gemini', 'claude'],
      userId: input.userId ?? undefined,
      clientNumber: input.clientNumber,
      purpose: 'sentiment_classify',
      timeoutMs: 8000,
    });
    const parsed = parseLlmJson(r.text);
    if (parsed) return parsed;
  } catch (err: any) {
    log.warn('LLM sentiment failed, falling back', { error: err.message });
  }
  return deterministicScore(input.subject, input.body);
}

/**
 * Enrich a feed_event by id. Idempotent; skip-on-noop when already
 * analyzed and the body hasn't changed. Called from the on-event hook
 * AND from the backfill cron.
 */
export async function enrichFeedEvent(eventId: string): Promise<{ updated: boolean; result?: SentimentResult }> {
  const ev = await prisma.feedEvent.findUnique({
    where: { id: eventId },
    select: {
      id: true, clientNumber: true, userId: true,
      sentimentAnalyzedAt: true,
      rawPayload: true, sourceType: true,
    },
  });
  if (!ev) return { updated: false };
  if (ev.sentimentAnalyzedAt) return { updated: false }; // already done

  const payload = (ev.rawPayload ?? {}) as Record<string, unknown>;
  const subject = String((payload as any).subject ?? (payload as any).summary ?? (payload as any).title ?? '');
  const body = String((payload as any).body ?? (payload as any).text ?? (payload as any).snippet ?? (payload as any).description ?? '');
  if (!subject && !body) {
    // Nothing to analyze. Mark as analyzed-with-defaults so we don't loop.
    await prisma.feedEvent.update({
      where: { id: ev.id },
      data: {
        sentimentScore: 0, urgencyScore: 0,
        tone: 'neutral',
        sentimentRationale: 'No subject or body to analyze.',
        sentimentAnalyzedAt: new Date(),
      } as any,
    });
    return { updated: true, result: { sentiment: 0, urgency: 0, tone: 'neutral', rationale: 'No content.' } };
  }

  const result = await analyzeMessage({
    clientNumber: ev.clientNumber,
    userId: ev.userId ?? null,
    subject, body, sourceType: ev.sourceType,
  });

  await prisma.feedEvent.update({
    where: { id: ev.id },
    data: {
      sentimentScore: clamp(result.sentiment, -1, 1),
      urgencyScore: clamp(result.urgency, 0, 1),
      tone: result.tone,
      // safeSlice (not slice): rationale can contain emoji; a plain
      // slice can cut one in half leaving a lone surrogate → PG 22021.
      sentimentRationale: safeSlice(result.rationale, 1000),
      sentimentAnalyzedAt: new Date(),
    } as any,
  });
  return { updated: true, result };
}

/**
 * Backfill any unanalyzed feed events for a tenant. Used by the
 * scheduled cron — runs in batches so a backlog doesn't hammer the LLM.
 */
export async function backfillTenant(
  clientNumber: string,
  opts: { batchSize?: number; lookbackDays?: number } = {},
): Promise<{ scanned: number; updated: number; failed: number }> {
  const batchSize = opts.batchSize ?? 25;
  const lookback = opts.lookbackDays ?? 7;
  const ids = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM feed_events
      WHERE client_number = $1
        AND sentiment_analyzed_at IS NULL
        AND created_at >= NOW() - (INTERVAL '1 day' * $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    clientNumber, lookback, batchSize,
  ).catch(() => [] as Array<{ id: string }>);

  let updated = 0, failed = 0;
  for (const row of ids) {
    try {
      const r = await enrichFeedEvent(row.id);
      if (r.updated) updated += 1;
    } catch (err: any) {
      failed += 1;
      log.warn('backfill enrich failed', { id: row.id, error: err.message });
    }
  }
  return { scanned: ids.length, updated, failed };
}

export async function backfillAllTenants(): Promise<{ tenants: number; aggregate: { scanned: number; updated: number; failed: number } }> {
  const tenants = await prisma.$queryRawUnsafe<Array<{ client_number: string }>>(
    `SELECT DISTINCT client_number
       FROM feed_events
      WHERE sentiment_analyzed_at IS NULL
        AND created_at >= NOW() - INTERVAL '7 days'`,
  );
  const agg = { scanned: 0, updated: 0, failed: 0 };
  for (const t of tenants) {
    const r = await backfillTenant(t.client_number).catch(() => ({ scanned: 0, updated: 0, failed: 1 }));
    agg.scanned += r.scanned; agg.updated += r.updated; agg.failed += r.failed;
  }
  return { tenants: tenants.length, aggregate: agg };
}

// ─── helpers ──────────────────────────────────────────────────────

function buildUserPrompt(input: { subject: string; body: string; sourceType?: string }): string {
  const lines: string[] = [];
  if (input.sourceType) lines.push(`SOURCE: ${input.sourceType}`);
  if (input.subject) lines.push(`SUBJECT: ${input.subject.slice(0, 200)}`);
  lines.push(`MESSAGE:`);
  lines.push((input.body || '').slice(0, MAX_PREVIEW_CHARS));
  return lines.join('\n');
}

function parseLlmJson(text: string): SentimentResult | null {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    const sentiment = clamp(Number(obj.sentiment), -1, 1);
    const urgency = clamp(Number(obj.urgency), 0, 1);
    const tone = normaliseTone(String(obj.tone ?? 'neutral'));
    const rationale = String(obj.rationale ?? '').slice(0, 500);
    if (!Number.isFinite(sentiment) || !Number.isFinite(urgency)) return null;
    return { sentiment, urgency, tone, rationale };
  } catch { return null; }
}

function normaliseTone(t: string): Tone {
  const lower = t.toLowerCase().trim();
  const valid: Tone[] = ['collaborative', 'neutral', 'frustrated', 'hostile', 'transactional', 'positive_warm'];
  return valid.includes(lower as Tone) ? (lower as Tone) : 'neutral';
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Deterministic fallback used when the LLM is unavailable. Less
 * accurate but keeps the pipeline running. Pure function — no I/O.
 */
function deterministicScore(subject: string, body: string): SentimentResult {
  const text = `${subject} ${body}`.toLowerCase();
  let sentiment = 0;
  let urgency = 0;
  let tone: Tone = 'neutral';

  // Negative signals
  const NEG = /\b(unacceptable|disappoint|frustrat|angry|furious|outraged|terrible|awful|complain|escalate|lawyer|legal action|breach|refund|cancel|wrong|fail|broken|issue|problem|concern)/;
  const HOSTILE = /\b(threaten|sue|lawsuit|fraud|scam|incompetent|worst|never again|fired|terminate)/;
  // Positive signals
  const POS = /\b(thank|thanks|appreciate|grateful|excellent|wonderful|amazing|congratulations|congrats|well done|great work|love it|perfect)/;
  const WARM = /\b(thank you so much|truly appreciate|means a lot|hope you|warmly|cheers|best regards)/;
  // Urgency signals
  const HIGH_URG = /\b(urgent|asap|immediately|now|right away|emergency|critical|blocker|outage|fire|escalation)/;
  const MED_URG  = /\b(today|by eod|tomorrow|by morning|by tonight|deadline|due)/;
  const LOW_URG  = /\b(no rush|when you can|whenever|fyi|for your information|in due course|sometime)/;

  if (HOSTILE.test(text)) { sentiment = -0.85; tone = 'hostile'; }
  else if (NEG.test(text)) { sentiment = -0.4; tone = 'frustrated'; }
  if (WARM.test(text)) { sentiment = Math.max(sentiment, 0.7); if (tone === 'neutral') tone = 'positive_warm'; }
  else if (POS.test(text)) { sentiment = Math.max(sentiment, 0.4); if (tone === 'neutral') tone = 'collaborative'; }

  if (HIGH_URG.test(text)) urgency = 0.85;
  else if (MED_URG.test(text)) urgency = 0.55;
  else if (LOW_URG.test(text)) urgency = 0.1;
  else urgency = 0.25;

  // Default to transactional if we have nothing strong either way
  if (tone === 'neutral' && sentiment === 0 && urgency < 0.3) tone = 'transactional';

  return {
    sentiment,
    urgency,
    tone,
    rationale: `Deterministic fallback (no LLM): keyword-based estimate.`,
  };
}
