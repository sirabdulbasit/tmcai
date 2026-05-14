/**
 * Commitment extractor — when the user (or Brain on the user's behalf)
 * sends an outbound message that contains a promise — "I'll send the
 * deck Monday", "we'll get back to you tomorrow", "I'll have it by EOD"
 * — file an `open_item` so the system can track and follow up.
 *
 * Closes the OI-001 / OI-007 / OI-008 gap from the self-test:
 *   - "Verify brain auto-creates open item from promise"
 *   - "Verify brain maintains commitment register accuracy"
 *   - "Verify brain detects commitments across all channels"
 *
 * Two-stage approach:
 *   1. Cheap regex pre-filter — only ~30% of outbound messages contain
 *      commitment phrasing. Skip the LLM call when the regex misses.
 *   2. Gemini Flash structured extraction — pulls each commitment with
 *      what / when / who-it's-to / confidence. Files an open_item per
 *      commitment with the SOURCE chain pointing back at the message
 *      that contained it (channel-agnostic: email, WhatsApp, Slack…).
 *
 * Idempotent: keyed on `(channel, sourceRef)` — same outbound message
 * can be re-processed without duplicating items. Commitments below
 * confidence 0.55 are skipped.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { callLLM } from '../llmRouter';

const log = createLogger('commitment-extractor');

// Regex pre-filter — must match before we burn an LLM call.
const COMMITMENT_HINT = /\b(i(?:'ll| will)|we(?:'ll| will)|i(?:'m| am) going to|we(?:'re| are) going to|let me|i can|will (?:send|share|provide|deliver|circle back|follow up|get back|review|prepare|draft|finalize|confirm|update|loop)|by (?:eod|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|end of week|cob)|expect (?:it|this|to receive)|getting back to you|reply by|done by)\b/i;

export interface ExtractInput {
  clientNumber: string;
  userId: number;
  /** What channel sent it. */
  channel: 'email' | 'whatsapp' | 'chat' | 'slack' | 'meeting' | 'manual';
  /** Stable identifier of the outbound message — used for idempotency. */
  sourceRef: string;
  /** The message body (plain text). */
  body: string;
  /** Recipient handle (email / phone / display name). */
  recipient?: string | null;
  /** Optional subject line for emails. */
  subject?: string | null;
  /** When the message was sent. */
  sentAt: Date;
}

interface ExtractedCommitment {
  text: string;                  // "send the updated proposal"
  dueAt: string | null;          // ISO if explicit, else null
  recipientHint: string | null;  // "to legal" / "for Sarah"
  confidence: number;
}

const EXTRACTOR_PROMPT = `You read an outbound business message and extract every COMMITMENT the sender just made. A commitment is a future action the sender promised to do, deliver, or follow up on. NOT a description, NOT a question, NOT past tense.

Return ONE JSON object:

{
  "commitments": [
    {
      "text": "short imperative — 'send the updated proposal', 'review the contract', 'call them back'",
      "dueAt": "ISO8601 datetime if EXPLICITLY stated (Monday EOD, by Friday, tomorrow 5pm — resolve relative to the sentAt date provided). null if not stated.",
      "recipientHint": "to whom or for what — 'to legal', 'for Sarah', 'for the board' — or null",
      "confidence": 0.0-1.0
    }
  ]
}

Rules:
- "I will think about it" — commitment, low confidence (~0.3).
- "I'll send the deck Monday" — commitment, dueAt=Monday 17:00 local, confidence ~0.9.
- "We sent the deck yesterday" — NOT a commitment (past tense).
- "Could you send the deck?" — NOT a commitment (asking the other side).
- "Sounds good" / "OK" / acknowledgments alone — no commitments.
- META-STATEMENTS about using the tooling itself are NEVER commitments. Phrases like "I'll add this as an open item", "let me note this down", "I'll put this in my system", "I'll add this to my list", "I'll track this", "noting this in Nexeo", "I'll add to open items" describe the user reaching for a feature — they are not promises to a third party. Skip them. If the ENTIRE message is meta ("I'll add this as an open item for Phoenix pricing"), return {"commitments": []}. If the message MIXES a real commitment with a meta-statement ("I'll send the deck Monday and I'll add this as an open item"), extract ONLY the real commitment ("send the deck Monday"), drop the meta.
- If the message has none, return {"commitments": []}.
- Never invent due dates. If the user said "soon", dueAt=null.
- Output JSON only.`;

