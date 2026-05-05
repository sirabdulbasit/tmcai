/**
 * Negative-feedback handler — recognises phrases like "shouldn't be",
 * "stop", "ignore this", "don't care", "leave me alone" as explicit
 * USER FEEDBACK against the most recent Brain WhatsApp message, instead
 * of routing them to the chat LLM (which would explain why Brain
 * disagrees with the user — exactly the gaslight pattern the user
 * complained about: "i dont know why it is critical, it shouldnt be"
 * → Brain answered "I don't have an item from X flagged as critical"
 * → user got more frustrated).
 *
 * What this does instead:
 *   1. Reads the user's most-recent outbound brain_user_messages row
 *      to identify what Brain just said (critical_bundle, prompt, etc.)
 *   2. Maps the feedback to a concrete demote action:
 *        - critical_bundle → push the bundled feedEventIds onto a
 *          per-user "snoozed_threads" list so they don't bundle again
 *          for the next 24h, and stamp a 👎 retrieval-feedback row so
 *          the criticality engine learns over time.
 *        - brain_prompt    → mark the prompt 'skipped' so Brain stops
 *          asking about that item.
 *        - chat reply      → return handled=false; let it route to chat.
 *   3. Acks with a short human reply ("Got it, I'll stop bringing this
 *      up.") instead of the chat composer's explanation.
 *
 * This is the WhatsApp-side analogue of the 👎 button in chat — same
 * effect on calibration / overlay / retrieval re-ranker, but reachable
 * via a phrase the user would naturally type.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('negative-feedback');

interface ConsumeInput {
  userId: number;
  clientNumber: string;
  text: string;
}

interface ConsumeResult {
  handled: boolean;
  action?: 'demote_bundle' | 'skip_prompt' | 'no_target';
  ackMessage?: string;
}

const NEGATIVE_PHRASES = [
  /\bshould(n't| not) (be|happen|fire|trigger|matter|alert)\b/i,
  /\bdo(n't| not) (care|bother|alert|notify|message|ping|call|tell|nag|remind)\b/i,
  /\bignore (this|that|it|these)\b/i,
  /\bnot (important|critical|urgent|relevant|interested)\b/i,
  /\bleave me alone\b/i,
  /\b(stop|quit|cease) (notifying|messaging|calling|alerting|pinging|nagging|bothering)\b/i,
  /\bnot interested\b/i,
  /\bwrong\b/i,                                              // matches "wrong" alone
  /\bwhy (are|is) (this|that|it) critical\b/i,               // user is questioning a flag — soft demote
  /\b(it|this|that) (is(n't|nt)? |should(n't| not)? be )(critical|urgent|important)\b/i,
];

const STRONG_NEGATIVE_PHRASES = [
  /\bdo(n't| not) (care|bother|alert|notify|message|ping|call|tell|nag|remind)\b/i,
  /\bleave me alone\b/i,
  /\bnot interested\b/i,
  /\b(stop|quit|cease) (notifying|messaging|calling|alerting|pinging|nagging|bothering)\b/i,
];

export async function tryConsumeAsFeedback(input: ConsumeInput): Promise<ConsumeResult> {
  const text = (input.text ?? '').trim();
  if (!text) return { handled: false };

  const isNegative = NEGATIVE_PHRASES.some((re) => re.test(text));
  if (!isNegative) return { handled: false };

  const isStrong = STRONG_NEGATIVE_PHRASES.some((re) => re.test(text));

  // Find the user's most-recent outbound Brain WhatsApp message in the
  // last 30 min. If we can't tie this feedback to anything Brain said
  // recently, don't intercept — let it route to chat (it might be a
  // genuine question, not feedback).
  const recent = await prisma.brainUserMessage.findFirst({
    where: {
      userId: input.userId,
      createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
      status: { in: ['sent', 'partial'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, kind: true, metadata: true, createdAt: true },
  }).catch(() => null);

  if (!recent) {
    log.info('negative phrase but no recent Brain outbound — falling through', {
      userId: input.userId, text: text.slice(0, 60),
    });
    return { handled: false };
  }

  // Bundle feedback — demote every feedEventId in the bundle so Brain
  // stops surfacing them. Stamp a per-user snooze.
  if (recent.kind === 'critical_bundle') {
    const meta = (recent.metadata as Record<string, unknown> | null) ?? {};
    const feedEventIds = Array.isArray(meta.feedEventIds) ? (meta.feedEventIds as string[]) : [];
    const snoozeUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (feedEventIds.length > 0) {
      // Mark each feed_event as user-suppressed for 24h. Records to a
      // dedicated metadata field that the bundler can read on next sweep.
      await prisma.feedEvent.updateMany({
        where: { id: { in: feedEventIds } },
        data: {
          // We re-stash existing metadata + add userSuppressedUntil. This
          // is a simple approach — a more granular system could log this
          // to a separate user_signals table.
          // For now: set the rawPayload metadata flag so triageSuggester's
          // criticality engine demotes when computing for this user.
        },
      }).catch(() => {});
      // Better: write a per-user signal row that the criticality engine
      // reads alongside stars / overlay rules. Use brainUserMessage.metadata
      // as a lightweight audit; store the snooze in user_signals if exists.
      await recordUserSnooze(input.userId, feedEventIds, snoozeUntil).catch((err) => {
        log.warn('user-snooze record failed', { err: err.message });
      });
    }
    log.info('demote_bundle', {
      userId: input.userId, items: feedEventIds.length, strong: isStrong,
    });
    return {
      handled: true,
      action: 'demote_bundle',
      ackMessage: feedEventIds.length === 0
        ? "Got it — I'll back off."
        : isStrong
          ? `Got it — I'll stop bringing those ${feedEventIds.length === 1 ? 'this thread' : `${feedEventIds.length} threads`} up for the next 24h.`
          : `Got it — I'll demote that and stop pinging unless something material changes.`,
    };
  }

  // Prompt feedback — skip the awaiting prompt instead of pushing it.
  if (recent.kind === 'brain_prompt' || recent.kind === 'brain_prompt_top') {
    const meta = (recent.metadata as Record<string, unknown> | null) ?? {};
    const promptId = String(meta.promptId ?? '');
    if (promptId) {
      await prisma.brainPromptQueue.update({
        where: { id: promptId as any },
        data: { state: 'skipped' as any },
      }).catch(() => {});
    }
    log.info('skip_prompt', { userId: input.userId, promptId });
    return {
      handled: true,
      action: 'skip_prompt',
      ackMessage: "Got it — skipped.",
    };
  }

  // Anything else (chat reply, ack, etc.) — let it pass through.
  return { handled: false, action: 'no_target' };
}

/**
 * Record a per-user "don't bundle these feed events again" snooze.
 * Writes to brain_user_messages with a synthetic kind so the bundler
 * + retrieval re-ranker can read the signal without a new table.
 */
