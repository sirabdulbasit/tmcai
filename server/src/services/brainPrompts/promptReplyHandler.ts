/**
 * MyOS — Brain prompt reply handler.
 *
 * Bridges inbound user messages to the prompt queue. When a user has a
 * prompt in `awaiting_reply`, their next inbound message is treated as
 * the answer to that prompt, NOT as a normal Brain chat turn.
 *
 * Pipeline:
 *   1. Look up the user's awaiting_reply prompt.
 *   2. If none → return { handled: false } so caller proceeds with
 *      normal chat routing.
 *   3. If found → record the answer, apply the side-effect, ack the
 *      user with a short confirmation, and dispatch the next queued
 *      prompt.
 *
 * Side-effects supported (extend as new producers are added):
 *   set_due_date    — parses the answer as a date phrase, sets dueDate
 *                     on the linked open item.
 *   assign_owner    — sets delegateeName + delegateeEmail on the open
 *                     item from the answer.
 *   free_form_note  — appends the answer as a note on the open item.
 *   noop            — record the answer only; no item update.
 *
 * Date parsing is intentionally simple — no external library. Recognizes
 * "today / tomorrow / friday / next monday / yyyy-mm-dd / N days". Edge
 * cases fall back to recording the raw answer + flagging the item with
 * metadata.dueDateNeedsClarification=true so a human can see the gap.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { getAwaitingPrompt, recordAnswer, sendNextPrompt } from './brainPromptQueueService';

const log = createLogger('prompt-reply-handler');

export interface HandleReplyInput {
  userId: number;
  /** Verbatim text the user sent. */
  text: string;
}

export interface HandleReplyResult {
  /** True when this message was consumed as a prompt answer. Caller
   *  should NOT route it to the normal chat handler. */
  handled: boolean;
  /** What Brain should reply back to the user (the ack). Caller is
   *  responsible for sending it on the same channel the user wrote on. */
  ackMessage?: string;
  /** Side-effect outcome for telemetry. */
  sideEffectStatus?: 'applied' | 'failed' | 'noop' | 'unknown_kind';
  promptId?: string;
}

export async function handlePromptReply(input: HandleReplyInput): Promise<HandleReplyResult> {
  const awaiting = await getAwaitingPrompt(input.userId);
  if (!awaiting) return { handled: false };

  const text = input.text.trim();
  if (!text) return { handled: false };  // empty body — let normal flow ignore it

  // Don't consume messages that clearly aren't answers to this prompt.
  // Previously: ANY non-empty text was treated as the answer, so MD's
  // unrelated "Brief my day" got eaten as a date-parse attempt against
  // a stale set_due_date prompt and never reached the chat router.
  // Now: if the text looks like a new chat command or doesn't match
  // the side-effect's expected shape, leave the prompt awaiting and
  // fall through to chat. The prompt can be answered later when MD
  // actually addresses it.
  const sideEffectKind = ((awaiting.sideEffect as any)?.kind as string | undefined) ?? 'noop';
  if (!looksLikeAnswer(text, sideEffectKind)) {
    log.info('skipping prompt consumption — message doesn\'t look like an answer', {
      userId: input.userId, promptId: String(awaiting.id),
      sideEffectKind, textPreview: text.slice(0, 60),
    });
    return { handled: false };
  }

  log.info('handling prompt reply', {
    userId: input.userId, promptId: String(awaiting.id),
    sideEffectKind,
  });

  // 1. Persist the answer immediately. Even if side-effect application
  //    fails, the conversation must advance; we don't want a broken
  //    side-effect handler to deadlock the queue.
  await recordAnswer(awaiting.id, text);

  // 2. Apply side-effect.
  const seResult = await applySideEffect(
    awaiting.sideEffect as any,
    text,
    awaiting.openItemId ?? null,
  );

  // 3. Compose ack — short, factual, no fluff.
  const ack = composeAck(text, awaiting.sideEffect as any, seResult);

  // 4. Dispatch next prompt. If this errors we still ack — the queue
  //    is consistent, just delayed by one tick.
  void sendNextPrompt(input.userId).catch((err) => {
    log.warn('sendNextPrompt failed after answer', { err: err.message });
  });

  return {
    handled: true,
    ackMessage: ack,
    sideEffectStatus: seResult.status,
    promptId: String(awaiting.id),
  };
}