export interface ExtractResult {
  openItemIds: string[];
  commitmentsFound: number;
  skipped: 'no_hint' | 'already_processed' | null;
}

export async function extractAndFileCommitments(input: ExtractInput): Promise<ExtractResult> {
  // 0. Idempotency — never file twice for the same outbound message.
  const existing = await prisma.openItem.findFirst({
    where: {
      clientNumber: input.clientNumber, userId: input.userId,
      sourceFeed: 'commitment',
      sourceRef: `${input.channel}:${input.sourceRef}`,
    },
    select: { id: true },
  }).catch(() => null);
  if (existing) {
    return { openItemIds: [], commitmentsFound: 0, skipped: 'already_processed' };
  }

  // 1. Cheap regex pre-filter
  if (!COMMITMENT_HINT.test(input.body)) {
    return { openItemIds: [], commitmentsFound: 0, skipped: 'no_hint' };
  }

  // 2. LLM extraction
  const userMsg = [
    `sentAt: ${input.sentAt.toISOString()}`,
    `channel: ${input.channel}`,
    input.subject ? `subject: ${input.subject}` : '',
    input.recipient ? `recipient: ${input.recipient}` : '',
    '',
    '---- MESSAGE BODY ----',
    input.body.slice(0, 4000),
  ].filter(Boolean).join('\n');

  let parsed: { commitments: ExtractedCommitment[] };
  try {
    const r = await callLLM(EXTRACTOR_PROMPT, userMsg, {
      maxTokens: 600,
      providers: ['gemini-flash', 'gemini', 'claude'],
      userId: input.userId, clientNumber: input.clientNumber,
      purpose: 'commitment_extract',
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return { openItemIds: [], commitmentsFound: 0, skipped: null };
    parsed = JSON.parse(m[0]);
  } catch (err: any) {
    log.warn('commitment LLM failed', { sourceRef: input.sourceRef, error: err.message });
    return { openItemIds: [], commitmentsFound: 0, skipped: null };
  }

  const commitments = Array.isArray(parsed?.commitments) ? parsed.commitments : [];
  const openItemIds: string[] = [];
  for (const c of commitments) {
    if (!c?.text || c.confidence == null || c.confidence < 0.55) continue;

    const due = c.dueAt && Number.isFinite(Date.parse(c.dueAt)) ? new Date(c.dueAt) : null;
    const description = [
      `Source: ${input.channel} message sent ${input.sentAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      input.recipient ? `To: ${input.recipient}` : '',
      input.subject ? `Subject: ${input.subject}` : '',
      c.recipientHint ? `Hint: ${c.recipientHint}` : '',
      due ? `Stated due: ${due.toISOString()}` : '',
      '',
      `Extracted from outbound message (confidence ${c.confidence.toFixed(2)}).`,
    ].filter(Boolean).join('\n');

    try {
      const created = await prisma.openItem.create({
        data: {
          clientNumber: input.clientNumber,
          userId: input.userId,
          title: c.text.slice(0, 480),
          description,
          type: 'task',
          status: 'NEW',
          priority: c.confidence >= 0.85 ? 'high' : 'medium',
          ownerId: input.userId,             // user owns their own commitments
          dueDate: due,
          sourceFeed: 'commitment',
          sourceRef: `${input.channel}:${input.sourceRef}`,
          archetype: 'reply_needed',
          metadata: {
            source: {
              kind: 'commitment',
              channel: input.channel,
              sentAt: input.sentAt.toISOString(),
              recipient: input.recipient ?? null,
              recipientHint: c.recipientHint ?? null,
              extractionConfidence: c.confidence,
              sourceMessageRef: input.sourceRef,
            },
          } as any,
        },
      });
      openItemIds.push(created.id);
    } catch (err: any) {
      log.warn('commitment open_item create failed', { text: c.text, error: err.message });
    }
  }

  log.info('commitments extracted', {
    userId: input.userId, channel: input.channel,
    sourceRef: input.sourceRef, found: commitments.length, filed: openItemIds.length,
  });
  return { openItemIds, commitmentsFound: commitments.length, skipped: null };
}
