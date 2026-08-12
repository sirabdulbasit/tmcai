/**
 * proactiveDecision — whether a proactive message is sent at all (DEF-156).
 *
 * Campaign C-1 iteration 2. Codex's iteration-12 directive #1, verbatim in
 * effect: *"Make campaign iteration 2 measure production decisions, not richer
 * prompts around static strings. Add injectable pure decision seams … input real
 * structured context, return `{send|suppress|batch|escalate, reason,
 * renderedMessage}`. Drive those same seams from jobs and benchmark."*
 *
 * That criticism was right about DEF-155. The proactive slice scored four pure
 * text functions and the build log called it end-to-end; what it could not see
 * was the decision, which is where CL-033's actual defect lives. Ten pushes from
 * one unknown number in 3h20m is not a wording problem.
 *
 * ── WHY A SEAM AND NOT A FIX INSIDE THE JOB ─────────────────────────────────
 *
 * `notifyOwnerOfUnattachedReply` sent one message per inbound, keyed
 * `unattached_reply:${sourceId}`, so every distinct source id got its own push.
 * Putting a window rule inside that function would fix production and leave the
 * decision as unmeasurable as the text was. A pure seam is callable by the job
 * AND by the benchmark, so what ships and what is scored are the same function.
 *
 * ── WHAT IS DECIDED HERE, AND WHAT DELIBERATELY IS NOT ──────────────────────
 *
 * **Structural only.** How many messages arrived from this sender inside a
 * window, and whether the owner has already been told. Counting and clock
 * arithmetic are not judgements about meaning, so invariant #3 is untouched.
 *
 * **Relevance is NOT decided here.** Whether *"Okby"* deserves the owner's
 * attention is a judgement about substance, and invariant #3 is explicit: those
 * are LLM-with-context, and a regex may pre-filter but never decide. So this seam
 * accepts a `relevance` verdict as an INPUT. When none is supplied it does not
 * suppress on content grounds at all — **fail-open for judgement, fail-closed for
 * volume.** Dropping the owner's messages on a guess is worse than one message
 * too many, and DEF-139's complaint was volume, not that any single message was
 * unwanted.
 *
 * That split is also why the relevance classifier is not wired to an LLM in this
 * iteration: the batching half is safe, testable and delivers the measured win
 * (ten fragments → one notice), while adding a per-inbound LLM call to a job path
 * is a cost and latency change that deserves its own turn and its own evidence.
 * The hook exists, is scored, and is honestly empty.
 */
import { renderUnattachedDigest } from './proactiveMessageText';

/** Default window for treating messages from one sender as one event. Twenty
 *  minutes is the shortest span that covers CL-033's observed bursts (six
 *  messages inside 35 minutes, arriving on 5-minute polling ticks) without
 *  holding a genuinely new conversation for long. Tunable by the caller; not a
 *  business threshold, so it does not belong in `behaviorConfig`. */
export const UNATTACHED_WINDOW_MS = 20 * 60 * 1000;

export type ProactiveAction = 'send' | 'suppress';

/** Whether the CONTENT is worth the owner's attention. Supplied by the caller
 *  because it is a judgement about substance (invariant #3), never computed here. */
export interface RelevanceVerdict {
  worthSurfacing: boolean;
  reason: string;
}

export interface UnattachedReplyContext {
  /** Contact name when known, otherwise the raw identifier. */
  who: string;
  /** The message that just arrived. */
  body: string;
  /** When it arrived. */
  atMs: number;
  /** Earlier unattached messages from the SAME sender still inside the window,
   *  oldest first, exactly as the caller observed them. */
  earlierFromSender: ReadonlyArray<{ body: string; atMs: number }>;
  /** True when the owner has already been notified about this sender inside the
   *  window. The caller reads this from the prompt queue it writes to, so the
   *  next tick sees the decision the last one made. */
  alreadyNotifiedInWindow: boolean;
  /**
   * REQUIRED (DEF-157). Has the caller durably stored THIS fragment somewhere a
   * later digest can still reach the owner from?
   *
   * Suppression is only permitted when this is `true`, and the field is required
   * rather than optional so the question cannot be skipped: a caller with nowhere
   * to keep the message must not be able to drop it silently.
   *
   * DEF-156 got this exactly wrong. It suppressed on volume alone and
   * `delegationCaptureService` returned before persisting anything, so the owner
   * received the FIRST fragment of a burst and every later one vanished. Ten noisy
   * pushes is a nuisance he can scroll past; losing *"urgent: the server is down"*
   * because a social message arrived two minutes earlier is not. Invariant #6 says
   * a missing ledger means visible degradation, never silent success — and a
   * dropped message is the purest form of silent success.
   */
  retained: boolean;
  windowMs?: number;
  /** Optional, and absent by design in this iteration — see the docblock. */
  relevance?: RelevanceVerdict;
}

