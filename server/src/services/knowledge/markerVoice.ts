/**
 * Render an internal system marker in Brain's own voice.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────
 * Owner, 2026-08-07: *"i don't want robotic answers if i talk to brain neither
 * anyone else talk to brain"*, with the objective *"smart thinking of brain like
 * living assistant"*.
 *
 * There are 102 bracketed markers in this codebase — `[cancelled]`,
 * `[completion recorded and item closed]`, `[delegate failed: …]`. They exist
 * for a good reason: an honest machine signal is better than a model inventing
 * prose about what it did. That ruling stands.
 *
 * What went wrong is the LAST MILE. `answerSanitizer` maps 25 of those 102 to
 * FIXED English sentences and STRIPS the other 77. So Brain either recites one
 * of two dozen canned lines or says nothing at all. Both read as a machine:
 * the first because it is literally the same sentence every time, the second
 * because the user watches their request vanish.
 *
 * And the canned lines are themselves the thing the owner banned — *"no
 * hardcoded fake-Brain replies. Every Brain-surface reply is LLM-generated or a
 * bracketed system marker."* A lookup table of hand-written Brain sentences is
 * neither.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────────
 * Keep the marker as the internal signal. Change only how it reaches a human:
 * the marker plus its context goes to the LLM, which says the same fact in
 * Brain's voice. Same truth, different sentence every time, in the user's
 * language.
 *
 * The hard constraint is that this must not become a fabrication surface. The
 * marker is the ONLY source of fact — the renderer may rephrase it and must
 * never add to it. `[delegate failed: no email]` may become "I couldn't send
 * that to her — I don't have an email address for her." It may never become
 * "I'll try again shortly", because nothing is going to try again.
 */

import { callLLM } from '../llmRouter';
import createLogger from '../../utils/logger';

const log = createLogger('marker-voice');

export interface MarkerVoiceContext {
  /** Tenant + user scoping, carried into spend accounting. */
  clientNumber?: string;
  userId?: number;
  /**
   * Who is going to read this. Brain speaks to its owner as an assistant, and
   * to a counterpart as the owner's assistant — never as the owner
   * (`SendProvenance`). Getting this wrong is a bigger error than sounding
   * stiff.
   */
  audience?: 'owner' | 'counterpart';
  /** The user's own words this turn, so the reply can match their language. */
  userMessage?: string;
}

const SYSTEM = `You are Brain, a personal assistant. You are rewriting ONE internal status marker into a single natural sentence you would actually say.

ABSOLUTE RULES — these override any instinct to be helpful:
1. The marker is your ONLY source of fact. Say what it says. Never add an action, a promise, a reason, a name, a number or a next step that is not in the marker.
2. If the marker says something failed, say it failed. Do not soften it into "there was a small issue" and do not invent a cause.
3. Never promise future action ("I'll retry", "I'll follow up") unless the marker states it.
4. No apologising twice, no filler, no "As an AI". Do not mention markers, systems, code, or that you were given anything to rewrite.
5. One or two sentences. Speak the way a competent human assistant speaks to the person they work for.
6. Match the language of the user's message when one is given — English to English, Urdu to Urdu, Roman Urdu to Roman Urdu.
7. YOUR OWN WORDS. The marker is the FACT, never the phrasing. Do not copy its sentence back — say the same thing the way you would say it to this person about the thing they just asked for, and refer to what they actually asked for rather than "that".

Return ONLY the sentence. No quotes, no brackets, no preamble.`;

/** How much of the marker's own phrasing came back. 1 = a verbatim echo.
 *
 *  Owner, 2026-08-19: "don't use any template string, always respond through model."
 *
 *  The model WAS being called on this path — and returned the curated sentence
 *  byte-for-byte 19 times out of 21, because it was handed a finished sentence and told
 *  "say what it says". A model that echoes is a template with a bill attached, and it is
 *  indistinguishable from one on the owner's screen, which is exactly how he described it:
 *  "the way brain respond to me, feels like not through LLM".
 *
 *  Word-level rather than character-level, so a reply that keeps the facts but rebuilds the
 *  sentence scores low while a copy with a comma moved still scores high. */
export function contentWords(t: string): number {
  return t.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter((w) => w.length > 2).length;
}

