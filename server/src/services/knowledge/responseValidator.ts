/**
 * responseValidator — final safety pass over Brain's user-visible reply.
 *
 * Sprint 4B (2026-05-21). Consolidates the scattered runtime checks
 * (empty-promise regex, fabricated-escalation rule, capability
 * overreach, raw-JSON leaks, cross-tenant data echo) into a single
 * deterministic gate run AFTER all composition + dispatch and BEFORE
 * the channel renderer emits to the user.
 *
 * Output is a list of violations; each violation also carries a
 * suggested replacement (a bracketed status marker following the
 * pattern from feedback_no_hardcoded_brain_replies). The caller
 * decides whether to:
 *   - block + override (high-severity, e.g., completion-claim-without-action)
 *   - log + ship (low-severity, e.g., minor style)
 *
 * This is the reviewer's #15 ("response critic before rendering"),
 * implemented deterministically — no extra LLM call. Most checks
 * are pattern-based and have proven reliable in earlier inline guards.
 */
import type { ComposeResult } from './brainComposer';

export type Severity = 'block' | 'warn';

export interface ResponseViolation {
  rule: string;
  severity: Severity;
  description: string;
  suggestedReplacement?: string;
}

export interface ValidationOutcome {
  ok: boolean;                          // true when no blocking violations
  violations: ResponseViolation[];
  replacement?: string;                 // present when a block-severity rule wins
}

// ── DEF-041 (2026-08-05): this file used to keep its OWN copy. ──────────
//
// The comment above it read "Same regex used by the inline empty-promise
// guard. Kept in sync there for compatibility; this validator is the canonical
// definition going forward." Both halves of that were false. The copies had
// diverged, and the one that actually runs at the egress — this one — was the
// WEAKER of the two. It was first-person-only: no `i will`, no passive voice,
// no headless past tense.
//
// So it matched NEITHER of the two sentences in the 14:07 incident:
//     "I will delegate all four unassigned items to Hamna Latif Bhutta now."
//     "These items have been delegated to you."
// The second is the literal body of the email sent to a colleague. DEF-002
// widened the composer's copy to cover passive voice in July precisely so that
// "The email has been sent to Asad" could not recur — that widening never
// reached the copy on the live path.
//
// There is now ONE definition, owned by brainComposer, and
// `def041ReasoningExemption.test.ts` fails the build if a second appears.
// Third time today this shape has bitten (DEF-039 duplicated guards,
// DEF-041 duplicated regex): a protection with two implementations has one
// real implementation and one comforting fiction.
import { EMPTY_PROMISE_RE, isConditionalFutureBehaviour } from './brainComposer';

