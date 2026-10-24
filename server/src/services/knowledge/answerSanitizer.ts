/**
 * Answer sanitizer — replaces bracketed system markers with
 * human-readable text before Brain's reply reaches the user.
 *
 * Context: several code paths (responseValidator, expired preview
 * handler, dispatch errors, malformed-output guard) intentionally
 * emit answers like:
 *   "[no action dispatched — retry with the action and target named explicitly]"
 *   "[notify_via_whatsapp preview expired — re-issue the request]"
 *   "[Brain unavailable — reasoning service down, retry shortly]"
 *
 * These markers were designed as INTERNAL signals for downstream
 * re-composition. But they've been leaking to WhatsApp users
 * verbatim (Basit chat 2026-07-07 showed both markers above hitting
 * the user in raw form). Users see machine-code output and think
 * Brain is broken.
 *
 * This sanitizer runs at the last mile — inside answerAsBrain
 * right before the answer is returned to any surface. It replaces
 * known markers with plain-language equivalents. Unknown bracketed
 * markers are stripped to avoid leaking future ones.
 */

import {
  isSystemMarker, isLegacyActionMarker, stripMarkerEnvelope, NEUTRAL_MARKER_FALLBACK,
} from './systemMarker';
// DEF-209 — the receipt's vocabulary lives with its constructor, so the parser
// and the marker builder cannot drift into two implementations of one label.
import { RECEIPT_SLOTS, APPLIED_FIELDS, actionPhrase, itemOutcomeMeaning, ledgerReadbackMeaning } from './actionReceipt';

interface MarkerRule {
  match: RegExp;
  replace: string;
  /** true = replace the WHOLE answer (marker was the entire content).
   *  false = strip just this marker from within a longer answer. */
  whole?: boolean;
}

