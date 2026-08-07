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

Return ONLY the sentence. No quotes, no brackets, no preamble.`;

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
