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
    // fabricated_completion_on_action_turn — the user requested a
    // mutation, the model CLAIMED it happened, nothing actually ran.
    // Honest wording: no invented dispatch failure, no recipient demand
    // (chat 9 rewording, 2026-07-14) — just the truth plus the offer.
    match: /^\s*\[no action dispatched[^\]]*\]\s*$/i,
    replace: "Hold on — I hadn't actually done that yet; nothing was executed on my end. Say the word and I'll do it now.",
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
  if (!isWholeMarker(answer)) return sanitizeAnswerForUser(answer);

  try {
    const { renderMarkerInBrainVoice } = await import('./markerVoice');
    const curated = curatedMarkerMeaning(answer);
    // When a curated meaning exists, hand THAT to the renderer as the fact —
    // it is a plain-language statement of what happened, already vetted. The
    // renderer's job narrows to saying it naturally.
    const spoken = await renderMarkerInBrainVoice(curated ?? answer.trim(), ctx);
    return spoken || sanitizeAnswerForUser(answer);
  } catch {
    return sanitizeAnswerForUser(answer);
  }
}