const MARKERS: MarkerRule[] = [
  {
    // fabricated_completion_on_action_turn — the user requested a
    // mutation, the model CLAIMED it happened, nothing actually ran.
    // Honest wording: no invented dispatch failure, no recipient demand
    // (chat 9 rewording, 2026-07-14) — just the truth plus the offer.
    //
    // DEF-034, rewritten 2026-08-19 — the two defects the old sentence carried.
    //
    // SCOPE. The marker is TURN-scoped: "no action dispatched *in this turn*". The
    // sentence rendered it WORLD-scoped: "nothing was executed on my end." On 08-05 that
    // fired one second after Brain had successfully delegated three items, so the reply
    // was simply false about the world. It has since fired 21 more times in 14 days.
    // A turn-scoped fact may only be stated in turn-scoped words.
    //
    // DUPLICATION. "Say the word and I'll do it now" is an invitation to re-run work that
    // may already have happened — for anything with an external side effect (a message
    // sent, an item deleted) that is a second irreversible action, offered precisely when
    // the system has just admitted it does not know what ran. It now promises to CHECK
    // first, which is the only offer it can honestly make from this position.
    match: /^\s*\[no action dispatched[^\]]*\]\s*$/i,
    replace: "I didn't run anything just now, so I can't tell you it's done. Let me check what has already happened before I act — say \"go ahead\" and I'll verify first.",
    whole: true,
  },
  {
    // read_only_answer_validation_failed — a STATUS question whose
    // answer failed validation. No dispatch was attempted, so the
    // wording must never mention dispatch or recipients (chat 9).
    match: /^\s*\[status read failed[^\]]*\]\s*$/i,
    replace: "I found the item, but I couldn't reliably read its current status. Let me check it again.",
    whole: true,
  },
  {
    match: /^\s*\[[a-z_]+ preview expired[^\]]*\]\s*$/i,
    replace: "That draft expired before you confirmed. Want me to prepare it again?",
    whole: true,
  },
  {
    match: /^\s*\[[a-z_]+ validation failed:\s*([^\]]+)\]\s*$/i,
    replace: 'I couldn\'t complete that — $1. Try rephrasing, or give me more detail.',
    whole: true,
  },
  {
    match: /^\s*\[Action failed:\s*([^\]]+)\]\s*$/i,
    replace: "I hit an error trying to do that: $1. Retry when ready.",
    whole: true,
  },
  {
    match: /^\s*\[cancelled\]\s*$/i,
    replace: "OK, cancelled.",
    whole: true,
  },
  {
    match: /^\s*\[Brain unavailable[^\]]*\]\s*$/i,
    replace: "I'm having trouble reasoning right now. Please try again in a moment.",
    whole: true,
  },
  {
    match: /^\s*\[Brain output malformed[^\]]*\]\s*$/i,
    replace: "Something went wrong on my end. Try rephrasing your request?",
    whole: true,
  },
  {
    match: /^\s*\[fabricated escalation path[^\]]*\]\s*$/i,
    replace: "I can't route to a team like that — Nexeo doesn't have that channel. What concrete task should I do instead?",
    whole: true,
  },
  {
    match: /^\s*\[notify_via_whatsapp failed:\s*([^\]]+)\]\s*$/i,
    replace: "I couldn't send that WhatsApp: $1",
    whole: true,
  },
  {
    match: /^\s*\[notify_via_whatsapp:\s*([^\]]+)\]\s*$/i,
    replace: "Couldn't send WhatsApp — $1",
    whole: true,
  },
  {
    match: /^\s*\[delegate_open_item:\s*([^\]]+)\]\s*$/i,
    replace: "Couldn't delegate — $1",
    whole: true,
  },
  {
    match: /^\s*\[delegate failed:\s*([^\]]+)\]\s*$/i,
    replace: "The delegation failed: $1",
    whole: true,
  },
  {
    match: /^\s*\[send_email failed:\s*([^\]]+)\]\s*$/i,
    replace: "I couldn't send that email: $1",
    whole: true,
  },
  {
    match: /^\s*\[LLM returned empty response[^\]]*\]\s*$/i,
    replace: "I didn't come up with a response — try asking a different way?",
    whole: true,
  },
  {
    // DEF-211 — the ask branch's last-resort marker. A decider that chose to ask
    // and then supplied no question text has produced nothing sayable; the honest
    // reply is to admit the turn is unfinished rather than to type English here.
    match: /^\s*\[clarification needed:\s*([^\]]+)\]\s*$/i,
    replace: "I need one more detail before I can go on, and I've lost track of what it was — could you say again what you'd like me to do?",
    whole: true,
  },
  {
    match: /^\s*\[declined:\s*([^\]]+)\]\s*$/i,
    replace: "I can't do that: $1",
    whole: true,
  },
  {
    match: /^\s*\[target unresolved:\s*([^\]]+)\]\s*$/i,
    replace: "Before I do that, I need to confirm $1.",
    whole: true,
  },
  {
    match: /^\s*\[auto-send enabled:\s*([^\]]+)\]\s*$/i,
    replace: "Done — I'll send $1 without asking for confirmation from now on. I'll still verify every recipient is real, and I'll still ask whenever anything is unclear. Say \"always preview $1\" to turn confirmations back on.",
    whole: true,
  },
  {
    match: /^\s*\[auto-send disabled:\s*([^\]]+)\]\s*$/i,
    replace: "Done — I'll ask for your confirmation before sending $1 again.",
    whole: true,
  },
  {
    match: /^\s*\[noted\]\s*$/i,
    replace: "Got it — noted.",
    whole: true,
  },
  {
    match: /^\s*\[note saved\]\s*$/i,
    replace: "Saved.",
    whole: true,
  },
  {
    match: /^\s*\[assigned to\s+([^\]]+)\]\s*$/i,
    replace: "Assigned to $1.",
    whole: true,
  },
  {
    match: /^\s*\[due date set:\s*([^\]]+)\]\s*$/i,
    replace: "Due date set: $1.",
    whole: true,
  },
  {
    match: /^\s*\[owner not identified[^\]]*\]\s*$/i,
    replace: "I didn't catch who owns that — reply with a name or email.",
    whole: true,
  },
  {
    match: /^\s*\[couldn't parse\s+"([^"]+)"\s+as a date[^\]]*\]\s*$/i,
    replace: "I couldn't read \"$1\" as a date — try something like \"Friday\" or \"in 3 days\".",
    whole: true,
  },
];