export interface ProactiveDecision {
  action: ProactiveAction;
  /** Why, in words the ledger and the benchmark can both read. */
  reason: string;
  /** Exactly what to send, or null when nothing is sent. */
  renderedMessage: string | null;
  /** How many inbound messages this one notice accounts for. */
  covers: number;
}

/**
 * Decide once per sender-window instead of once per message.
 *
 * Order matters and each branch states its own reason, because the reason is
 * what makes a suppression auditable rather than a silent drop:
 *
 *   1. Already told them inside the window → suppress. This is the branch that
 *      turns CL-033's ten pushes into one.
 *   2. A supplied relevance verdict says it is not worth surfacing → suppress.
 *      Never reached today; the hook is measured, not guessed.
 *   3. Otherwise send ONE notice covering everything in the window — a digest
 *      when more than one message arrived, the single-message wording when not.
 */
export function decideUnattachedReply(ctx: UnattachedReplyContext): ProactiveDecision {
  const windowMs = ctx.windowMs ?? UNATTACHED_WINDOW_MS;
  const inWindow = ctx.earlierFromSender
    .filter((m) => ctx.atMs - m.atMs <= windowMs)
    .sort((a, b) => a.atMs - b.atMs);
  const covers = inWindow.length + 1;

  // DEF-157 — volume suppression, and the two things it may not ignore.
  //
  // `retained` is the one that matters: suppressing a message the caller cannot
  // recover is not batching, it is deletion. DEF-156 did that. Requiring proof of
  // retention makes the regression impossible to reintroduce without the ledger
  // actually existing, which is stronger than a comment asking the next author to
  // remember.
  //
  // An explicit `worthSurfacing: true` also overrides volume — Codex's iteration-13
  // MEDIUM #4. A classifier that decides the second message is critical must not be
  // outvoted by "we already mentioned this sender". Volume is a courtesy; urgency
  // is not.
  if (ctx.alreadyNotifiedInWindow) {
    const urgent = ctx.relevance?.worthSurfacing === true;
    if (ctx.retained && !urgent) {
      return {
        action: 'suppress',
        reason: `already told you about ${ctx.who} within the last ${Math.round(windowMs / 60000)} minutes`
          + ` (${covers} message${covers === 1 ? '' : 's'} in that window, all retained`
          + ' for the next digest)',
        renderedMessage: null,
        covers,
      };
    }
    if (!ctx.retained) {
      // Deliberately noisy. The owner gets another notification, which IS the
      // DEF-139 defect — and it is the honest state until a burst ledger exists,
      // because the alternative is losing what he was told.
      return {
        action: 'send',
        reason: `already told you about ${ctx.who} in this window, but nothing retains`
          + ' this message yet — sending rather than dropping it (DEF-157)',
        renderedMessage: renderUnattachedDigest({ who: ctx.who, bodies: [ctx.body] }),
        covers: 1,
      };
    }
  }

  if (ctx.relevance && !ctx.relevance.worthSurfacing && ctx.retained) {
    return {
      action: 'suppress',
      // Also retention-gated: a message judged uninteresting is still the owner's
      // to see later if we were wrong about it.
      reason: `judged not worth surfacing: ${ctx.relevance.reason} (retained)`,
      renderedMessage: null,
      covers,
    };
  }

  const bodies = [...inWindow.map((m) => m.body), ctx.body];
  return {
    action: 'send',
    reason: covers === 1
      ? 'first message from this sender in the window'
      : `${covers} messages from this sender in the window, sent as one notice`,
    renderedMessage: renderUnattachedDigest({ who: ctx.who, bodies }),
    covers,
  };
}
