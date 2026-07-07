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

interface MarkerRule {
  match: RegExp;
  replace: string;
  /** true = replace the WHOLE answer (marker was the entire content).
   *  false = strip just this marker from within a longer answer. */
  whole?: boolean;
}

const MARKERS: MarkerRule[] = [
  {
    match: /^\s*\[no action dispatched[^\]]*\]\s*$/i,
    replace: "Sorry, something didn't dispatch on my end. Could you retry — and if it's a send action, name the recipient explicitly?",
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
];

/**
 * Rewrite bracketed system markers to user-friendly language.
 * Preserves all other content unchanged.
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

  // Otherwise, sanitize any leaked bracketed markers embedded in prose.
  // Only touch things that LOOK like our system markers (all-lowercase
  // action name, ends with `]`, contains a colon or "expired" / "failed"
  // / "dispatched"). Preserves legitimate uses of square brackets.
  let result = answer;
  const embeddedMarker = /\[(?:[a-z_]+\s+(?:preview\s+expired|validation\s+failed|failed:|dispatched)|no action dispatched|cancelled|Action failed:|Brain unavailable|Brain output malformed|fabricated escalation path|LLM returned empty response)[^\]]*\]/g;
  result = result.replace(embeddedMarker, '').replace(/\s{2,}/g, ' ').trim();

  return result || answer;
}