export function echoRatio(source: string, out: string): number {
  const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2);
  const a = words(source);
  const b = words(out);
  if (!a.length || !b.length) return 0;
  const bag = new Map<string, number>();
  for (const w of b) bag.set(w, (bag.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of a) {
    const have = bag.get(w) ?? 0;
    if (have > 0) { shared += 1; bag.set(w, have - 1); }
  }
  return shared / a.length;
}

/**
 * The unreachable-config fallback, in the DEF-082 sense: a literal that exists
 * only for when the real path cannot run. It is deliberately vague because a
 * specific hand-written sentence here is exactly the hardcoded fake-Brain reply
 * this file removes — and vague-but-honest beats confident-and-wrong.
 *
 * Note what it does NOT do: it never returns empty. Stripping a marker to
 * silence is what made 77 of them feel like Brain ignoring the user.
 */
function lastResort(marker: string): string {
  const inner = marker.replace(/^\s*\[|\]\s*$/g, '').trim();
  return inner ? `${inner.charAt(0).toUpperCase()}${inner.slice(1)}.` : 'Something went wrong on my end.';
}

/**
 * Render one marker. Never throws, never returns empty.
 *
 * Callers should treat a returned string as final user-facing text. The LLM
 * timeout is deliberately short: a status line that arrives late is worse than
 * one phrased plainly, and this sits on the reply path.
 */
export async function renderMarkerInBrainVoice(
  marker: string,
  ctx: MarkerVoiceContext = {},
): Promise<string> {
  const trimmed = (marker ?? '').trim();
  if (!trimmed) return '';

  const audience = ctx.audience ?? 'owner';
  const user = [
    `Internal marker: ${trimmed}`,
    audience === 'counterpart'
      ? 'Audience: someone your owner asked you to contact. You are their assistant, not them.'
      : 'Audience: your owner.',
    ctx.userMessage ? `They just said: ${ctx.userMessage.slice(0, 300)}` : '',
  ].filter(Boolean).join('\n');

  try {
    const r = await callLLM(SYSTEM, user, {
      clientNumber: ctx.clientNumber,
      userId: ctx.userId,
      purpose: 'marker_voice',
      maxTokens: 120,
      timeoutMs: 6000,
    });
    const text = (r?.text ?? '').trim().replace(/^["'`]|["'`]$/g, '');

    // Guard the two ways this can fail while looking successful: an empty
    // return, and a model that echoes the marker back in brackets rather than
    // rewriting it.
    if (!text || /^\s*\[/.test(text)) return lastResort(trimmed);
    // AN ECHO IS NOT AN ANSWER. One retry with the instruction sharpened, because the first
    // pass reproduced the input verbatim 19 times in 14 days on this exact path.
    // Only for sentences long enough that rephrasing MEANS something. "Got it — noted." has
    // two content words: any reply that acknowledges at all scores 1.0, so the echo test
    // fires on every acknowledgement and buys a second call for a phrase that has no other
    // sensible form. Eight content words is where the curated failure sentences start.
    if (contentWords(trimmed) >= 8 && echoRatio(trimmed, text) >= 0.85) {
      try {
        const r2 = await callLLM(
          `${SYSTEM}\n\nYour previous attempt copied the marker's wording almost exactly. That`
          + ` is a failure. Rebuild the sentence from scratch: same fact, your own`
          + ` construction, naming what they actually asked about.`,
          user, {
            clientNumber: ctx.clientNumber,
            userId: ctx.userId,
            purpose: 'marker_voice_retry',
            maxTokens: 120,
            timeoutMs: 6000,
          },
        );
        const t2 = (r2?.text ?? '').trim().replace(/^["'`]|["'`]$/g, '');
        // Accept the retry only if it is BOTH non-empty and less of a copy. A second echo
        // is kept rather than discarded: the fact is still true, and silence or a vague
        // fallback would be worse than a plainly-worded truth.
        if (t2 && !/^\s*\[/.test(t2) && echoRatio(trimmed, t2) < echoRatio(trimmed, text)) {
          return t2;
        }
      } catch {
        // Fall through to the first attempt — it is honest, just unimaginative.
      }
    }
    return text;
  } catch (err) {
    // A judgement path degrading to a fallback is itself worth a finding
    // (DEF-086 is exactly this class going unnoticed), but the reply must still
    // go out — so log, fall back, never throw.
    log.warn('marker voice failed, using last-resort phrasing', {
      err: err instanceof Error ? err.message : String(err),
      marker: trimmed.slice(0, 60),
    });
    return lastResort(trimmed);
  }
}
