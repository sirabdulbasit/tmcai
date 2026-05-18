/**
 * smartChaseService — per-recipient tone + LLM-judged timing + formal
 * chase email composition for delegationFollowUpJob.
 *
 * Replaces the old hard-coded "Just bumping this up..." with:
 *
 *   1. Verdict — `decideChaseVerdict()` asks Gemini Flash whether to
 *      chase this item right now. Inputs: item priority, due date,
 *      days since delegation, days since last attempt, total attempts,
 *      user's followUpDays baseline. Output: hold / chase / escalate /
 *      mark_stale, with a reason.
 *
 *   2. Tone — `fetchSentToneSamples()` pulls the last N emails the
 *      user has sent to this specific recipient from Gmail (q="from:me
 *      to:<email>"), strips quoted replies + signatures, caches per
 *      (userId, recipientEmail) for 24h. Falls back to overall user
 *      tone signals when there's no history with this person.
 *
 *   3. Compose — `composeChaseEmail()` feeds the tone samples + the
 *      delegation context + a forbidden-phrase list to Claude/Gemini
 *      and gets back a formal email in the user's voice. Appends the
 *      Option-A disclosure footer so the recipient can tell it's
 *      sent via Nexeo on the user's behalf.
 *
 * Identity / safety: this service composes and returns the body; the
 * caller (delegationFollowUpJob) is the only place that calls
 * sendUserEmail. The disclosure footer in every composed body is the
 * structural mitigation against the feedback_brain_never_speaks_as_user
 * concern: recipient can always tell auto from manual.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { callLLM } from '../llmRouter';
import { getSentSamplesToRecipient } from '../gmailService';

const log = createLogger('smart-chase');

// ─── 1. Verdict ─────────────────────────────────────────────────────

export type ChaseVerdict = 'hold' | 'chase' | 'escalate' | 'mark_stale';

export interface VerdictInput {
  itemId: string;
  itemTitle: string;
  itemPriority: string | null;
  itemDueDate: Date | null;
  delegatedAt: Date;
  lastChaseAt: Date | null;
  attemptsSent: number;
  maxAttempts: number;
  followUpDaysBaseline: number; // user's setting
  hasOwnerActivity: boolean;    // user added notes / replied recently
}

const VERDICT_SYSTEM = `You decide whether to send a chase email to a delegatee, RIGHT NOW.

Possible verdicts:
- "hold": too soon to chase again; wait. Use when the baseline cadence hasn't elapsed since the last attempt, OR the original deadline hasn't passed yet AND no attempts have been made yet, OR the delegatee's typical response window hasn't elapsed.
- "chase": send a chase email now. Use when the cadence has elapsed and the item is genuinely overdue or stuck.
- "escalate": don't send another auto-chase; surface to the owner ("their delegatee hasn't responded — want to call them?"). Use after multiple attempts with no signal.
- "mark_stale": stop chasing entirely; this item has gone dormant. Use when >14 days have passed with multiple attempts and no signal AND the priority is medium or below.

Return ONLY a JSON object: {"verdict": "<one of the four>", "reason": "<one short sentence why>"}.

Be conservative: prefer "hold" when uncertain. Never use "chase" if attemptsSent >= maxAttempts (escalate instead).`;

export async function decideChaseVerdict(input: VerdictInput, userId: number, clientNumber: string): Promise<{ verdict: ChaseVerdict; reason: string }> {
  // Hard rules first — cheap, no LLM needed.
  if (input.attemptsSent >= input.maxAttempts) {
    return { verdict: 'escalate', reason: `Max attempts reached (${input.attemptsSent}/${input.maxAttempts})` };
  }

  const now = Date.now();
  const daysSinceDelegated = Math.floor((now - input.delegatedAt.getTime()) / 86_400_000);
  const daysSinceLastChase = input.lastChaseAt ? Math.floor((now - input.lastChaseAt.getTime()) / 86_400_000) : null;
  const daysOverdue = input.itemDueDate ? Math.floor((now - input.itemDueDate.getTime()) / 86_400_000) : null;

  // If the user themselves has acted on this thread recently, they're
  // engaged — Brain steps back.
  if (input.hasOwnerActivity) {
    return { verdict: 'hold', reason: 'Owner has recent activity on the thread; let them drive.' };
  }

  // Cadence floor: never chase sooner than baseline days since last attempt.
  if (daysSinceLastChase !== null && daysSinceLastChase < input.followUpDaysBaseline) {
    return { verdict: 'hold', reason: `Only ${daysSinceLastChase}d since last attempt; baseline is ${input.followUpDaysBaseline}d.` };
  }

  // Mark stale: long silence + low priority.
  const lowish = !input.itemPriority || input.itemPriority === 'low' || input.itemPriority === 'medium';
  if (daysSinceDelegated > 14 && input.attemptsSent >= 2 && lowish) {
    return { verdict: 'mark_stale', reason: `${daysSinceDelegated}d since delegation with ${input.attemptsSent} attempts and ${input.itemPriority ?? 'no'} priority.` };
  }

  // Everything else → LLM.
  const userPrompt = JSON.stringify({
    item: { title: input.itemTitle, priority: input.itemPriority, dueDate: input.itemDueDate?.toISOString() ?? null },
    delegatedAt: input.delegatedAt.toISOString(),
    daysSinceDelegated,
    daysSinceLastChase,
    daysOverdue,
    attemptsSent: input.attemptsSent,
    maxAttempts: input.maxAttempts,
    followUpDaysBaseline: input.followUpDaysBaseline,
  });

  try {
    const r = await callLLM(VERDICT_SYSTEM, userPrompt, {
      maxTokens: 120,
      providers: ['gemini-flash', 'gemini', 'claude'],
      userId,
      clientNumber,
      purpose: 'delegation_chase_verdict',
      timeoutMs: 8_000,
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no_json');
    const obj = JSON.parse(m[0]);
    const v = String(obj.verdict ?? 'hold');
    if (v !== 'hold' && v !== 'chase' && v !== 'escalate' && v !== 'mark_stale') {
      return { verdict: 'hold', reason: 'unknown verdict from LLM' };
    }
    return { verdict: v, reason: String(obj.reason ?? '').slice(0, 200) };
  } catch (err: any) {
    log.warn('verdict LLM failed, defaulting to hold', { itemId: input.itemId, err: err.message });
    return { verdict: 'hold', reason: 'verdict_unavailable' };
  }
}

// ─── 2. Tone samples ────────────────────────────────────────────────

interface ToneSample { subject: string; body: string; date: string }

const toneCache = new Map<string, { samples: ToneSample[]; expiresAt: number }>();
const TONE_TTL_MS = 24 * 60 * 60 * 1000;

export async function fetchSentToneSamples(
  userId: number,
  recipientEmail: string,
  limit = 8,
): Promise<ToneSample[]> {
  const key = `${userId}|${recipientEmail.toLowerCase()}`;
  const hit = toneCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.samples;

  const { samples, error } = await getSentSamplesToRecipient(userId, recipientEmail, limit);
  if (error) {
    log.warn('tone samples fetch failed', { userId, recipientEmail, error });
    // Cache empty result for a shorter TTL so transient errors don't
    // suppress tone-learning for 24h.
    toneCache.set(key, { samples: [], expiresAt: Date.now() + 5 * 60 * 1000 });
    return [];
  }
  toneCache.set(key, { samples, expiresAt: Date.now() + TONE_TTL_MS });
  return samples;
}

// ─── 3. Compose ─────────────────────────────────────────────────────

export interface ComposeInput {
  userId: number;
  clientNumber: string;
  userName: string;             // for sign-off + disclosure
  userEmail: string;            // for the disclosure "reply goes to X"
  recipientName: string;
  recipientEmail: string;
  itemTitle: string;
  itemDescription: string;
  itemDueDate: Date | null;
  delegatedAt: Date;
  attemptNumber: number;        // 1-indexed (1 = first chase, 2 = second...)
  maxAttempts: number;
}

export interface ComposeOutput {
  subject: string;
  body: string;        // full body INCLUDING the disclosure footer
  toneSamplesUsed: number;
}

const FORBIDDEN_PHRASES = [
  'just bumping',
  'just wanted to',
  'circling back',
  'touching base',
  'any update',
  'gentle reminder',
  'friendly reminder',
  'as per my last email',
  'as discussed',
  'kindly do the needful',
  'please do the needful',
  'revert back',
];

const COMPOSE_SYSTEM = `You write a single chase email on behalf of the SENDER to a delegatee whose work is overdue.

Output MUST be a JSON object: {"subject": "...", "body": "..."}.

Body rules:
- Formal letter structure: salutation, two short paragraphs (3-4 sentences each max), sign-off with the sender's name.
- First paragraph: orient the recipient on what's overdue. Be specific about WHAT, not vague.
- Second paragraph: a clear ask — what you need from them, by when if known.
- Tone: match the SAMPLES given in the user message. They show how the sender actually writes to THIS recipient. Mimic salutation register, sentence length, formality, sign-off style.
- Escalation by attempt number: attempt 1 is collegial; attempt 2 is direct; attempt 3 is firm without being rude.
- Forbidden phrases (do not use, anywhere): just bumping, just wanted to, circling back, touching base, any update, gentle reminder, friendly reminder, as per my last email, as discussed, do the needful, revert back. These read as robotic AI filler.
- No bullet points; no markdown; plain prose only.
- No mention of "AI", "assistant", "automated", "Nexeo", or "Brain" in the body. The disclosure is appended OUTSIDE this body by the caller.
- Sign off with just the sender's name on its own line. No title, no contact block.

Subject rules:
- If the original subject starts with "Re:" or "Fwd:" use the title as-is (it's already threaded).
- Otherwise prefix with "Re: " for proper threading.
- Keep it under 80 chars.`;

function buildComposeUserPrompt(input: ComposeInput, samples: ToneSample[]): string {
  const daysSinceDelegated = Math.floor((Date.now() - input.delegatedAt.getTime()) / 86_400_000);
  const daysOverdue = input.itemDueDate ? Math.floor((Date.now() - input.itemDueDate.getTime()) / 86_400_000) : null;

  const samplesBlock = samples.length === 0
    ? `(no prior sent emails to this recipient — write in a default professional register)`
    : samples
        .map((s, i) => `--- SAMPLE ${i + 1} (${s.date}) ---\nSubject: ${s.subject}\n\n${s.body}`)
        .join('\n\n');

  return [
    `## Context`,
    `Sender:    ${input.userName} <${input.userEmail}>`,
    `Recipient: ${input.recipientName} <${input.recipientEmail}>`,
    `Item:      "${input.itemTitle}"`,
    input.itemDescription ? `Detail:    ${input.itemDescription.slice(0, 600)}` : '',
    `Delegated: ${daysSinceDelegated}d ago`,
    input.itemDueDate ? `Deadline:  ${input.itemDueDate.toISOString().slice(0, 10)} (${daysOverdue !== null && daysOverdue >= 0 ? `${daysOverdue}d overdue` : 'upcoming'})` : 'Deadline:  none set',
    `Attempt:   ${input.attemptNumber} of ${input.maxAttempts}`,
    '',
    `## Tone samples — how the sender writes to this recipient`,
    samplesBlock,
    '',
    `Compose the chase email now. JSON only.`,
  ].filter(Boolean).join('\n');
}

function disclosureFooter(userName: string, userEmail: string): string {
  return [
    '',
    '',
    '—',
    `Sent by Nexeo, ${userName}'s AI assistant. Your reply goes directly to ${userName} at ${userEmail}.`,
  ].join('\n');
}

function containsForbidden(body: string): string | null {
  const low = body.toLowerCase();
  for (const p of FORBIDDEN_PHRASES) {
    if (low.includes(p)) return p;
  }
  return null;
}

export async function composeChaseEmail(input: ComposeInput): Promise<ComposeOutput | null> {
  const samples = await fetchSentToneSamples(input.userId, input.recipientEmail, 8);
  const userPrompt = buildComposeUserPrompt(input, samples);

  try {
    const r = await callLLM(COMPOSE_SYSTEM, userPrompt, {
      maxTokens: 700,
      providers: ['claude', 'gemini', 'gemini-flash'],
      userId: input.userId,
      clientNumber: input.clientNumber,
      purpose: 'delegation_chase_compose',
      timeoutMs: 20_000,
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) {
      log.warn('compose returned no JSON', { itemTitle: input.itemTitle });
      return null;
    }
    const obj = JSON.parse(m[0]);
    let body = String(obj.body ?? '').trim();
    let subject = String(obj.subject ?? '').trim();
    if (!body || !subject) {
      log.warn('compose missing subject or body', { itemTitle: input.itemTitle });
      return null;
    }

    // Last-line forbidden-phrase guard. If the LLM slipped one in,
    // ask it once to rewrite without that phrase. Keeps the
    // robotic-filler bar firm without a regex panel making the
    // content judgement itself.
    const offender = containsForbidden(body);
    if (offender) {
      log.info('compose hit forbidden phrase, retrying', { offender, itemTitle: input.itemTitle });
      try {
        const retry = await callLLM(
          COMPOSE_SYSTEM,
          userPrompt + `\n\nYour previous reply used the forbidden phrase "${offender}". Rewrite without it. JSON only.`,
          { maxTokens: 700, providers: ['claude', 'gemini', 'gemini-flash'], userId: input.userId, clientNumber: input.clientNumber, purpose: 'delegation_chase_compose_retry', timeoutMs: 20_000 },
        );
        const m2 = retry.text.match(/\{[\s\S]*\}/);
        if (m2) {
          const obj2 = JSON.parse(m2[0]);
          const body2 = String(obj2.body ?? '').trim();
          const subject2 = String(obj2.subject ?? '').trim();
          if (body2 && subject2 && !containsForbidden(body2)) {
            body = body2; subject = subject2;
          }
        }
      } catch { /* keep original; not worth a hard fail */ }
    }

    if (subject.length > 80) subject = subject.slice(0, 78) + '…';

    const finalBody = body + disclosureFooter(input.userName, input.userEmail);
    return { subject, body: finalBody, toneSamplesUsed: samples.length };
  } catch (err: any) {
    log.warn('compose LLM failed', { itemTitle: input.itemTitle, err: err.message });
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

export async function getUserNameAndEmail(userId: number): Promise<{ name: string; email: string } | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  if (!u || !u.email) return null;
  return { name: u.name || u.email.split('@')[0], email: u.email };
}
