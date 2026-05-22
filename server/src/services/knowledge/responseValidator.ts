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

// Same regex used by the inline empty-promise guard (Sprint 1+). Kept
// in sync there for compatibility; this validator is the canonical
// definition going forward.
const EMPTY_PROMISE_RE =
  /\b(?:i'?ve|i\s+have|i'?ll|i'?m|i\s+just|i\s+already|i)\s+(?:delegated|delegating|delegate|assigned|assigning|assign|added|adding|add|scheduled|scheduling|schedule|sent|sending|send|reminded|reminding|remind|set|setting|drafted|drafting|draft|dispatched|dispatching|dispatch|emailed|emailing|email|forwarded|forwarding|forward|replied|replying|reply|cancelled|canceled|cancelling|canceling|cancel|rescheduled|rescheduling|reschedule|corrected|correcting|correct|updated|updating|update|fixed|fixing|fix|removed|removing|remove|deleted|deleting|delete|moved|moving|move|changed|changing|change)\b|\bdone\s+—|\b(?:kar\s+diya|kar\s+di\s+hai|ho\s+gaya|ho\s+gai)\b/i;

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

// "I sent / scheduled / done" claim while pending is still
// preview_shown (i.e., user hasn't confirmed). Brain shouldn't say
// "done" before the action actually dispatches.
const DONE_CLAIM_RE =
  /\b(sent|scheduled|delivered|completed|done|dispatched|invited|notified|cancelled|rescheduled|updated)\b/i;

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
  context?: { pendingStatus?: string | null },
): ValidationOutcome {
  const violations: ResponseViolation[] = [];
  const answer = result.answer ?? '';

  // 1. EMPTY PROMISE — completion claim without successful action.
  //
  // Skip this check when the turn was decided by reasoning. Reasoning
  // emits structured output — its answer text is either a clarifying
  // question, a preview template, a templated decline, or an
  // act-fallback string. Phrases like "I delegate" or "should I
  // schedule" can legitimately appear in those (e.g. "Which Yousaf
  // should I delegate to?") and they are NOT hallucinated completion
  // claims. Observed 2026-05-22: reasoning emitted a perfectly valid
  // ask question for yousaf-delegate clarification; this regex
  // overwrote it with the generic empty-promise message. The regex
  // was tuned for the legacy LLM's free-form prose, not reasoning's
  // structured output — gate accordingly.
  //
  // Additional skip: actionResult.message ∈ structured states from
  // reasoning or inline guards (clarification_needed, preview_required,
  // schema_violation, declined, empty_promise_blocked). These are
  // honest "no action attempted / preview shown" signals, not empty
  // promises.
  const sourceIsReasoning = result.source === 'reasoning';
  const structuredStates = new Set([
    'clarification_needed', 'preview_required', 'declined',
    'empty_promise_blocked', 'malformed_action',
  ]);
  const hasStructuredState =
    !!result.actionResult &&
    typeof result.actionResult.message === 'string' &&
    (
      structuredStates.has(result.actionResult.message) ||
      result.actionResult.message.startsWith('schema_violation')
    );
  const emptyPromiseEligible = !sourceIsReasoning && !hasStructuredState;
  if (
    emptyPromiseEligible &&
    EMPTY_PROMISE_RE.test(answer) &&
    (!result.actionResult || result.actionResult.ok !== true)
  ) {
    violations.push({
      rule: 'empty_promise',
      severity: 'block',
      description: 'Answer claims completion ("I sent/scheduled/delegated/cancelled...") but no action was successfully dispatched this turn.',
      suggestedReplacement: `I didn't actually complete that — no action went through on my side. Tell me which item and which person and I'll act on it now.`,
    });
  }

  // 2. FABRICATED PROCESS — references teams/channels/escalation
  //    paths that don't exist in the system.
  if (FABRICATED_PROCESS_RE.test(answer)) {
    violations.push({
      rule: 'fabricated_process',
      severity: 'block',
      description: 'Answer references a "support team" / "engineering team" / escalation channel that does not exist.',
      suggestedReplacement: `I don't have a way to do that directly. Tell me what you'd like, and I'll handle whichever piece I can.`,
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
  //    answer claims completion. The user hasn't confirmed yet; Brain
  //    shouldn't say "scheduled" / "sent" / "done".
  if (context?.pendingStatus === 'preview_shown' && DONE_CLAIM_RE.test(answer)) {
    violations.push({
      rule: 'preview_vs_done_confusion',
      severity: 'block',
      description: 'Pending action is still preview_shown but answer uses completion language ("sent", "scheduled", "done").',
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
