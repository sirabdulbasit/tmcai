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
export function renderOutboundMessage(
  body: string,
  sig: OutboundSignature,
  opts: { firstContact?: boolean } = {},
): string {
  const text = (body ?? '').trim();
  const brain = (sig.brainName ?? '').trim() || 'Nexeo';
  const user = (sig.userName ?? '').trim();

  // Never sign "Assistant" with an empty name — better to omit the line than
  // to send a dangling label.
  const signOff = user ? `${brain}\nAssistant ${user}` : brain;

  // Idempotent: a body that already carries the signature is not re-wrapped.
  // Retries and re-renders must not stack greetings.
  if (text.startsWith(GREETING) && text.includes(signOff)) return text;

  // DEF-049 — introduce ONCE per person, then stop.
  //
  // A real assistant says who they are on first contact and then simply talks.
  // Repeating "this is X, Y's assistant" on every message is what made the old
  // preamble read like a mail merge. The signature below already discloses on
  // every message; this line adds, once, the two things a stranger needs: who
  // is writing, and what happens to what they say back.
  //
  // The reply disclosure is not decoration. People tell machines things they
  // would not tell a person, and everything said here reaches the owner. Not
  // saying so would be a quiet trap.
  const intro = opts.firstContact && user
    ? `${brain} here — I'm ${user}'s assistant. Anything you reply comes straight to ${user}.\n\n`
    : '';

  return `${GREETING}\n${intro}${text}\n\n${signOff}`;
}

/** True when a string already looks like a rendered outbound message. Used by
 *  tone-sampling and reply-parsing so the signature is not mistaken for the
 *  owner's own prose. */
export function looksLikeOutboundTemplate(text: string): boolean {
  return /^\s*Hi,\s*\n/.test(text ?? '') && /\n\s*Assistant .+\s*$/.test(text ?? '');
}

/**
 * Has this person been introduced to before? Recorded on the contact itself so
 * the answer survives restarts, history trimming and channel switches — the
 * same mistake as DEF-037 would be to infer it from the conversation.
 *
 * Fails toward INTRODUCING: if we cannot tell, a stranger gets one extra line
 * of context. The opposite error is messaging someone who has no idea who this
 * is or where their reply goes.
 */
export async function isFirstContactWith(candidateId: string | undefined): Promise<boolean> {
  if (!candidateId) return true;
  try {
    const { default: prisma } = await import('../../db/prisma');
    const row = await prisma.entity.findFirst({
      where: { id: candidateId },
      select: { metadata: true },
    });
    const meta = (row?.metadata ?? {}) as Record<string, unknown>;
    return !meta.introducedAt;
  } catch {
    return true;
  }
}

/** Mark the introduction as done. Never throws — a failure here costs one
 *  repeated intro, which is far cheaper than a failed send. */
export async function markIntroduced(candidateId: string | undefined): Promise<void> {
  if (!candidateId) return;
  try {
    const { default: prisma } = await import('../../db/prisma');
    const row = await prisma.entity.findFirst({
      where: { id: candidateId }, select: { metadata: true },
    });
    if (!row) return;
    const meta = { ...((row.metadata ?? {}) as Record<string, unknown>) };
    if (meta.introducedAt) return;
    meta.introducedAt = new Date().toISOString();
    await prisma.entity.update({ where: { id: candidateId }, data: { metadata: meta as any } });
  } catch { /* one repeated introduction is an acceptable failure mode */ }
}
