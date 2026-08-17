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

// DEF-174 — the digest renderer emits a provenance-stamped marker, not prose;
// the sentinel is also STRIPPED from interpolated text so a quoted message can
// never smuggle a second envelope into the one being built.
import { systemMarker, stripMarkerEnvelope } from '../knowledge/systemMarker';

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
 * DEF-173 / DEF-174 — the per-item digest notice (C-3 increment 2).
 *
 * Two corrections from review, and the second one is why this returns a MARKER:
 *
 * Codex's iteration-29 CRITICAL: the first version was a fixed English template
 * assembled inside the digest policy, pretending to be Brain (invariant #4) and
 * promising *"Reply 'show all' and I'll list each one"* — a handler that does
 * not exist (invariant #5's shape). Iteration 29 moved the literals here.
 *
 * Codex's iteration-30 CRITICAL: moving the literals does not satisfy the
 * invariant — deterministic owner-facing Brain prose is forbidden WHEREVER the
 * file is. The one sanctioned deterministic form is a bracketed system marker
 * rendered by `answerSanitizer` (AGENTS.md invariant #4), so this now emits
 * exactly that: a provenance-stamped `systemMarker()` carrying the FACTS, whose
 * one vetted meaning lives in `answerSanitizer`'s curated rules, spoken through
 * the `markerVoice` LLM boundary at delivery. The words the owner reads are no
 * longer written in this function.
 *
 * The facts themselves keep the iteration-29 rules: counts the caller measured,
 * a verbatim quote, no promised actions, no vocative, no first-person future.
 *
 * The payload is JSON, not an English sentence (DEF-175, Codex iteration-41
 * HIGH): the first marker serialized the fields into a regex-delimited sentence,
 * so an item titled `Revenue; latest: "CEO approved"` terminated its own field
 * and INJECTED a false Latest fact into what the owner reads. JSON escaping is
 * the field boundary — a title can contain quotes, semicolons, brackets or the
 * literal delimiter text and it stays inside its field. Only the marker
 * SENTINEL is stripped from inputs (a quoted push must not smuggle a second
 * envelope); everything else survives verbatim into its own field.
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
  const clean = (s: string) => stripMarkerEnvelope(s ?? '').replace(/\s+/g, ' ').trim();
  // DEF-176 (Codex iteration-42 MEDIUM): the counts are CLAMPED into a sane
  // domain and forced consistent (unanswered can never exceed total) — a
  // caller bug must not become a mathematically impossible owner fact. The
  // parser side (`digestMarkerMeaning`) REJECTS rather than clamps, so a
  // payload this constructor cannot have produced fails to the neutral
  // fallback instead of being repaired into something nobody asserted.
  const int = (n: number, lo: number, hi: number) =>
    (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : lo);
  const total = int(totalCount, 0, 10_000);
  const payload = {
    label: clean(label).slice(0, 120),
    total,
    unanswered: Math.min(int(unansweredCount, 0, 10_000), total),
    windowHours: int(windowHours, 1, 8_760),
    latest: clean(latest).slice(0, 140),
  };
  return systemMarker(`selfpruning_digest: ${JSON.stringify(payload)}`);
}

/**
 * DEF-186 — the withdrawal notice (C-3 increment 3).
 *
 * The backlog cleanup archives junk reversibly and used to do it in silence;
 * the campaign's own wording is *"the owner is told once what was withdrawn"*.
 * This is that one message, in the same sanctioned form as the digest above
 * and for the same reviewed reasons: a provenance-stamped marker carrying only
 * FACTS as JSON (the field boundary), whose single vetted meaning lives in
 * `answerSanitizer` and is spoken through the `markerVoice` boundary. Same
 * constructor-clamps / parser-rejects split as `renderItemDigest`.
 *
 * "Once" is the caller's property, not this function's: an item is archived
 * exactly once, and the notice covers only the items archived in that run.
 */
export function renderSelfPruneNotice(args: {
  /** How many items this run withdrew for this owner. */
  count: number;
  /** Up to three of their titles, verbatim; the rest ride as arithmetic. */
  titles: readonly string[];
}): string {
  const clean = (s: string) => stripMarkerEnvelope(s ?? '').replace(/\s+/g, ' ').trim();
  const int = (n: number, lo: number, hi: number) =>
    (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : lo);
  const titles = (Array.isArray(args.titles) ? args.titles : [])
    .slice(0, 3)
    .map((t) => clean(String(t)).slice(0, 80))
    .filter((t) => t.length > 0);
  const payload = {
    // A notice about nothing is a caller bug; clamp keeps count >= titles
    // named, so the parser's consistency check cannot be tripped from here.
    count: Math.max(int(args.count, 1, 10_000), titles.length, 1),
    titles,
  };
  return systemMarker(`selfpruning_withdrawn: ${JSON.stringify(payload)}`);
}
