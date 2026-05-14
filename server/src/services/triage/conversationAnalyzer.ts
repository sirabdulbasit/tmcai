/**
 * Conversation Analyzer — Phase 2 of WhatsApp unit-of-attention work.
 *
 * Takes a WhatsApp conversation thread (last N turns, both sides) and
 * answers: what topics are being discussed, and per topic, is there an
 * open loop pointing at the user, pointing at them, or already closed?
 *
 * The output drives My Attention's WA card layout: instead of one
 * decision per conversation, we surface multiple loops as bullets when
 * topics shift (Project Phoenix → vendor pricing → personal favor).
 *
 * Brain-like reasoning, not regex:
 * - "Coming" / "On it" / "Doing" only mean something with a referent.
 *   Brain reads the prior message that opened the loop.
 * - Topic clusters can interleave — Hunain talks about Phoenix, then a
 *   vendor, then back to Phoenix. The LLM resolves these holistically;
 *   we don't try to segment with rules.
 * - Default to "no loops" when the conversation is genuinely casual
 *   (greetings, blessings, chitchat). The card auto-handles to Brief
 *   when zero loops point at the user.
 *
 * Why a separate service: the criticality engine already runs per
 * event with rich context. Conversation analysis is per CONVERSATION —
 * a different unit and different prompt. Keeping the engines distinct
 * makes both prompts simpler. The criticality engine still scores the
 * representative event; the conversation analyzer handles the
 * loop-state question on top.
 */
import createLogger from '../../utils/logger';
import { callLLM } from '../llmRouter';
import type { ThreadTurn } from '../whatsapp/UserWebjsProvider';

const log = createLogger('conv-analyzer');

export type LoopSide = 'user' | 'them' | null;

export type LoopType =
  | 'decision_required'   // they ask MD a yes/no or judgement question
  | 'scheduling'           // pick a time / confirm availability
  | 'info_request'         // share data, send a doc, answer a fact
  | 'task_handoff'         // someone is supposed to DO something
  | 'casual';              // chitchat, greetings, blessings — no action

export interface ConversationLoop {
  /** 2-5 word topic label, e.g. "Project Phoenix budget", "Vendor call" */
  topic: string;
  /** The actual ask in plain English, or null for casual loops */
  ask: string | null;
  /** Who the loop is currently pointing at — null if closed or casual */
  openWith: LoopSide;
  /** HH:MM of the message that opened the loop (or null) */
  askedAt: string | null;
  /** For closed loops: how it closed (e.g. "MD delegated to Asad"). null otherwise. */
  resolution: string | null;
  /** HH:MM of the message that closed the loop (or null) */
  closedAt: string | null;
  /** What kind of loop — drives the card's per-loop action affordances */
  type: LoopType;
}

export interface ConversationAnalysis {
  /** One-sentence executive summary of the whole conversation */
  summary: string;
  /** Discrete loops detected — empty if conversation has no actionable content */
  loops: ConversationLoop[];
  /** Convenience flag — true if any loop has openWith === 'user' */
  hasOpenLoopWithUser: boolean;
  /** Provider used / "cache" for the cached path */
  provider: string;
}

// ─── Cache ─────────────────────────────────────────────────────
// Key on (clientNumber + senderKey + latest message id). When the
// conversation gets new messages, the latest id changes → cache miss
// → fresh analysis. Otherwise we return the cached result. 30-min TTL
// covers the case where a conversation is "frozen" (no new messages)
// across many triage cycles.
interface CacheEntry {
  analysis: ConversationAnalysis;
  cachedAt: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000;

function cacheKey(clientNumber: string, senderKey: string, latestEventId: string): string {
  return `${clientNumber}::${senderKey}::${latestEventId}`;
}

// ─── Prompt ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an executive assistant reading a WhatsApp conversation between the user (referred to as "you" in your output) and one contact. The user doesn't have time to read every message — your job is to identify the ACTIONABLE LOOPS in the conversation so they can focus only on what genuinely needs them.

IMPORTANT terminology: in every output field (summary, ask, resolution, etc.) refer to the user as "you" — never "MD", never "the MD", never any other label. The user reads these as their own day brief, so second-person is the natural voice. Refer to the other party by their actual name (e.g. "Azhar", not "the contact").

A "loop" is a topic-scoped exchange. Same topic across multiple turns = ONE loop, even if the conversation interleaves with other topics. Loop states:

