/**
 * Voice / text instruction extractor.
 *
 * Takes a free-form transcript (Urdu / English / mixed) plus the user's
 * recent feed_events as context, and returns a structured Intent the
 * dispatcher can execute. The LLM does the heavy lifting — pattern-
 * matching imperatives, identifying which "this email" the user is
 * referring to, normalising sender references against recent items.
 *
 * Intent vocabulary (MVP):
 *   mute_sender         — never surface from this sender again
 *   unmute_sender       — undo a mute
 *   draft_reply         — Brain composes a reply on a specific feed_event
 *   delegate            — forward to a colleague with an instruction note
 *   schedule_meeting    — add a calendar event linked to this thread
 *   add_open_item       — track as a follow-up, optional due date
 *   set_window          — adjust attention/brief windows
 *   none                — not an instruction; let normal triage handle it
 *
 * Context match: the LLM is told about the user's last ~30 feed_events
 * (id, sender, subject) so phrases like "this email" / "reply to Yousuf"
 * resolve to a real feedEventId. confidence < 0.6 → returns 'none'.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { callLLM } from '../llmRouter';

const log = createLogger('instruction-extractor');

export type InstructionIntent =
  | 'none'
  | 'mute_sender'
  | 'unmute_sender'
  | 'draft_reply'
  | 'delegate'
  | 'schedule_meeting'
  | 'cancel_meeting'
  | 'reschedule_meeting'
  | 'add_open_item'
  | 'set_window';

export interface ExtractedInstruction {
  intent: InstructionIntent;
  confidence: number; // 0..1
  targetFeedEventId?: string;
  params: {
    /** mute / unmute */
    senderIdentifier?: string;
    senderChannel?: 'email' | 'whatsapp' | 'gchat' | 'other';
    /** draft_reply */
    replyIntent?: string;       // "tell them yes, schedule for Friday"
    /** delegate */
    delegateeName?: string;
    delegateeEmail?: string;
    delegateeNote?: string;
    /** schedule_meeting */
    meetingTitle?: string;
    meetingWhen?: string;       // ISO or natural language ("tomorrow 3pm")
    meetingAttendees?: string[]; // names or emails
    meetingDurationMin?: number;
    /** cancel_meeting / reschedule_meeting — eventId comes from Brain's
     *  recent artifacts block (the eventId returned by a prior
     *  successful schedule_meeting dispatch). */
    eventId?: string;
    titleHint?: string;
    reason?: string;
    /** reschedule_meeting */
    newWhenIso?: string;
    newDurationMin?: number;
    /** add_open_item */
    itemTitle?: string;
    itemDueDate?: string;
    itemNote?: string;
    /** set_window */
    attentionWindowDays?: number;
    briefWindowDays?: number;
  };
  /** Plain-English summary of what Brain is about to do; used in the
   *  WhatsApp confirmation reply. */
  summary: string;
}

interface FeedContextItem {
  id: string;
  sourceType: string;
  senderEmail: string | null;
  senderName: string | null;
  subject: string;
  preview: string;
  receivedAt: string;
}

async function recentFeedContext(
  clientNumber: string,
  userId: number,
  excludeFeedEventId: string | null,
): Promise<FeedContextItem[]> {
  const rows = await prisma.feedEvent.findMany({
    where: {
      clientNumber,
      userId,
      ...(excludeFeedEventId ? { id: { not: excludeFeedEventId } } : {}),
    } as any,
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: {
      id: true, sourceType: true, senderEmail: true, senderName: true,
      rawPayload: true, eventAt: true, createdAt: true,
    } as any,
  }).catch(() => [] as any[]);

  // 2026-05-13 Brain-mute filter: drop feed events from senders the
  // user marked Private. The LLM delegate-to context should not see
  // Brain-muted contacts even as background context — otherwise Brain
  // could resolve "send Ali a reminder" to a Private Ali entry.
  const { getBrainMutedSenders } = await import('../knowledge/brainMuteService');
  const brainMuted = await getBrainMutedSenders(clientNumber, userId);
  const filtered = (brainMuted.emails.size === 0 && brainMuted.phones.size === 0)
    ? rows
    : rows.filter((r: any) => {
        const email = String(r.senderEmail ?? '').toLowerCase();
        if (email && brainMuted.emails.has(email)) return false;
        const p: any = r.rawPayload ?? {};
        const phone = String(p.from ?? p.senderPhone ?? '').replace(/[^\d+]/g, '');
        if (phone && brainMuted.phones.has(phone)) return false;
        return true;
      });

  return filtered.map((r: any) => {
    const p: any = r.rawPayload ?? {};
    return {
      id: r.id,
      sourceType: r.sourceType,
      senderEmail: r.senderEmail,
      senderName: r.senderName,
      subject: String(p.subject ?? p.title ?? p.summary ?? '').slice(0, 140),
      preview: String(p.snippet ?? p.body ?? '').slice(0, 200),
      receivedAt: (r.eventAt ?? r.createdAt).toISOString(),
    };
  });
}

