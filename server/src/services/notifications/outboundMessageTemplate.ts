/**
 * The shape of every message Brain sends to another human.
 *
 * Owner-specified format, 2026-08-05:
 *
 *     Hi,
 *     Sir Basit is asking if you will be coming to the office tomorrow
 *
 *     Suzi
 *     Assistant Basit Ahmed
 *
 * Replaces the old per-channel wording, which had grown three problems the
 * owner named directly:
 *
 *   1. WhatsApp opened with an eleven-word preamble repeating his full name
 *      three times — "Hi Hamna Latif Bhutta, this is Nexeo — Basit Ahmed's AI
 *      assistant. Basit Ahmed asked me to let you know:" — while email used a
 *      completely different footer. Two channels, two voices, neither chosen.
 *   2. The preview described it as a "prefix" for both, which was false for
 *      email. The owner approved one shape and another went out.
 *   3. Nothing was configurable: the assistant's name and the owner's name
 *      were baked into string literals at each send site.
 *
 * ONE implementation, used by every outbound path. Two copies of a message
 * format is how the WhatsApp and email versions diverged in the first place —
 * the same shape that produced DEF-039, DEF-041, DEF-044 and DEF-045 in a
 * single day.
 *
 * Nothing here is hardcoded per user: `brainName` comes from
 * `getBrainDisplayName` (the owner renames it freely — "Suzi" today) and
 * `userName` from the persona record.
 */

export interface OutboundSignature {
  /** The assistant's own name, e.g. "Suzi". Configurable per user. */
  brainName: string;
  /** The owner's name, as counterparts know them, e.g. "Basit Ahmed". */
  userName: string;
}

/** Greeting used for every outbound. Deliberately without the recipient's
 *  name: the old template addressed people by their full formal record name
 *  ("Hi Hamna Latif Bhutta,"), which reads like a mail merge, not an
 *  assistant. */
const GREETING = 'Hi,';

/**
 * Wrap a message body in the owner's signature block.
 *
 * `body` is the substantive text only. When Brain writes ON THE OWNER'S
 * BEHALF the body attributes to him ("Sir Basit is asking whether…"); when
 * Brain writes on its own account the body simply says the thing. The wrapper
 * is identical either way — the counterpart always knows who is writing and
 * for whom, so the distinction lives in the sentence, not in the furniture.
 */
export function renderOutboundMessage(body: string, sig: OutboundSignature): string {
  const text = (body ?? '').trim();
  const brain = (sig.brainName ?? '').trim() || 'Nexeo';
  const user = (sig.userName ?? '').trim();

  // Never sign "Assistant" with an empty name — better to omit the line than
  // to send a dangling label.
  const signOff = user ? `${brain}\nAssistant ${user}` : brain;

  // Idempotent: a body that already carries the signature is not re-wrapped.
  // Retries and re-renders must not stack greetings.
  if (text.startsWith(GREETING) && text.includes(signOff)) return text;

  return `${GREETING}\n${text}\n\n${signOff}`;
}

/** True when a string already looks like a rendered outbound message. Used by
 *  tone-sampling and reply-parsing so the signature is not mistaken for the
 *  owner's own prose. */
export function looksLikeOutboundTemplate(text: string): boolean {
  return /^\s*Hi,\s*\n/.test(text ?? '') && /\n\s*Assistant .+\s*$/.test(text ?? '');
}