/**
 * DEF-174/DEF-175 — the per-item digest's curated meaning, COMPUTED from a
 * structured payload rather than pattern-substituted from a sentence.
 *
 * The first version serialized the fields into a regex-delimited English
 * sentence and re-parsed it here — so an item titled `Revenue; latest: "CEO
 * approved"` terminated its own field at the delimiter and injected a false
 * Latest fact into what the owner reads (Codex iteration-41 HIGH). The marker
 * body is now JSON: escaping is the field boundary, so quotes, semicolons,
 * brackets and the literal delimiter text stay inside the field they belong
 * to. Anything that fails to parse or validate is NOT a digest — the caller
 * falls through to the neutral fallback, never to a half-parsed sentence.
 *
 * The rendered wording is the iteration-29 vetted sentence: facts and a
 * verbatim quote, no promise, no vocative, no first-person future.
 * Constructor and this parser are held in sync by
 * def174DigestMarkerProvenance.test.ts.
 */
function digestMarkerMeaning(answer: string): string | null {
  const m = /^\s*\[selfpruning_digest:\s*(\{.*\})\s*\]\s*$/.exec(answer ?? '');
  if (!m) return null;
  try {
    const p = JSON.parse(m[1]);
    // DEF-176: domain bounds and internal consistency are part of validity —
    // `unanswered > total`, a negative count, a non-integer (JSON.parse turns
    // `1e309` into Infinity), or a count/window past the constructor's own
    // clamps is a payload the constructor cannot have produced, so it is NOT
    // a digest. Reject to the neutral fallback; never render impossible facts.
    if (typeof p?.label !== 'string' || typeof p?.latest !== 'string'
      || !Number.isInteger(p?.total) || p.total < 0 || p.total > 10_000
      || !Number.isInteger(p?.unanswered) || p.unanswered < 0 || p.unanswered > p.total
      || !Number.isInteger(p?.windowHours) || p.windowHours < 1 || p.windowHours > 8_760) return null;
    const label = p.label.slice(0, 120);
    const latest = p.latest.slice(0, 140);
    return `${label}: ${p.total} updates in the last ${p.windowHours}h, `
      + `${p.unanswered} of them unanswered. Latest: "${latest}". `
      + `The earlier updates are kept in full — nothing was discarded.`;
  } catch {
    return null;
  }
}

/**
 * DEF-186 — the withdrawal notice's curated meaning (C-3 increment 3).
 *
 * Same contract as `digestMarkerMeaning`, same reasons: the marker body is
 * JSON so a title cannot cross its field boundary, and this parser REJECTS
 * anything the constructor (`renderSelfPruneNotice`) cannot have produced —
 * a zero or impossible count, more named titles than withdrawn items, a
 * non-string member — rather than repairing it into a fact nobody asserted.
 * Constructor and parser are held in sync by def186SelfPruneWithdrawnNotice.test.ts.
 *
 * The wording keeps the vetted rules: facts only, no promise, no vocative, no
 * first-person future. "Can be restored" is a standing property of the archive
 * (CANCELLED -> TRIAGED exists in the transition matrix and nothing is
 * deleted), not a promised future action.
 */
function withdrawnMarkerMeaning(answer: string): string | null {
  const m = /^\s*\[selfpruning_withdrawn:\s*(\{.*\})\s*\]\s*$/.exec(answer ?? '');
  if (!m) return null;
  try {
    const p = JSON.parse(m[1]);
    if (!Number.isInteger(p?.count) || p.count < 1 || p.count > 10_000) return null;
    if (!Array.isArray(p?.titles) || p.titles.length > 3 || p.titles.length > p.count) return null;
    if (p.titles.some((t: unknown) => typeof t !== 'string')) return null;
    const titles = (p.titles as string[])
      .map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 80))
      .filter((t) => t.length > 0);
    const named = titles.map((t) => `"${t}"`).join(', ');
    const more = p.count - titles.length;
    // "open items", not "inactive open items": the run also withdraws
    // duplicates, smoke residue and gate-rejected junk, and the meaning must
    // be true of every reason, not just the stale one.
    const noun = p.count === 1 ? 'open item' : 'open items';
    return `${p.count} ${noun} withdrew from the backlog`
      + `${named ? `: ${named}` : ''}`
      + `${named && more > 0 ? ` and ${more} more` : ''}. `
      + `Each one is kept in full and can be restored.`;
  } catch {
    return null;
  }
}

