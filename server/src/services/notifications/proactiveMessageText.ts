/**
 * proactiveMessageText — the WORDS the proactive surface sends the owner.
 *
 * Extracted, not written (DEF-155, 2026-08-12, campaign C-1). Every function
 * here is a template that already existed inline at its call site; the strings
 * are byte-identical and the call sites now delegate. Nothing about what the
 * owner receives changes.
 *
 * ── WHY EXTRACT THEM ────────────────────────────────────────────────────────
 *
 * CL-033: **14 of 19 owner-facing messages in a six-hour window were proactive
 * notifications**, and CL-034/R-1 is eight turns of an owner arguing with them.
 * That surface has never been scored. `nexeoCapabilityBenchmark.ts` drives
 * `answerAsBrain` — twelve REPLIES — so the loop has spent eleven iterations
 * optimising the smaller half of what the owner reads.
 *
 * The proactive text could not be scored because it was assembled inline inside
 * jobs that also decide, dedupe, gate on office hours and dispatch. Judging it
 * meant running a job against live data. As pure functions it can be judged
 * exactly as production renders it, with no write and no send — which is a
 * stronger guarantee than D-1's teardown, because there is nothing to tear down.
 *
 * ── WHAT THIS MEASURES, AND WHAT IT DOES NOT ────────────────────────────────
 *
 * Measures: the words. Whether a notification reads like a person, states what
 * it knows, and asks something answerable.
 *
 * Does NOT measure: whether the message should have been sent at all, or when.
 * DEF-139 (ten pushes from one sender in 3h20m) is a DECISION defect.
 *
 * One correction from the slice's first run: judging the sentence DOES catch the
 * repetition when several are shown together — the judge scored that window
 * C4 = 70 for repeating the parenthetical six times. It is the timing and the
 * suppression decision that stay invisible, not the duplication itself.
 */

/** Where a proactive message came from. Kept alongside the renderers so a new
 *  producer has an obvious place to declare itself and be picked up by the
 *  proactive slice rather than shipping unmeasured. */
export type ProactiveKind =
  | 'lifecycle_intervention'
  | 'unattached_reply';

/**
 * The lifecycle intervention notice.
 *
 * Verbatim from `actionLifecycleService.ts` (the `needsUserIntervention`
 * branch). This is the shape the owner saw twice in R-1 and the one the
 * benchmark judge marked down on B08 as *"repeated deterministic framing"*.
 * Its form is its meaning — a rendered artifact, not persona prose — which is
 * why DEF-140 classified this producer `deterministic` and why the address
 * boundary leaves it alone.
 */
export function renderLifecycleIntervention(args: {
  itemTitle: string;
  summary: string;
  delayReason?: string | null;
}): string {
  const { itemTitle, summary, delayReason } = args;
  return `Intervention needed on "${itemTitle}". ${summary}`
    + `${delayReason ? ` Delay reason: ${delayReason}.` : ''}`
    + ' Please decide whether to remove the blocker, contact the responsible'
    + ' person, reassign it, or set a new deadline.';
}

/**
 * The unattached-counterpart-reply notice.
 *
 * Verbatim from `delegationCaptureService.notifyOwnerOfUnattachedReply`. It
 * embeds the counterpart's message inside quotes, which is why DEF-140
 * classified this producer `quoted_third_party`: the owner-address boundary must
 * not rewrite a word of someone else's message.
 *
 * This is the exact renderer that produced **ten** consecutive notifications
 * from one unknown number in CL-033. The words are not the defect there — the
 * decision to send each one is (DEF-139) — and keeping that distinction visible
 * is why the docblock above says what this slice cannot see.
 */
export function renderUnattachedReply(args: {
  who: string;
  body: string;
}): string {
  const { who, body } = args;
  return `${who} replied: "${body.slice(0, 300)}"\n\n`
    + '(Not attached to an open request — everything I had with them is already'
    + ' closed or waiting on you.)';
}

/**
 * ONE notice covering several messages from the same sender (DEF-156).
 *
 * CL-033: ten separate pushes from one unknown number between 09:05 and 12:26,
 * each carrying the same parenthetical. The words were not the defect — the
 * decision to send each one was. `renderUnattachedReply` above is correct for a
 * single message and wrong six times in a row, which the proactive slice scored
 * C4 = 70 for: *"A human would likely summarize or state this once … not repeat
 * it verbatim six times."*
 *
 * This is the shape a person would use instead: name them once, quote what they
 * said, and say plainly that none of it is attached to open work. The quotes stay
 * verbatim — DEF-140 classified this producer `quoted_third_party` and the
 * owner-address boundary must not rewrite a word of someone else's message.
 */
export function renderUnattachedDigest(args: {
  who: string;
  bodies: readonly string[];
}): string {
  const { who, bodies } = args;
  if (bodies.length === 1) return renderUnattachedReply({ who, body: bodies[0] });
  const quoted = bodies.map((b) => `• "${b.slice(0, 300)}"`).join('\n');
  return `${who} sent ${bodies.length} messages:\n${quoted}\n\n`
    + '(None of it is attached to an open request — everything I had with them is'
    + ' already closed or waiting on you.)';
}

/**
 * DEF-173 — the per-item digest notice (C-3 increment 2).
 *
 * Codex's iteration-29 CRITICAL: the first version was a fixed English template
 * assembled inside the digest policy, pretending to be Brain (invariant #4) and
 * promising *"Reply 'show all' and I'll list each one"* — a handler that does
 * not exist (invariant #5's shape). This file is the reviewed boundary where
 * proactive text is rendered from structured facts (DEF-155), so the digest's
 * words live here, next to `renderUnattachedDigest`, under the same rules:
 *
 *   - facts and verbatim quotes only; counts the caller measured, not adjectives;
 *   - NO promised actions. Nothing here says "reply X and I'll do Y" unless a
 *     handler for X exists — today none does, so the text states where the
 *     earlier updates are and stops;
 *   - no vocative, no apology, no first-person future.
 */
export function renderItemDigest(args: {
  /** The item's title in quotes, or a neutral fallback. */
  label: string;
  /** Every update in the window, including the one being folded in. */
  totalCount: number;
  /** The ones he has not answered. */
  unansweredCount: number;
  windowHours: number;
  /** The newest update's text, quoted verbatim. */
  latest: string;
}): string {
  const { label, totalCount, unansweredCount, windowHours, latest } = args;
  return `${label}: ${totalCount} updates in the last ${windowHours}h, ${unansweredCount} of them unanswered. `
    + `Latest: "${latest.trim().slice(0, 140)}". `
    + `The earlier updates are kept in full — nothing was discarded.`;
}