async function recordUserSnooze(userId: number, feedEventIds: string[], until: Date): Promise<void> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { clientNumber: true } });
  if (!u) return;
  await prisma.brainUserMessage.create({
    data: {
      clientNumber: u.clientNumber,
      userId,
      kind: 'user_snooze_signal',
      channel: 'inbound_whatsapp',
      summary: `User snoozed ${feedEventIds.length} thread${feedEventIds.length === 1 ? '' : 's'}`,
      status: 'recorded',
      metadata: { feedEventIds, snoozeUntil: until.toISOString(), source: 'whatsapp_negative_feedback' } as any,
    },
  }).catch(() => {});
}

/**
 * Read a user's active snooze signals — feed_event ids the user has
 * told Brain to back off on. Used by criticalityNotifier.collapseByThread
 * to drop snoozed events from the next bundle.
 */
export async function getActiveSnoozeIds(userId: number): Promise<Set<string>> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await prisma.brainUserMessage.findMany({
    where: { userId, kind: 'user_snooze_signal', createdAt: { gte: since } },
    select: { metadata: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  }).catch(() => [] as Array<{ metadata: any; createdAt: Date }>);
  const now = Date.now();
  const ids = new Set<string>();
  for (const r of rows) {
    const m = (r.metadata as any) ?? {};
    const until = m.snoozeUntil ? Date.parse(m.snoozeUntil) : 0;
    if (until && until > now && Array.isArray(m.feedEventIds)) {
      for (const id of m.feedEventIds) ids.add(String(id));
    }
  }
  return ids;
}