  - openWith=user: someone (usually them) has opened a loop you must answer or act on. e.g. "Can you confirm the price?" "When are you back?" "Please review this draft."
  - openWith=them: you have asked something they haven't answered yet. e.g. you said "Send me the SOW" and they haven't sent it.
  - closed: a loop that has been completed. Their ack ("Ok", "Done", "On it", "Coming") closes a prior ask of yours. Your substantive reply closes their ask.
  - casual: chitchat with no actionable element — greetings, blessings, expressions of thanks. ONE loop max for the entire casual stretch, type='casual'.

Critical reasoning rules:

  1. A short ack ("Ok", "Coming", "Doing", "On it") on its own is NOT a loop. Look at what it's responding to. If you said "Are you coming at 4pm?" and they reply "Coming" — that CLOSES the scheduling loop. Don't surface "Coming" as a new open loop.

  2. If you asked something and the contact has NOT yet replied substantively, that's openWith=them — you are waiting on them, not the other way around. Surface it so you know what's outstanding from the other side.

  3. Topics CAN interleave. Don't fragment a topic into multiple loops just because it spans many turns. Same topic = same loop.

  4. Default to ZERO loops when the conversation is genuinely casual. Greeting + small talk → loops=[] is fine. Don't manufacture loops to look thorough.

