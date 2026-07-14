/**
 * emailBrainChannel — email as a two-way brain conversation (2026-07-14).
 *
 * A0-email finish, v1. WhatsApp and web chat talk to the ONE brain;
 * email was ingest-only — you could not email the brain and get a
 * reply. Now you can:
 *
 *   TRIGGER (deterministic, no LLM guessing about which emails are
 *   "for the brain"): an email the user sends where the SUBJECT
 *   starts with "Nexeo" (case-insensitive, e.g. "Nexeo: what's open
 *   with Yousaf?"). Self-addressed notes-to-self and mails sent to
 *   the brain's alias both match this shape; anything else is normal
 *   correspondence and is never intercepted.
 *
 *   ROUTE: the email body goes through answerAsBrain — the SAME
 *   brain-core WhatsApp and web use (surface-parity rule) — and the
 *   answer goes back as an email reply in the same thread.
 *
 *   SAFETY: only fires when the sender IS the user (their own
 *   connected address) — the brain never auto-replies to third
 *   parties from this hook. Replies are deduped per feed event via
 *   the idempotency service, so re-ingests never double-reply.
 */
import createLogger from '../../utils/logger';

const log = createLogger('email-brain-channel');

const SUBJECT_TRIGGER = /^\s*nexeo\b[:\s-]*/i;

export function isBrainAddressedEmail(payload: { subject?: unknown; from?: unknown }, userEmail: string): boolean {
  const subject = String(payload?.subject ?? '');
  if (!SUBJECT_TRIGGER.test(subject)) return false;
  const from = String(payload?.from ?? '').toLowerCase();
  // Sender must be the user themself (covers "user <a@b>" formats).
  return !!userEmail && from.includes(userEmail.toLowerCase());
}

/** Strip the trigger prefix so the brain sees the actual ask. */
export function extractBrainQuestion(payload: { subject?: unknown; body?: unknown; text?: unknown; snippet?: unknown }): string {
  const subject = String(payload?.subject ?? '').replace(SUBJECT_TRIGGER, '').trim();
  const body = String(payload?.body ?? payload?.text ?? payload?.snippet ?? '').trim();
  // Subject alone can be the whole ask ("Nexeo: chase the EXIM item");
  // body extends it when present.
  return [subject, body].filter(Boolean).join('\n\n').trim();
}

/** Fire-and-forget hook called from feed ingestion for gmail events. */
export async function maybeReplyToBrainEmail(args: {
  clientNumber: string;
  userId: number;
  feedEventId: string;
  payload: Record<string, unknown>;
}): Promise<{ replied: boolean; reason: string }> {
  try {
    const prisma = (await import('../../db/prisma')).default;
    const user = await prisma.user.findFirst({
      where: { id: args.userId, clientNumber: args.clientNumber, isActive: true },
      select: { email: true, integrationEmail: true } as any,
    });
    if (!user) return { replied: false, reason: 'no_user' };
    // The user's sending identity is the CONNECTED Google account
    // (integrationEmail — e.g. .com), not necessarily the login email
    // (.ai). Accept either as "the user emailed the brain".
    const identities = [String((user as any).email ?? ''), String((user as any).integrationEmail ?? '')].filter(Boolean);
    const matched = identities.some((id) => isBrainAddressedEmail(args.payload as any, id));
    if (!matched) return { replied: false, reason: 'not_brain_addressed' };

    const question = extractBrainQuestion(args.payload as any);
    if (!question) return { replied: false, reason: 'empty_question' };

    // Dedup: one reply per feed event, ever — re-ingests and retries
    // must not double-reply. Rides the existing idempotency service.
    const { withIdempotency } = await import('../actionIdempotencyService');
    const result = await withIdempotency(
      {
        actionType: 'BRAIN_SEND_EMAIL' as any,
        clientNumber: args.clientNumber,
        userId: args.userId,
        referenceId: `email-brain-reply:${args.feedEventId}`,
      },
      async () => {
        const { answerAsBrain } = await import('../../routes/brainAskRoutes');
        const r = await answerAsBrain(args.clientNumber, args.userId, question, [], { channel: 'web' });
        const { sendUserEmail } = await import('../gmailService');
        const subject = String((args.payload as any)?.subject ?? 'Nexeo');
        const threadId = typeof (args.payload as any)?.threadId === 'string' ? (args.payload as any).threadId : undefined;
        const messageIdHeader = typeof (args.payload as any)?.messageIdHeader === 'string'
          ? (args.payload as any).messageIdHeader
          : (typeof (args.payload as any)?.messageId === 'string' ? (args.payload as any).messageId : undefined);
        const to = identities[1] || identities[0]!; // reply to the connected mailbox
        const send = await sendUserEmail(
          args.userId, to, subject,
          r.answer.replace(/\n/g, '<br/>'),
          undefined,
          { threadId, inReplyTo: messageIdHeader, references: messageIdHeader },
        );
        if (!send.success || !send.messageId) {
          return { ok: false, error: send.error ?? 'send returned no messageId', output: null };
        }
        return { ok: true, output: { messageId: send.messageId } };
      },
    );
    const ok = (result as any)?.ok === true;
    log.info('brain email reply', { userId: args.userId, feedEventId: args.feedEventId, ok });
    return { replied: ok, reason: ok ? 'replied' : 'send_failed' };
  } catch (e: any) {
    log.warn('brain email reply failed (non-fatal)', { feedEventId: args.feedEventId, error: e?.message });
    return { replied: false, reason: 'error' };
  }
}