// ─── Side-effect application ────────────────────────────────────────────

interface SideEffectOutcome {
  status: 'applied' | 'failed' | 'noop' | 'unknown_kind';
  detail?: string;
}

async function applySideEffect(
  side: { kind?: string; openItemId?: string; data?: Record<string, unknown> } | null,
  answer: string,
  fallbackOpenItemId: string | null,
): Promise<SideEffectOutcome> {
  const kind = side?.kind ?? 'noop';
  const openItemId = side?.openItemId ?? fallbackOpenItemId;

  switch (kind) {
    case 'noop':
      return { status: 'noop' };

    case 'set_due_date': {
      if (!openItemId) return { status: 'failed', detail: 'no_open_item' };
      const parsed = parseDuePhrase(answer);
      if (!parsed) {
        // Can't parse — flag the item so a human can clarify, don't fail
        // the whole conversation.
        await prisma.openItem.update({
          where: { id: openItemId },
          data: { metadata: { dueDateNeedsClarification: true, lastAnswer: answer.slice(0, 200) } as any },
        }).catch(() => {});
        return { status: 'failed', detail: 'unparseable_date' };
      }
      await prisma.openItem.update({
        where: { id: openItemId },
        data: { dueDate: parsed },
      }).catch((err) => log.warn('set_due_date update failed', { err: err.message }));
      return { status: 'applied', detail: parsed.toISOString().slice(0, 10) };
    }

    case 'assign_owner': {
      if (!openItemId) return { status: 'failed', detail: 'no_open_item' };
      // Try to extract email + name from the answer. Heuristics:
      //   "Asad Khan <asad@tmcltd.com>"  → both
      //   "asad@tmcltd.com"              → email; name from local part
      //   "Asad"                         → name only
      const owner = parseOwner(answer);
      if (!owner.name && !owner.email) return { status: 'failed', detail: 'no_owner_in_answer' };
      await prisma.openItem.update({
        where: { id: openItemId },
        data: {
          status: 'DELEGATED' as any,
          delegateeName: owner.name ?? null,
          delegateeEmail: owner.email ?? null,
        },
      }).catch((err) => log.warn('assign_owner update failed', { err: err.message }));
      return { status: 'applied', detail: owner.name ?? owner.email ?? '' };
    }

    case 'free_form_note': {
      if (!openItemId) return { status: 'noop' };
      const item = await prisma.openItem.findFirst({ where: { id: openItemId } });
      if (!item) return { status: 'failed', detail: 'item_not_found' };
      const notes = (item.notes as Array<Record<string, unknown>>) || [];
      notes.push({ text: answer, at: new Date().toISOString(), source: 'prompt_reply' });
      await prisma.openItem.update({ where: { id: openItemId }, data: { notes: notes as any } })
        .catch((err) => log.warn('free_form_note update failed', { err: err.message }));
      return { status: 'applied' };
    }

    case 'action_status_update': {
      if (!openItemId) return { status: 'failed', detail: 'no_open_item' };
      const item = await prisma.openItem.findFirst({ where: { id: openItemId }, select: { clientNumber: true } });
      if (!item) return { status: 'failed', detail: 'item_not_found' };
      const { recordActionLifecycleReply } = await import('../openItems/actionLifecycleService');
      const result = await recordActionLifecycleReply({
        openItemId,
        clientNumber: item.clientNumber,
        body: answer,
        source: 'user',
      });
      if (!result.handled) return { status: 'failed', detail: 'item_not_found' };
      if (result.closed) return { status: 'applied', detail: 'completed' };
      if (result.newDueDate) return { status: 'applied', detail: `new_due:${result.newDueDate}` };
      if (result.needsUserIntervention) return { status: 'applied', detail: 'intervention_recorded' };
      return { status: 'applied', detail: result.outcome ?? 'status_recorded' };
    }

    default:
      return { status: 'unknown_kind' };
  }
}

// ─── Date phrase parser ────────────────────────────────────────────────
// Deliberately simple — recognises common short answers without an LLM.
// Returns null when nothing matches.

const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