/**
 * DEF-209 — the action receipt's curated meaning.
 *
 * Same contract as `digestMarkerMeaning` and `withdrawnMarkerMeaning`: the body
 * is JSON, this parser REJECTS anything the constructor cannot have produced,
 * and an unparseable payload is null rather than a guess.
 *
 * Two facts and no more, because the caller only knows two things at this point:
 *
 *   - the action is BEING dispatched, not finished. The judge's C1 note on
 *     B04 was "'Proceeding with update open item' implies that an action is
 *     being taken, but it's unclear if this action has actually been initiated",
 *     and the honest answer is that it is under way and not yet confirmed. It
 *     must not read as completion — that is the `fabricated-status` class.
 *   - which parts of BRAIN'S OWN earlier question are still unanswered, named,
 *     so the next sentence chases them instead of dropping them.
 *
 * `sanitizeAnswerInBrainVoice` takes this as the FACT and lets the model choose
 * the words, which is what stops the reply reading as a template.
 */
function proceedingMarkerMeaning(answer: string): string | null {
  const m = /^\s*\[proceeding:\s*(\{.*\})\s*\]\s*$/.exec(answer ?? '');
  if (!m) return null;
  try {
    const p = JSON.parse(m[1]);
    if (typeof p?.action !== 'string' || !p.action.trim()) return null;
    if (!Array.isArray(p?.outstanding) || p.outstanding.length > 4) return null;
    if (p.outstanding.some((k: unknown) => typeof k !== 'string')) return null;
    const labels = (p.outstanding as string[])
      .map((k) => RECEIPT_SLOTS.find((s) => s.key === k)?.label)
      .filter((l): l is string => Boolean(l));
    // A key the constructor's own vocabulary does not contain is not a receipt.
    if (labels.length !== p.outstanding.length) return null;

    const phrase = actionPhrase(p.action);
    const base = `${phrase} is going ahead now; it has not been confirmed yet`;
    if (labels.length === 0) return `${base}.`;
    const named = labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
    // "still unanswered from the earlier question" — not "missing": the owner
    // did answer, just not all of it, and saying otherwise would be wrong about
    // what he did.
    return `${base}. ${named} ${labels.length === 1 ? 'is' : 'are'} still unanswered `
      + 'from the earlier question. ASK FOR IT IN THIS REPLY — do not promise to ask later and do not\n'
      + 'make it conditional. He answered part of what you asked; the rest is still open now.';
  } catch {
    return null;
  }
}

/**
 * DEF-212 / DEF-220 — the applied receipt's curated meaning.
 *
 * DEF-212 quoted the receipt verbatim, on the reasoning that it is true by
 * construction and this parser should not restate a fact it did not establish.
 * The reasoning was right about truth and wrong about who was speaking: the
 * receipt is `Updated "…": priority=high.` — field names and an equals sign —
 * and when nothing was outstanding that string WAS the returned meaning, so it
 * reached him unchanged. DEF-219 then made that the common branch.
 *
 * So the payload carries fields and values now, and the sentence is composed
 * here from `APPLIED_FIELDS` — one vocabulary, shared with the builder, exactly
 * as `RECEIPT_SLOTS` is for the outstanding half. Nothing is softened, inferred
 * or added: every clause names a field the database actually received and the
 * value it received.
 */
