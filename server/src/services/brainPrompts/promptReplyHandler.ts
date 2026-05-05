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

  log.info('handling prompt reply', {
    userId: input.userId, promptId: String(awaiting.id),
    sideEffectKind: (awaiting.sideEffect as any)?.kind,
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
  const kind = side?.kind ?? 'noop';
  switch (kind) {
    case 'set_due_date':
      if (outcome.status === 'applied') return `Got it — due ${outcome.detail}.`;
      if (outcome.detail === 'unparseable_date') return `Got it. Couldn't parse "${clip(answer, 40)}" as a date — flagged for clarification.`;
      return 'Got it.';
    case 'assign_owner':
      if (outcome.status === 'applied') return `Got it — assigned to ${outcome.detail}.`;
      return 'Got it. Couldn\'t identify the owner — please reply with a name or email.';
    case 'free_form_note':
      return outcome.status === 'applied' ? 'Got it — noted.' : 'Got it.';
    case 'noop':
    default:
      return 'Got it.';
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