export function parseDuePhrase(raw: string): Date | null {
  const s = raw.trim().toLowerCase();
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (/^(today|eod|asap|now)\b/.test(s)) return todayMidnight;
  if (/^tomorrow\b/.test(s)) return addDays(todayMidnight, 1);

  const inDays = s.match(/^in\s+(\d+)\s+day/);
  if (inDays) return addDays(todayMidnight, parseInt(inDays[1] as string, 10));

  const nDays = s.match(/^(\d+)\s+day/);
  if (nDays) return addDays(todayMidnight, parseInt(nDays[1] as string, 10));

  // ISO date
  const iso = s.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) {
    const d = new Date(iso[1] as string);
    if (!Number.isNaN(d.getTime())) return d;
  }

  // weekday names — "friday" / "next monday" / "this thursday"
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const re = new RegExp(`(?:^|\\b)(?:next\\s+|this\\s+)?(${WEEKDAYS[i]})\\b`);
    const m = s.match(re);
    if (m) {
      const target = i;
      const cur = todayMidnight.getDay();
      let delta = target - cur;
      const isNext = /\bnext\s+/.test(s);
      if (delta <= 0 || isNext) delta += 7;
      return addDays(todayMidnight, delta);
    }
  }

  return null;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

// ─── Owner parser ──────────────────────────────────────────────────────

export function parseOwner(raw: string): { name: string | null; email: string | null } {
  const s = raw.trim();
  // "Asad Khan <asad@tmcltd.com>"
  const both = s.match(/^(.+?)\s*<\s*([^\s>]+@[^\s>]+)\s*>?$/);
  if (both) return { name: both[1]!.trim() || null, email: both[2]!.toLowerCase() };
  // bare email
  const email = s.match(/([^\s,;<>]+@[^\s,;<>]+)/);
  if (email) {
    const localPart = email[1]!.split('@')[0];
    const niceName = localPart!.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return { name: niceName || null, email: email[1]!.toLowerCase() };
  }
  // name only — keep it as-is (caller may flag if email is needed)
  if (s.length >= 2 && s.length <= 80) return { name: s, email: null };
  return { name: null, email: null };
}

// ─── Ack composer ──────────────────────────────────────────────────────