// Fabricated process / escalation language. Per rule H7a in the
// prompt — Brain must never invent teams/channels/processes that
// don't exist. Observed 2026-05-21 02:39: Brain wrote
// "I am escalating this to the support team..." Pure fabrication.
const FABRICATED_PROCESS_RE =
  /\b(support\s+team|engineering\s+team|the\s+team\s+will|our\s+team\s+will|i'?ll\s+escalate|escalating\s+(this\s+)?to|i'?ll\s+(loop|notify|inform|reach\s+out\s+to)\s+(the\s+)?(team|engineers?|support|admin)|i'?ll\s+follow\s+up\s+with\s+(engineering|support|the\s+team))/i;

// Raw JSON envelope leaks — when the LLM's output escaped parseCompose
// truncation fallback and reached the user as e.g.
//   {"answer":"...","cites":["..."],"...
const RAW_JSON_LEAK_RE =
  /^\s*\{\s*["']answer["']\s*:/m;

// Raw LLM provider error string leak — historically Brain
// interpolated `err.message` from the LLM router into prose, exposing
// provider names ("gemini[try1]", "claude[try1]"), model error codes
// ("Budget 0 is invalid"), and Anthropic billing copy.
const PROVIDER_ERROR_LEAK_RE =
  /\b(gemini\[try\d+\]|claude\[try\d+\]|gemini-flash\[try\d+\]|All\s+LLM\s+providers\s+failed|Anthropic\s+API|Your\s+credit\s+balance|Budget\s+\d+\s+is\s+invalid)/i;

// "I sent / I scheduled / I done" — FIRST-PERSON claim of completing
// the pending. Previously this regex matched any verb anywhere,
// including legitimate third-person calendar descriptions ("you have
// a meeting scheduled tomorrow"). Observed 2026-05-25: user asked
// "do I have any meeting tomorrow?" and the answer "you have a
// meeting scheduled at 11am" got rewritten to "[Preview not yet
// confirmed]" because "scheduled" matched and there was a stale
// pending. Tightened to require an "I" pronoun before the verb.
const DONE_CLAIM_RE =
  /\b(?:i'?ve|i\s+have|i'?ll|i'?m|i\s+just|i\s+already|i)\s+(?:sent|scheduled|delivered|completed|done|dispatched|invited|notified|cancelled|rescheduled|updated)\b/i;

// ──────────────────────────────────────────────────────────────────
// STYLE RULES (Phase B of the Communication Contract, 2026-05-22).
// Per user: "the way you talk to me, i want my brain to do the same".
// These are WARN-severity — logged so we can tune, optionally
// rewritten via the suggested replacement. Style is softer than
// safety: a reply that hedges is annoying; a reply that lies is
// dangerous. The block-vs-warn distinction matters.
// ──────────────────────────────────────────────────────────────────

// Fake-enthusiasm openers. Detection is at line start (^) after
// optional whitespace so we don't false-positive mid-sentence.
const FAKE_ENTHUSIASM_RE =
  /^\s*(great question|sure thing|sure!|of course[, ]|of course sir|absolutely[!,]|i'?d be happy to|i'?d love to|amazing|excellent|fantastic|wonderful|happy to help|no problem at all)\b/i;

// Vague-filler — promises action without a specific timeline / artifact.
const VAGUE_FILLER_RE =
  /\b(let me look into (that|this|it)|i'?ll see what i can do|i'?ll check on (that|this|it)|i'?ll get back to you|i'?ll figure it out|i'?ll get on (that|it)|i'?ll do my best|i'?ll try (to|my best))\b(?!.*\b(now|today|tomorrow|in \d|by \d|\d ?(min|hour|day))\b)/i;

// Over-hedging — three or more hedge words in close proximity.
// Counted across the whole answer; threshold 3+.
const HEDGE_WORDS_RE =
  /\b(might|maybe|perhaps|possibly|could|seems|seem|likely|probably|i think|i believe|i guess|i suppose|appears|appear|fairly|somewhat|kind of|sort of|might possibly|probably maybe)\b/gi;

/** Run all checks against a composed result. Returns the outcome
 *  with violations sorted by severity (block first). Caller acts on
 *  the first block-severity violation if any.
 *
 *  Optional `context` carries pending-state info so the validator can
 *  check preview_vs_done_confusion (Brain saying "done" while the
 *  pending is still preview_shown). */
export function validateBeforeRender(
  result: ComposeResult,
  context?: {
    pendingStatus?: string | null;
    /**
     * DEF-114 — what the USER asked for this turn.
     *
     * The composer already gates the empty-promise guard on this and gets it
     * right; the log line reads "empty-promise regex matched on non-action
     * turn, leaving prose unchanged". This validator never saw the question,
     * so it judged the answer alone — and an apology is textually identical to
     * a fabricated claim. On 2026-08-10 that cost the owner four blocked
     * replies in ninety minutes, including "My apologies, Sir. That was my
     * mistake. You provided all the necessary details."
     *
     * Passing the intent here is judging the STATE of the turn, which is what
     * DEF-041 requires; it is NOT the path-shaped exemption DEF-041 removed.
     * Undefined means "unknown", and unknown still blocks — fail closed.
     */
    turnIntent?: 'read_only' | 'mutation' | 'ambiguous';
  },
): ValidationOutcome {
  const violations: ResponseViolation[] = [];
  const answer = result.answer ?? '';

  // 1. EMPTY PROMISE — completion claim without successful action.
  //
  // The original false-positive this guard had to avoid is real and still
  // avoided: on 2026-05-22 reasoning emitted a valid clarifying question
  // ("Which Yousaf should I delegate to?") and the regex overwrote it with a
  // generic empty-promise message. Phrases like "should I delegate" belong in
  // questions and preview templates and are NOT completion claims.
  //
  // What changed on 2026-08-05 (DEF-041) is HOW that is avoided. It used to be
  // avoided by exempting the whole reasoning code path; it is now avoided by
  // looking at the state of the turn — a structured state (clarification,
  // preview, decline, schema violation) or a successful dispatch. See below.
  // ── DEF-041 (2026-08-05) — this rule was switched OFF on the live path ──
  //
  // It used to read:
  //     const emptyPromiseEligible = !sourceIsReasoning && !hasStructuredState;
  // which disabled the empty-promise rule for EVERY reasoning-sourced answer —
  // and reasoning has been the default path since `f8ff5a1`. At 14:07 on
  // 2026-08-05 Brain said "I will delegate all four unassigned items to Hamna
  // Latif Bhutta now", delegated nothing, and then emailed Hamna from the
  // owner's own address stating the items HAD been delegated. The rule that
  // exists to catch precisely that was reached, and skipped.
  //
  // The exemption was added for a real reason: reasoning emits previews,
  // clarifying questions and templated act-answers that legitimately contain
  // "delegate"-class verbs, and regex-gating those produced false blocks.
  // But every one of those cases is already covered WITHOUT consulting the
  // code path:
  //     preview / clarification / decline → hasStructuredState (below)
  //     a real dispatch                   → actionResult.ok === true (below)
  // The path check was therefore redundant with the two conditions on either
  // side of it, and the redundancy is what let a fabricated promise reach a
  // real person.
  //
  // RULE: judge the STATE of the turn, never the code path that produced it.
  // A path-shaped exemption silently widens every time a new path is added.
  const structuredStates = new Set([
    'clarification_needed', 'preview_required', 'declined',
    'empty_promise_blocked', 'malformed_action',
  ]);
  // Prefix-matched markers: these carry a detail suffix (`plan_invalid: …`).
  // All of them already render as bracketed system markers, never as prose
  // claiming work was done, so exempting them cannot hide a fabrication.
  const structuredPrefixes = ['schema_violation', 'plan_invalid', 'plan_persist_failed'];
  const hasStructuredState =
    !!result.actionResult &&
    typeof result.actionResult.message === 'string' &&
    (
      structuredStates.has(result.actionResult.message) ||
      structuredPrefixes.some((p) => result.actionResult!.message.startsWith(p))
    );
  // DEF-107 — a standing rule described is not a claim made. "If a deadline is
  // approaching, I'll remind you" answers a capability question; it asserts
  // nothing was done, so it cannot be a fabricated completion claim. Blocked
  // twice on 2026-08-10 inside nine minutes, both times replacing a correct
  // answer with the canned denial. See isConditionalFutureBehaviour for why
  // this is judged per SENTENCE rather than by the turn's action state — the
  // latter would rebuild the path-shaped exemption DEF-041 removed.
  // Kept on ONE line deliberately: DEF-041's regression guard matches this
  // assignment with a single-line regex, and wrapping it hid `hasStructuredState`
  // from the very test that exists to stop that exemption being weakened.
  // DEF-114 — a read-only turn had nothing to dispatch, so a completion-shaped
  // sentence on it cannot be a fabricated CURRENT-TURN claim. The composer
  // already applies exactly this gate ("leaving prose unchanged"); this
  // validator was blind to it and overruled the composer three seconds later.
  //
  // 'mutation' and 'ambiguous' still block. DEF-041's incident — "I will
  // delegate all four unassigned items to Hamna Latif Bhutta now" — was a
  // mutation turn, so it stays caught. Undefined blocks too: a caller that
  // cannot say what the user asked for gets the strict behaviour.
  const readOnlyTurn = context?.turnIntent === 'read_only';
  const emptyPromiseEligible = !hasStructuredState && !isConditionalFutureBehaviour(answer) && !readOnlyTurn;
  if (
    emptyPromiseEligible &&
    EMPTY_PROMISE_RE.test(answer) &&
    (!result.actionResult || result.actionResult.ok !== true)
  ) {
    violations.push({
      rule: 'empty_promise',
      severity: 'block',
      description: 'Answer claims completion ("I sent/scheduled/delegated/cancelled...") but no action was successfully dispatched this turn.',
      // Bracketed system marker per no-hardcoded-fake-Brain-replies rule.
      // Previous text was an English sentence masquerading as Brain prose
      // ("I didn't actually complete that..."), which violated the rule
      // and read as robotic to the user (Basit, 2026-05-22).
      suggestedReplacement: `[no action dispatched — retry with the action and target named explicitly]`,
    });
  }

  // 2. FABRICATED PROCESS — references teams/channels/escalation
  //    paths that don't exist in the system.
  if (FABRICATED_PROCESS_RE.test(answer)) {
    violations.push({
      rule: 'fabricated_process',
      severity: 'block',
      description: 'Answer references a "support team" / "engineering team" / escalation channel that does not exist.',
      // Bracketed marker (no-hardcoded-fake-Brain-replies rule).
      suggestedReplacement: `[fabricated escalation path — that team/channel doesn't exist in the system; name the concrete task]`,
    });
  }

  // 3. RAW JSON ENVELOPE LEAK.
  if (RAW_JSON_LEAK_RE.test(answer)) {
    violations.push({
      rule: 'raw_json_leak',
      severity: 'block',
      description: 'Answer starts with the raw {"answer":...} JSON envelope — parseCompose fell through.',
      suggestedReplacement: `[Brain output malformed — retry, or check logs]`,
    });
  }

  // 4. PROVIDER ERROR STRING LEAK.
  if (PROVIDER_ERROR_LEAK_RE.test(answer)) {
    violations.push({
      rule: 'provider_error_leak',
      severity: 'block',
      description: 'Answer includes raw LLM provider error text (provider names, model error codes, billing strings).',
      suggestedReplacement: `[Brain unavailable — reasoning service down, retry shortly]`,
    });
  }

  // 5. RECIPIENT MISMATCH — action says to=[X] but answer says
  //    "I'll send to Y" with Y not in the action's identifier list.
  //    Catches the worst sin in outbound: telling the user a different
  //    recipient than what's actually being dispatched. We compare
  //    name tokens in the answer against the action's identifiers.
  if (result.action && result.actionResult?.ok === true) {
    const action: any = result.action;
    const actionIdentifiers = collectActionIdentifiers(action);
    // Pull "to X" / "with X" / "for X" mentions from answer.
    // Targets: name tokens of length ≥3 starting with uppercase.
    const mentionRe = /\b(?:to|with|for|cc|inviting)\s+([A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]+){0,2})\b/g;
    const mentionedNames = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = mentionRe.exec(answer)) !== null) {
      mentionedNames.add(m[1].toLowerCase());
    }
    // Each mentioned name must appear in at least one identifier (the
    // action's email/phone string usually contains the name as the
    // local part, OR the action's displayName field matches).
    for (const mentioned of mentionedNames) {
      const inIdentifiers = actionIdentifiers.some((id) => id.includes(mentioned) || id.includes(mentioned.replace(/\s+/g, '.')));
      if (!inIdentifiers) {
        violations.push({
          rule: 'recipient_mismatch',
          severity: 'block',
          description: `Answer mentions recipient "${mentioned}" but the action dispatches to ${actionIdentifiers.join(', ')} — these don't match.`,
          suggestedReplacement: `[Action dispatched but the prose mentioned a different recipient. Please re-issue the request clearly.]`,
        });
        break;
      }
    }
  }

  // 6. PREVIEW vs DONE CONFUSION — pending is preview_shown but
  //    answer claims FIRST-PERSON completion ("I sent", "I scheduled").
  //    The user hasn't confirmed yet; Brain shouldn't say it did it.
  //
  //    Skip when source='reasoning' — reasoning's structured outputs
  //    (questions, factual answers about calendar state, declines)
  //    aren't done-claims even if they contain phrases like "you have
  //    a meeting scheduled". The DONE_CLAIM_RE now requires "I" prefix
  //    but reasoning is double-belt-and-braces trusted here.
  const sourceIsReasoningForPreview = result.source === 'reasoning';
  if (
    !sourceIsReasoningForPreview &&
    context?.pendingStatus === 'preview_shown' &&
    DONE_CLAIM_RE.test(answer)
  ) {
    violations.push({
      rule: 'preview_vs_done_confusion',
      severity: 'block',
      description: 'Pending action is still preview_shown but answer uses first-person completion language.',
      suggestedReplacement: `[Preview not yet confirmed. Reply "send" to dispatch, or tell me what to change.]`,
    });
  }

  // ── STYLE RULES (Phase B Communication Contract) ────────────────
  // All warn-severity. Logged + optionally rewritten. Style is softer
  // than safety; we don't block a reply that hedges, only flag it.

  // 7. FAKE ENTHUSIASM — opens with banned phrase.
  if (FAKE_ENTHUSIASM_RE.test(answer)) {
    const stripped = answer.replace(FAKE_ENTHUSIASM_RE, '').trimStart()
      // After removing the opener, often a comma/space remains — clean up.
      .replace(/^[,.;:!?\s]+/, '');
    violations.push({
      rule: 'style_fake_enthusiasm',
      severity: 'warn',
      description: 'Answer opens with banned fake-enthusiasm phrase (e.g., "Great question!", "Sure!", "Absolutely!").',
      suggestedReplacement: stripped.length > 10 ? stripped : answer,
    });
  }

  // Phase 9 (2026-05-22): the three style rules below — vague_filler,
  // over_hedging, no_next_move — were post-hoc regex checks for
  // style compliance. With the persona-level communication contract
  // (Phase A/2) + reasoning-first composer (Phase 6), the LLM should
  // produce compliant output upstream. These remain as DIAGNOSTIC
  // TELEMETRY ONLY: log when they fire so we can measure how often
  // the upstream layers fail to enforce style; do NOT add a
  // violation (which would surface in the caller's response).
  //
  // If observation over time shows these patterns still appear, the
  // fix is to strengthen the persona block or examples — not to
  // re-enable post-hoc rewrites. The whole refactor's point is
  // "Brain reasons its way to good output", not "regex catches bad
  // output after the fact".

  if (VAGUE_FILLER_RE.test(answer)) {
    console.info('[style] vague_filler detected (diagnostic only)', {
      head: answer.slice(0, 120),
    });
  }

  const hedgeMatches = answer.match(HEDGE_WORDS_RE);
  if (hedgeMatches && hedgeMatches.length >= 3) {
    console.info('[style] over_hedging detected (diagnostic only)', {
      count: hedgeMatches.length,
      unique: Array.from(new Set(hedgeMatches.map((s) => s.toLowerCase()))).slice(0, 5),
    });
  }

  if (
    answer.length > 200 &&
    !/\?\s*$/.test(answer.trim()) &&
    !/\b(want me to|shall i|should i|next step|next move|let me know|tell me|reply ["'])/i.test(answer)
  ) {
    console.info('[style] no_next_move detected (diagnostic only)', {
      head: answer.slice(0, 120),
    });
  }

  // Sort blocks first, warns second.
  violations.sort((a, b) => (a.severity === 'block' && b.severity !== 'block' ? -1 : 1));
  const firstBlock = violations.find((v) => v.severity === 'block');
  return {
    ok: !firstBlock,
    violations,
    replacement: firstBlock?.suggestedReplacement,
  };
}

/** Collect every identifier (email / phone) from an action's slots
 *  for recipient-mismatch checking. Returns lowercased strings. */
function collectActionIdentifiers(action: any): string[] {
  const out: string[] = [];
  if (!action || typeof action !== 'object') return out;
  if (Array.isArray(action.to)) out.push(...action.to);
  if (Array.isArray(action.cc)) out.push(...action.cc);
  if (Array.isArray(action.attendeeEmails)) out.push(...action.attendeeEmails);
  if (Array.isArray(action.attendeeNames)) out.push(...action.attendeeNames);
  if (typeof action.delegateeEmail === 'string') out.push(action.delegateeEmail);
  if (typeof action.delegateeName === 'string') out.push(action.delegateeName);
  if (typeof action.recipientPhone === 'string') out.push(action.recipientPhone);
  if (typeof action.recipientName === 'string') out.push(action.recipientName);
  return out.map((s) => String(s).toLowerCase());
}
