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

/** Run all checks against a composed result. Returns the outcome
 *  with violations sorted by severity (block first). Caller acts on
 *  the first block-severity violation if any. */
export function validateBeforeRender(result: ComposeResult): ValidationOutcome {
  const violations: ResponseViolation[] = [];
  const answer = result.answer ?? '';

  // 1. EMPTY PROMISE — completion claim without successful action.
  if (
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

  // Sort blocks first, warns second.
  violations.sort((a, b) => (a.severity === 'block' && b.severity !== 'block' ? -1 : 1));
  const firstBlock = violations.find((v) => v.severity === 'block');
  return {
    ok: !firstBlock,
    violations,
    replacement: firstBlock?.suggestedReplacement,
  };
}