function composeAck(
  answer: string,
  side: { kind?: string } | null,
  outcome: SideEffectOutcome,
): string {
  // System markers (bracketed), not fake-Brain "Got it" replies. Per
  // Basit 2026-05-20: "don't hardcode anything this is the crime in
  // building AI". These are state-transition acknowledgements emitted
  // by the prompt-queue dispatcher — clearly machine status, not Brain
  // speaking. Each variant names the actual outcome so the user knows
  // exactly what changed.
  const kind = side?.kind ?? 'noop';
  switch (kind) {
    case 'set_due_date':
      if (outcome.status === 'applied') return `[due date set: ${outcome.detail}]`;
      if (outcome.detail === 'unparseable_date') return `[couldn't parse "${clip(answer, 40)}" as a date — flagged for clarification]`;
      return `[noted]`;
    case 'assign_owner':
      if (outcome.status === 'applied') return `[assigned to ${outcome.detail}]`;
      return `[owner not identified — reply with a name or email]`;
    case 'free_form_note':
      return outcome.status === 'applied' ? `[note saved]` : `[noted]`;
    case 'action_status_update':
      if (outcome.detail === 'completed') return `[completion recorded and item closed]`;
      if (outcome.detail?.startsWith('new_due:')) {
        return `[new deadline recorded: ${outcome.detail.slice('new_due:'.length, 'new_due:'.length + 10)}]`;
      }
      if (outcome.detail === 'intervention_recorded') return `[blocker recorded — intervention flagged]`;
      return outcome.status === 'applied' ? `[status update recorded]` : `[status update could not be applied]`;
    case 'noop':
    default:
      return `[noted]`;
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Decide whether the inbound text is a plausible answer to the pending
 *  prompt's side-effect, or a NEW chat command that should fall through
 *  to the regular Brain chat router.
 *
 *  Two layers:
 *    1. Universal "new chat command" detector — phrases that are clearly
 *       new requests, never answers to any prompt. Same shape no matter
 *       what side-effect is awaiting.
 *    2. Side-effect-specific shape match — does the text look like a
 *       date (for set_due_date), a name/email (for assign_owner), etc.
 *
 *  Tuned to err on the side of FALL-THROUGH. A false-negative answer
 *  just delays applying a prompt by one turn; a false-positive eats a
 *  legitimate new chat command and replies with gibberish ("couldn't
 *  parse 'brief my day' as a date — flagged for clarification"). The
 *  second failure mode is what MD hit on 2026-05-12 and is much worse. */
export function looksLikeAnswer(text: string, sideEffectKind: string): boolean {
  const t = text.trim();
  if (!t) return false;

  // Layer 1 — universal new-chat trigger phrases. If MD opens with any
  // of these, they're starting a new request, not answering an old prompt.
  // Verbs list must stay in sync with the ComposedAction imperatives in
  // brainComposer.ts. Missing verbs cause the prompt-queue to swallow
  // real commands with [noted] — Basit 2026-07-08: "send a test email"
  // was misread as an answer to a stale prompt and got [noted] back
  // because 'send' wasn't in the allowlist.
  const newChatTrigger = /^(brief\s+my\s+day|day\s+brief|what'?s\s+(on\s+my\s+plate|critical|urgent|going\s+on)|how\s+(many|much)\s+|how\s+is\s+|list\s+(my|all|the)\s+|show\s+me\s+|tell\s+(me\s+about|him|her|them)\s+|delegate\s+|forward\s+|reply\s+(to\s+|with\s+)|draft\s+(a\s+)?(reply|email|message)|schedule\s+|reschedule\s+|set\s+(up\s+)?(a\s+)?meeting|book\s+(a\s+)?meeting|remind\s+me\s+|add\s+(it\s+|this\s+|a\s+task|to\s+my)|track\s+(this|that)|snooze\s+|mute\s+|hide\s+|send\s+|email\s+|notify\s+|ping\s+|call\s+|message\s+|share\s+|update\s+|fix\s+|edit\s+|change\s+|write\s+|compose\s+|cancel$|skip$|nevermind$|later$|stop$|bye$|exit$|hi$|hello$|hey$|good\s+(morning|afternoon|evening|night)|salaam|salam|aoa|assalam)\b/i;
  if (newChatTrigger.test(t)) return false;

  // Layer 2 — shape match per side-effect.
  switch (sideEffectKind) {
    case 'set_due_date': {
      // Recognise common natural-language date forms + ISO.
      const datePattern = /\b(today|tomorrow|tonight|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|next\s+\w+|by\s+\w+|in\s+\d+\s*(day|days|week|weeks|month|months)|end\s+of\s+(day|week|month)|asap|whenever|no\s+idea|sometime|aaj|kal|parsoon|abhi)\b/i;
      const isoLike = /\b\d{4}-\d{2}-\d{2}\b/.test(t) || /^\d{1,2}[\/\-]\d{1,2}/.test(t) || /^\d+\s*(d|days|h|hours)$/i.test(t);
      // Short messages with date words = answer. Long sentences with
      // date words but also clear new-chat structure already failed layer 1.
      if (datePattern.test(t)) return true;
      if (isoLike) return true;
      // Very short freeform like "tomorrow ok" or "monday next" — usually answer.
      if (t.length <= 30 && /^[a-z\d\s.,;:-]+$/i.test(t)) return true;
      return false;
    }
    case 'assign_owner': {
      // Email present → almost certainly an owner answer.
      if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(t)) return true;
      // Short name-shaped: 1-4 tokens, mostly capitalised letters.
      const tokens = t.split(/\s+/);
      if (tokens.length >= 1 && tokens.length <= 4 && tokens.every((w) => /^[A-Z][a-z'\-]{1,}\.?$/.test(w) || /^[A-Z][A-Z]+$/.test(w))) return true;
      return false;
    }
    case 'free_form_note':
      // Anything that isn't a new-chat trigger (layer 1 already filtered).
      return true;
    case 'action_status_update':
      // Status replies are intentionally free-form: completion, progress,
      // blocker, delay reason, and a new deadline often arrive in one sentence.
      return true;
    case 'noop':
    default:
      // Without a typed side-effect we have nothing to validate against.
      // Conservative: accept short freeform, reject anything that smells
      // like a new request. Layer 1 already caught the loud cases.
      return t.length <= 200;
  }
}