function appliedMarkerMeaning(answer: string): string | null {
  const m = /^\s*\[applied:\s*(\{.*\})\s*\]\s*$/.exec(answer ?? '');
  if (!m) return null;
  try {
    const p = JSON.parse(m[1]);
    if (typeof p?.title !== 'string' || !p.title.trim()) return null;
    if (!Array.isArray(p?.applied) || p.applied.length < 1 || p.applied.length > 6) return null;
    if (!Array.isArray(p?.outstanding) || p.outstanding.length > 4) return null;
    if (p.outstanding.some((k: unknown) => typeof k !== 'string')) return null;
    const labels = (p.outstanding as string[])
      .map((k) => RECEIPT_SLOTS.find((s) => s.key === k)?.label)
      .filter((l): l is string => Boolean(l));
    if (labels.length !== p.outstanding.length) return null;

    // A field outside the shared vocabulary is not a receipt this builder made.
    const clauses: string[] = [];
    for (const c of p.applied as unknown[]) {
      const change = c as { f?: unknown; v?: unknown };
      if (typeof change?.f !== 'string' || typeof change?.v !== 'string' || !change.v.trim()) return null;
      const spec = APPLIED_FIELDS.find((s) => s.key === change.f);
      if (!spec) return null;
      clauses.push(spec.say(change.v.trim()));
    }

    const said = clauses.length === 1
      ? clauses[0]
      : `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
    const done = `The open item "${String(p.title).trim()}" was updated: ${said}.`;
    if (labels.length === 0) return done;
    const named = labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
    return `${done} ${named} ${labels.length === 1 ? 'is' : 'are'} still unanswered `
      + 'from the earlier question. ASK FOR IT IN THIS REPLY — do not promise to ask later and do not\n'
      + 'make it conditional. He answered part of what you asked; the rest is still open now.';
  } catch {
    return null;
  }
}

/**
 * DEF-217 — the inbound-noise count's curated meaning.
 *
 * Same contract as the digest and withdrawal markers: JSON body, and a payload
 * the constructor could not have produced is rejected rather than repaired.
 *
 * It states COUNTS and nothing else. No recommendation, no "shall I mute them",
 * no judgement about the sender — increment 1 is explicitly the number that
 * proves the problem, and a report that proposed an action would be increment 2
 * arriving early, unreviewed and ungated.
 */
function noiseMarkerMeaning(answer: string): string | null {
  const m = /^\s*\[selfpruning_noise:\s*(\{.*\})\s*\]\s*$/.exec(answer ?? '');
  if (!m) return null;
  try {
    const p = JSON.parse(m[1]);
    if (typeof p?.sender !== 'string' || !p.sender.trim()) return null;
    if (!Number.isInteger(p?.reached) || p.reached < 1 || p.reached > 10_000) return null;
    if (!Number.isInteger(p?.acted) || p.acted < 0 || p.acted > p.reached) return null;
    if (!Number.isInteger(p?.windowHours) || p.windowHours < 1 || p.windowHours > 8_760) return null;
    if (typeof p?.unattributed !== 'boolean') return null;
    // DEF-230 — optional, and validated when present: at least two subsystems,
    // and never more of them than there were pushes. The constructor only emits
    // it at >= 2, so anything else is a payload it could not have produced.
    if (p.producers !== undefined) {
      if (!Number.isInteger(p.producers) || p.producers < 2 || p.producers > p.reached) return null;
    }

    const sender = String(p.sender).slice(0, 80);
    const push = p.reached === 1 ? 'message' : 'messages';
    const acted = p.acted === 0
      ? 'you acted on none of them'
      : `you acted on ${p.acted}`;
    // "could not be tied to" — the join failed, which is a fact about the rows,
    // not a claim that the sender is unknown to him.
    const identity = p.unattributed
      ? ' None of them could be tied to an open item or thread.'
      : '';
    // The production finding, said as a fact: the pushes came from N different
    // subsystems, which is why he received so many about one thing.
    const via = p.producers !== undefined
      ? `, from ${p.producers} different subsystems that each push on their own schedule,`
      : '';
    return `In the last ${p.windowHours}h, ${sender} reached you with ${p.reached} ${push}${via}`
      + ` and ${acted}.${identity}`;
  } catch {
    return null;
  }
}

/**
 * DEF-349 — the pending-proposals digest's curated meaning.
 *
 * Same contract as the digest/withdrawal/noise markers: JSON body, and a
 * payload the constructor could not have produced is rejected rather than
 * repaired. It states FACTS — how many proposals await his approval, what the
 * new ones say, where to act — and proposes nothing itself: the proposals are
 * already human-gated rows; this only tells him they exist, which is the half
 * of the Learn loop that was missing (DEF-348 generates, nothing surfaced).
 */
function learnProposalDigestMeaning(answer: string): string | null {
  const m = /^\s*\[learn_proposal_digest:\s*(\{.*\})\s*\]\s*$/.exec(answer ?? '');
  if (!m) return null;
  try {
    const p = JSON.parse(m[1]);
    if (!Number.isInteger(p?.pendingTotal) || p.pendingTotal < 1 || p.pendingTotal > 10_000) return null;
    if (!Number.isInteger(p?.newSinceLast) || p.newSinceLast < 1 || p.newSinceLast > p.pendingTotal) return null;
    if (!Array.isArray(p?.titles) || p.titles.length < 1 || p.titles.length > 5) return null;
    if (!p.titles.every((t: unknown) => typeof t === 'string' && (t as string).trim().length > 0 && (t as string).length <= 80)) return null;

    const newNoun = p.newSinceLast === 1 ? 'memory proposal' : 'memory proposals';
    const titles = (p.titles as string[]).map((t) => `“${t.trim()}”`).join(', ');
    const total = p.pendingTotal > p.newSinceLast
      ? ` That makes ${p.pendingTotal} waiting in total.`
      : '';
    return `From your recent conversations I drafted ${p.newSinceLast} new ${newNoun} — ${titles} — `
      + `waiting for your approval under Settings → Brain Memories. Nothing is applied until you approve it.${total}`;
  } catch {
    return null;
  }
}

/**
 * The curated meaning of a whole-answer marker, when we have one.
 *
 * These 25 replacements are not throwaway strings — several were reworded
 * against real chat transcripts to stop them implying a dispatch that never
 * happened, or demanding a recipient on a read-only turn. That precision is
 * worth keeping. What is NOT worth keeping is saying them the same way every
 * time, which is what makes Brain sound like a machine.
 *
 * So `sanitizeAnswerInBrainVoice` uses this as the FACT and lets the LLM choose
 * the words. The careful semantics survive; the sameness does not.
 */
export function curatedMarkerMeaning(answer: string): string | null {
  if (!answer) return null;
  // Structured payloads first (DEF-175): parsed and validated, never
  // regex-substituted — an unparseable payload is null, not a guess.
  const digest = digestMarkerMeaning(answer);
  if (digest) return digest;
  const withdrawn = withdrawnMarkerMeaning(answer);
  if (withdrawn) return withdrawn;
  const proceeding = proceedingMarkerMeaning(answer);
  if (proceeding) return proceeding;
  const applied = appliedMarkerMeaning(answer);
  if (applied) return applied;
  const noise = noiseMarkerMeaning(answer);
  if (noise) return noise;
  const learnDigest = learnProposalDigestMeaning(answer);
  if (learnDigest) return learnDigest;
  // DEF-238 — the item-action outcome. Constructor and renderer share one
  // module (`actionReceipt.ts`), so a receipt an executor mints is renderable
  // here by construction — the drift that swallowed a SUCCESSFUL delete on
  // 2026-08-19 22:23 cannot recur for this family.
  const outcome = itemOutcomeMeaning(answer);
  if (outcome) return outcome;
  // DEF-034(b) — the read-back receipt. Same one-module contract as itemOutcome.
  const readback = ledgerReadbackMeaning(answer);
  if (readback) return readback;
  for (const rule of MARKERS) {
    if (rule.whole && rule.match.test(answer)) return answer.replace(rule.match, rule.replace);
  }
  return null;
}

/** True when the answer is nothing but a bracketed marker. */
export function isWholeMarker(answer: string): boolean {
  return /^\s*\[[^\]]{2,200}\]\s*$/.test(answer ?? '');
}

/**
 * Rewrite bracketed system markers to user-friendly language.
 * Preserves all other content unchanged.
 *
 * Kept synchronous and unchanged: it is the fallback for
 * `sanitizeAnswerInBrainVoice` and is what non-conversational surfaces use.
 */
export function sanitizeAnswerForUser(answer: string): string {
  if (!answer) return answer;

  // Try whole-answer replacements first — these produce the cleanest
  // output when the marker WAS the entire response.
  for (const rule of MARKERS) {
    if (rule.whole && rule.match.test(answer)) {
      return answer.replace(rule.match, rule.replace);
    }
  }

  // ── DEF-168 / DEF-169 — the promise kept, and then kept CORRECTLY ───────
  //
  // The header says unknown bracketed markers are stripped. It was false: this
  // function matched an enumerated list, so iteration 21's two new markers
  // reached the owner verbatim (DEF-168).
  //
  // My first fix matched the SHAPE `/^\[...\]$/` instead, which cannot tell an
  // internal signal from a person writing `[see attached]` or `[Approved by
  // Basit]` — Codex's iteration-22 HIGH #1, and my build entry claimed the
  // opposite while the test omitted the example. A bracket is punctuation; it
  // carries no provenance.
  //
  // So the check is now provenance: `systemMarker()` stamps an invisible
  // sentinel at the producer, and this reads it. Legitimate bracketed prose is
  // untouched because it never had the stamp, and a marker invented next month
  // is caught because its producer used the constructor.
  if (isSystemMarker(answer) || isLegacyActionMarker(answer)) {
    const curated = curatedMarkerMeaning(stripMarkerEnvelope(answer));
    // A curated meaning is vetted plain language; anything else states the
    // situation and stops (see `NEUTRAL_MARKER_FALLBACK` on why it promises
    // nothing).
    if (!curated) {
      // DEF-238 — the swallow is NAMED. On 2026-08-19 22:23 this line replaced
      // the receipt of a successful delete with the fallback and recorded
      // nothing, so the producing marker had to be dug out of pm2 logs and the
      // database. A guard that discards an answer must log what it discarded.
      console.warn('[answer-sanitizer] marker had no curated meaning — neutral fallback shipped', {
        markerHead: stripMarkerEnvelope(answer).slice(0, 120),
      });
    }
    return curated ?? NEUTRAL_MARKER_FALLBACK;
  }

  // Embedded auto-send OFFER (Phase 1C) — appended after a successful
  // dispatch message, so it arrives embedded rather than whole. Render
  // the human offer with the exact toggle phrases the command parser
  // accepts (autoConfirmService.parseAutoConfirmCommand).
  const OFFER_WORDS: Record<string, string> = {
    send_email: 'emails',
    notify_via_whatsapp: 'WhatsApp messages',
    schedule_meeting: 'meeting invites',
  };
  let result0 = answer.replace(/\[auto-send offer:\s*(send_email|notify_via_whatsapp|schedule_meeting)\]/g, (_m, kind: string) => {
    const w = OFFER_WORDS[kind] ?? kind;
    return `By the way — you've approved my last 10 ${w} previews without changes. Want me to skip the confirmation step for ${w} from now on? Reply "auto-send ${w === 'emails' ? 'emails' : w === 'WhatsApp messages' ? 'whatsapp' : 'meetings'}" to enable (I'll still verify recipients and still ask when anything's unclear). "always preview ${w === 'emails' ? 'emails' : w === 'WhatsApp messages' ? 'whatsapp' : 'meetings'}" turns it back anytime.`;
  });

  // Otherwise, sanitize any leaked bracketed markers embedded in prose.
  // Only touch things that LOOK like our system markers (all-lowercase
  // action name, ends with `]`, contains a colon or "expired" / "failed"
  // / "dispatched"). Preserves legitimate uses of square brackets.
  let result = result0;
  const embeddedMarker = /\[(?:[a-z_]+\s+(?:preview\s+expired|validation\s+failed|failed:|dispatched)|no action dispatched|status read failed|cancelled|Action failed:|Brain unavailable|Brain output malformed|fabricated escalation path|LLM returned empty response)[^\]]*\]/g;
  // DEF-073 (2026-08-06): this was `/\s{2,}/g`, and `\s` matches newlines.
  // Two characters — "\n\n" — collapsed to a single space, so EVERY blank
  // line in EVERY reply was destroyed while single newlines survived. The Day
  // Brief arrived with each section heading glued to the end of the previous
  // bullet, because the blank line before it was eaten.
  //
  // The intent was only ever to tidy the double space left behind after
  // deleting a marker from mid-sentence. `[ \t]` does exactly that and leaves
  // paragraph structure alone. Note the marker removal itself is a no-op when
  // no marker is present — but this collapse always ran.
  result = result.replace(embeddedMarker, '').replace(/[ \t]{2,}/g, ' ').trim();

  return result || answer;
}

/**
 * The conversational path: same truth, said like a person.
 *
 * Owner, 2026-08-07: *"i don't want robotic answers if i talk to brain neither
 * anyone else talk to brain"* — objective, *"smart thinking of brain like living
 * assistant"*.
 *
 * Three cases, and the third is the one that was actually hurting:
 *
 *   1. Whole-answer marker WITH a curated meaning → the LLM rephrases that
 *      meaning. The careful wording is preserved as fact; only the phrasing
 *      varies.
 *   2. Whole-answer marker with NO curated meaning → the LLM renders the marker
 *      itself. Previously 77 of 102 markers fell here and were stripped to
 *      SILENCE, so the user watched their request vanish. Silence reads as
 *      broken far more than plain wording does.
 *   3. Prose with embedded markers → unchanged synchronous strip. An embedded
 *      marker is a fragment inside a real sentence; rewriting the whole reply
 *      around it would risk the fabrication this codebase keeps fighting.
 *
 * Never throws. On any failure the synchronous sanitizer is the fallback, so
 * the worst case is the behaviour we had before, not a lost reply.
 */
export async function sanitizeAnswerInBrainVoice(
  answer: string,
  ctx: { clientNumber?: string; userId?: number; audience?: 'owner' | 'counterpart'; userMessage?: string } = {},
): Promise<string> {
  if (!answer) return answer;
  // DEF-169 — a bracket alone is not a marker on THIS path either.
  //
  // Found by driving the WhatsApp path after fixing the web one: `isWholeMarker`
  // is a SHAPE test, so `[see attached]` entered this branch, found no curated
  // meaning and became the neutral fallback — Codex's HIGH #1 reproduced exactly,
  // on the surface he said to prove. Provenance decides; a legacy bare-bracket
  // producer is honoured only when its meaning is one of the curated ones.
  const curated = curatedMarkerMeaning(stripMarkerEnvelope(answer));
  const isMarker = isSystemMarker(answer)
    || isLegacyActionMarker(answer)
    || (isWholeMarker(answer) && !!curated);
  if (!isMarker) return sanitizeAnswerForUser(answer);

  // ── DEF-169 — an UNCURATED marker never reaches the language model ───────
  //
  // Codex's iteration-22 HIGH #2. This used to call
  // `renderMarkerInBrainVoice(curated ?? answer.trim())`, so when no curated
  // meaning existed the raw internal text became the model's ONLY fact — and
  // iteration 21's marker was a policy instruction addressed to the composer
  // ("say what is observable and that the cause is not known"). The model
  // politely rewrote an internal note into Brain's voice and gave it to the
  // owner. `markerVoice.lastResort` does the same thing without an LLM: it
  // capitalises the marker body and returns it as prose. So BOTH the success
  // and the failure path published internal text, and the synchronous
  // catch-all never ran on WhatsApp at all.
  //
  // Only a CURATED meaning — a vetted plain-language sentence about what
  // happened — is safe to hand over. Everything else takes the neutral
  // fallback, which is not a rewriting problem and so needs no model.
  if (!curated) {
    // DEF-238 — same rule as the synchronous path: a discarded answer is
    // logged, never silently vanished (the 22:23 swallow left no trace).
    console.warn('[answer-sanitizer] marker had no curated meaning — neutral fallback shipped', {
      markerHead: stripMarkerEnvelope(answer).slice(0, 120),
    });
    return NEUTRAL_MARKER_FALLBACK;
  }

  try {
    const { renderMarkerInBrainVoice } = await import('./markerVoice');
    // The curated sentence is the fact; the renderer's job narrows to saying it
    // naturally. It never sees the raw marker.
    const spoken = await renderMarkerInBrainVoice(curated, ctx);
    return spoken || curated;
  } catch {
    return curated;
  }
}