const SYSTEM_PROMPT = `You convert a busy executive's free-form voice / text instruction into a single structured action. The instruction may be in English, Urdu, or mixed.

You receive:
  - The transcript (the user's instruction)
  - A list of the user's recent feed_events (id + sender + subject + preview + when), so you can resolve references like "this email", "reply to Yousuf", "delegate that meeting".

Output ONLY a JSON object — no preamble, no markdown:
{
  "intent": "mute_sender" | "unmute_sender" | "draft_reply" | "delegate" | "schedule_meeting" | "add_open_item" | "set_window" | "none",
  "confidence": 0.0-1.0,
  "targetFeedEventId": "<id from context list, or null>",
  "params": { ... shape depends on intent ... },
  "summary": "<one short sentence describing what Brain is about to do, written for the user>"
}

Rules per intent:

  mute_sender / unmute_sender →
    params: { senderIdentifier: "<email-or-phone>", senderChannel: "email" | "whatsapp" | ... }
    Resolve identifier from context if user said only a name.

  draft_reply →
    targetFeedEventId required (the email being replied to).
    params: { replyIntent: "<one-sentence instruction Brain will polish into the email>" }

  delegate →
    targetFeedEventId required.
    params: { delegateeName: "<name>", delegateeEmail: "<resolved if known>", delegateeNote: "<full instruction the colleague should see>" }
    Pull delegateeNote VERBATIM from the user's words — it is the operating instruction. Don't paraphrase aggressively.

  schedule_meeting →
    params: { meetingTitle, meetingWhen (ISO or natural), meetingDurationMin (default 30), meetingAttendees: ["names or emails"] }
    targetFeedEventId optional — set if the meeting is "to discuss THIS thread".

  add_open_item →
    params: { itemTitle, itemDueDate (ISO or natural), itemNote }

  set_window →
    params: { attentionWindowDays?: 7..90, briefWindowDays?: 1..30 }

  none →
    Use this when the input isn't an actionable instruction (chitchat, partial sentence, ambiguous). Set confidence < 0.4.

If the instruction looks valid but you can't pin it to a specific feed_event when one is needed, lower confidence to ~0.5.

Be strict: if the user is just chatting, return intent: "none".`;

export async function extractInstruction(args: {
  text: string;
  clientNumber: string;
  userId: number;
  triggerFeedEventId?: string | null; // if this came from a voice note feed_event, exclude self from context
}): Promise<ExtractedInstruction> {
  const text = (args.text ?? '').trim();
  if (!text) return { intent: 'none', confidence: 0, params: {}, summary: '' };

  // Quick heuristic guard so we don't burn tokens on obvious non-
  // instructions ("ok", "thanks", emoji-only).
  if (text.length < 8 && !/[؀-ۿ]/.test(text)) {
    return { intent: 'none', confidence: 0, params: {}, summary: '' };
  }

  const ctx = await recentFeedContext(args.clientNumber, args.userId, args.triggerFeedEventId ?? null);
  const ctxBlock = ctx
    .map((c, i) => `[${i + 1}] id=${c.id} src=${c.sourceType} from=${c.senderName ?? c.senderEmail ?? 'unknown'} subject="${c.subject}" preview="${c.preview.slice(0, 100)}" at=${c.receivedAt}`)
    .join('\n');

  const userMessage = `Recent feed (most recent first):

${ctxBlock || '(no recent items)'}

────────────────

Instruction: ${text}

JSON:`;

  try {
    const r = await callLLM(SYSTEM_PROMPT, userMessage, {
      maxTokens: 600,
      providers: ['gemini-flash', 'gemini', 'claude'],
      userId: args.userId,
      clientNumber: args.clientNumber,
      purpose: 'instruction_extract',
      timeoutMs: 15_000,
    });
    const match = r.text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no json in response');
    const parsed = JSON.parse(match[0]);
    const intent = (parsed.intent ?? 'none') as InstructionIntent;
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    return {
      intent,
      confidence,
      targetFeedEventId: typeof parsed.targetFeedEventId === 'string' ? parsed.targetFeedEventId : undefined,
      params: parsed.params ?? {},
      summary: String(parsed.summary ?? '').slice(0, 240),
    };
  } catch (err: any) {
    log.warn('extract failed', { error: err.message });
    return { intent: 'none', confidence: 0, params: {}, summary: '' };
  }
}