  5. NEVER invent loops not grounded in the actual messages. If you can't quote (mentally) the message that opened a loop, don't list it.

Output JSON only — no preamble, no markdown:
{
  "summary": "<CHRONOLOGICAL narrative, 3-5 short sentences, oldest to latest. Use the ACTUAL dates from the transcript timestamps — every turn shows its date. NEVER write 'on an unspecified date' or 'on the same date' when the turns span different days. If the gap between two messages is more than 24h, name the gap (e.g. 'A week later, on May 14, Sofia replied with...'). Each substantive turn the contact sent must be reflected in the summary — do NOT skip messages just because they look short ('Ok, thank you' is a real turn that matters for sequencing). Example: 'On May 5, you shared three contacts at Popular PVC and said you wanted to be part of the solution. The next day Sofia replied briefly with \"Ok, thank you\". A week later, on May 14, Sofia sent a voice note and an \"FYI pls\" message — the conversation may be re-engaging.' Concrete: real dates + real names + real decisions. Always 'you' — never 'MD'.",
  "loops": [
    {
      "topic": "<2-5 word label, no hashtags>",
      "ask": "<plain-English summary of the ask, written from your perspective. Use 'you' for the user, the contact's name for the other side. Example: 'Azhar wants you to confirm if 600+600+200 equals 1400.' or null for casual>",
      "openWith": "user" | "them" | null,
      "askedAt": "<HH:MM>" | null,
      "resolution": "<for closed: how it closed, using 'you' not 'MD'>" | null,
      "closedAt": "<HH:MM>" | null,
      "type": "decision_required" | "scheduling" | "info_request" | "task_handoff" | "casual"
    }
  ]
}`;

function buildUserPrompt(senderName: string, thread: ThreadTurn[]): string {
  const lines: string[] = [];
  // Label the user's own messages as "You" in the transcript so the LLM
  // doesn't have a "MD" string to anchor on. Combined with the SYSTEM_PROMPT
  // instruction to refer to the user as "you", this keeps "MD" out of every
  // output field (summary, ask, resolution).
  //
  // Each turn carries its FULL date (YYYY-MM-DD HH:MM) — not just HH:MM
  // as before. WhatsApp threads often span days or weeks. With only
  // time-of-day the LLM cannot tell May 5 from May 14, so it writes
  // "on an unspecified date" or "on the same date" even when the
  // conversation is multi-day. Per user 2026-05-14: Sofia thread
  // spanned May 5 → May 6 → May 14 and the summary collapsed all
  // three days as "the same date" + dropped Sofia's May 6 reply.
  lines.push(`Conversation between you and ${senderName} (most recent at bottom). Each turn shows the EXACT date and time it was sent — do NOT collapse different dates into "the same date":`);
  lines.push('');
  for (const t of thread) {
    const d = new Date(t.timestamp);
    const yyyy = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const who = t.from === 'me' ? 'You' : senderName;
    lines.push(`[${yyyy}-${mo}-${dd} ${hh}:${mm}] ${who}: ${t.text.slice(0, 500)}`);
  }
  lines.push('');
  lines.push('Identify the loops. Output JSON only. Remember: in every output field, say "you" not "MD". Use the actual dates shown above — never "an unspecified date" / "on the same date" when the timestamps differ by more than 24h. If the conversation has a gap (e.g. May 5 → May 14 with no messages between), call out that gap.');
  return lines.join('\n');
}

// ─── Public API ─────────────────────────────────────────────────

export async function analyzeConversation(args: {
  userId: number;
  clientNumber: string;
  senderName: string;
  senderKey: string;            // canonical conversation key (phone or email)
  thread: ThreadTurn[];
  latestEventId: string;
}): Promise<ConversationAnalysis> {
  const { userId, clientNumber, senderName, senderKey, thread, latestEventId } = args;

  // Empty / single-message threads can't have a loop yet — short-circuit.
  if (!thread || thread.length === 0) {
    return { summary: '', loops: [], hasOpenLoopWithUser: false, provider: 'empty' };
  }

  // Cache check
  const key = cacheKey(clientNumber, senderKey, latestEventId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return { ...cached.analysis, provider: 'cache' };
  }

  try {
    const userPrompt = buildUserPrompt(senderName, thread);
    const r = await callLLM(SYSTEM_PROMPT, userPrompt, {
      maxTokens: 800,
      providers: ['gemini-flash', 'gemini', 'claude'],
      timeoutMs: 8000,
      userId, clientNumber,
      purpose: 'conversation_analyze',
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in response');
    const obj = JSON.parse(m[0]);

    const loops: ConversationLoop[] = Array.isArray(obj.loops)
      ? obj.loops.slice(0, 6).map((l: any) => ({
          topic: String(l.topic ?? '').slice(0, 80),
          ask: l.ask ? String(l.ask).slice(0, 200) : null,
          openWith: l.openWith === 'user' || l.openWith === 'them' ? l.openWith : null,
          askedAt: l.askedAt ? String(l.askedAt).slice(0, 8) : null,
          resolution: l.resolution ? String(l.resolution).slice(0, 200) : null,
          closedAt: l.closedAt ? String(l.closedAt).slice(0, 8) : null,
          type: ['decision_required', 'scheduling', 'info_request', 'task_handoff', 'casual'].includes(l.type)
            ? (l.type as LoopType) : 'casual',
        }))
      : [];

    const analysis: ConversationAnalysis = {
      // Cap at 800 chars — chronological summary needs room for 3-5
      // short sentences with names, dates, and decisions. Old cap (240)
      // was tight for a single sentence; this fits MD's "complete
      // descriptive summary from old to latest" ask without bloating
      // the prompt downstream.
      summary: String(obj.summary ?? '').slice(0, 800),
      loops,
      hasOpenLoopWithUser: loops.some((l) => l.openWith === 'user'),
      provider: r.provider,
    };
    cache.set(key, { analysis, cachedAt: Date.now() });
    // Light cache-size guard. The conversation set per user is small;
    // a 1000-entry ceiling protects us against unexpected growth.
    if (cache.size > 1000) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    return analysis;
  } catch (err: any) {
    log.warn('analyzeConversation LLM failed — returning empty analysis', { error: err.message });
    return { summary: '', loops: [], hasOpenLoopWithUser: false, provider: 'fallback' };
  }
}
