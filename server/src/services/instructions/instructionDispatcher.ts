/**
 * Voice / text instruction dispatcher.
 *
 * Takes an ExtractedInstruction (from instructionExtractor) and executes
 * the action against the existing services. Returns an outcome string
 * suitable for the WhatsApp confirmation reply.
 *
 * Handlers reuse the same services that the manual UI flows call —
 * muted_senders.upsert, gmailService.sendUserEmail, openItemsService.
 * delegateItem, calendarService.createEvent — so the audit trail and
 * downstream effects (Brief logging, decision_log writes) are
 * identical to a UI-driven action.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import type { ExtractedInstruction } from './instructionExtractor';

const log = createLogger('instruction-dispatch');

export interface DispatchResult {
  ok: boolean;
  message: string;
  /** Optional id of whatever Brain created (open_item, agent_action, etc.). */
  artifactId?: string;
  warnings?: string[];
}

export async function dispatchInstruction(args: {
  instruction: ExtractedInstruction;
  clientNumber: string;
  userId: number;
}): Promise<DispatchResult> {
  const { instruction, clientNumber, userId } = args;
  const ix = instruction;

  switch (ix.intent) {
    // ─── mute / unmute ───────────────────────────────────────────
    case 'mute_sender': {
      const id = ix.params.senderIdentifier;
      const channel = ix.params.senderChannel ?? 'email';
      if (!id) return { ok: false, message: 'I couldn\'t pick out which sender you meant. Try "mute john@x.com" or paste the address.' };
      const normalised = channel === 'email'
        ? id.toLowerCase().replace(/<|>/g, '')
        : channel === 'whatsapp'
        ? id.replace(/[^\d+]/g, '')
        : id;
      try {
        await prisma.mutedSender.upsert({
          where: { userId_channel_identifier: { userId, channel, identifier: normalised } } as any,
          create: { clientNumber, userId, channel, identifier: normalised, reason: 'Voice instruction' } as any,
          update: { reason: 'Voice instruction' } as any,
        });
        return { ok: true, message: `Muted ${id}. Future ${channel} from them won't appear in My Attention.` };
      } catch (err: any) {
        return { ok: false, message: `Mute failed: ${err.message}` };
      }
    }

    case 'unmute_sender': {
      const id = ix.params.senderIdentifier;
      const channel = ix.params.senderChannel ?? 'email';
      if (!id) return { ok: false, message: 'I couldn\'t pick out which sender to unmute.' };
      const normalised = channel === 'email'
        ? id.toLowerCase().replace(/<|>/g, '')
        : channel === 'whatsapp'
        ? id.replace(/[^\d+]/g, '')
        : id;
      try {
        await prisma.mutedSender.deleteMany({
          where: { userId, channel, identifier: normalised } as any,
        });
        return { ok: true, message: `Unmuted ${id}. Their messages will surface again.` };
      } catch (err: any) {
        return { ok: false, message: `Unmute failed: ${err.message}` };
      }
    }

    // ─── set_window ──────────────────────────────────────────────
    case 'set_window': {
      try {
        const { updateUserPreferences } = await import('../userPreferencesService');
        const next = await updateUserPreferences(userId, {
          ...(ix.params.attentionWindowDays ? { attentionWindowDays: ix.params.attentionWindowDays } : {}),
          ...(ix.params.briefWindowDays ? { briefWindowDays: ix.params.briefWindowDays } : {}),
        });
        return { ok: true, message: `Window updated. My Attention now covers ${next.attentionWindowDays}d, Brief ${next.briefWindowDays}d.` };
      } catch (err: any) {
        return { ok: false, message: `Window update failed: ${err.message}` };
      }
    }

    // ─── draft_reply ─────────────────────────────────────────────
    case 'draft_reply': {
      if (!ix.targetFeedEventId) return { ok: false, message: 'I need to know which message you want me to reply to. Mention the sender or subject in your instruction.' };
      const replyIntent = ix.params.replyIntent ?? '';
      try {
        // No sourceType filter — accept any feed_event so voice
        // dictation works on Gmail, WhatsApp, Google Chat, etc.
        const fe = await prisma.feedEvent.findFirst({
          where: { id: ix.targetFeedEventId, clientNumber, userId },
          select: { sourceType: true, sourceId: true, senderEmail: true, senderName: true, senderPhone: true, rawPayload: true },
        });
        if (!fe) return { ok: false, message: 'Couldn\'t find that message in your recent feed.' };
        const payload: any = fe.rawPayload ?? {};
        const subject = String(payload.subject ?? '');
        const senderLabel = fe.senderName ?? fe.senderEmail ?? fe.senderPhone ?? 'them';

        // Channel-specific handling.
        if (fe.sourceType === 'gmail') {
          const recipient = fe.senderEmail ?? '';
          if (!recipient) return { ok: false, message: 'No sender email on that thread — can\'t draft a reply.' };
          const { composeForwardNote } = await import('../knowledge/toneService');
          const polished = await composeForwardNote({
            userId,
            delegateeName: fe.senderName ?? undefined,
            originalSender: payload.from ?? recipient,
            originalSubject: subject,
            originalSnippet: String(payload.snippet ?? ''),
            mdNote: replyIntent,
          });
          const action = await prisma.agentAction.create({
            data: {
              clientNumber, userId,
              actionType: 'draft_reply',
              status: 'pending_approval',
              requiresApproval: true,
              executedByAgent: 'voice_instruction',
              input: { feedEventId: ix.targetFeedEventId, replyIntent } as any,
              output: { to: recipient, subject: `Re: ${subject}`, body: polished, channel: 'email' } as any,
            } as any,
          });
          return {
            ok: true,
            artifactId: String(action.id),
            message: `Drafted email reply to ${senderLabel}. Open Day Brief to review and Send.`,
          };
        }

        if (fe.sourceType === 'whatsapp' || fe.sourceType === 'gchat') {
          // WhatsApp / Chat replies don't go through Gmail. Use the
          // tone-matched WA composer (mirrors what the manual reply
          // flow on a chat card uses) so the message reads in the
          // user's voice in the chat itself.
          const chatId = payload.chatId ?? null;
          if (fe.sourceType === 'whatsapp' && !chatId) {
            return { ok: false, message: 'No chat reference on that WhatsApp message — can\'t draft a reply.' };
          }
          const { composeWhatsAppReply } = await import('../knowledge/toneService').catch(() => ({} as any));
          let polished = replyIntent || 'Thanks.';
          if (typeof composeWhatsAppReply === 'function') {
            try {
              polished = await composeWhatsAppReply({
                userId, chatId,
                inboundText: String(payload.body ?? payload.snippet ?? ''),
                mdNote: replyIntent,
              });
            } catch { /* fall back to replyIntent */ }
          }
          const action = await prisma.agentAction.create({
            data: {
              clientNumber, userId,
              actionType: 'draft_reply',
              status: 'pending_approval',
              requiresApproval: true,
              executedByAgent: 'voice_instruction',
              input: { feedEventId: ix.targetFeedEventId, replyIntent } as any,
              output: { to: chatId, subject: '', body: polished, channel: fe.sourceType } as any,
            } as any,
          });
          return {
            ok: true,
            artifactId: String(action.id),
            message: `Drafted ${fe.sourceType === 'whatsapp' ? 'WhatsApp' : 'Chat'} reply to ${senderLabel}. Open Day Brief to review and Send.`,
          };
        }

        // Calendar / Tasks don't have a "reply" semantic — bail clearly.
        return {
          ok: false,
          message: `${fe.sourceType} items don\'t have a "reply" action. Try delegate, schedule, or add to open items instead.`,
        };
      } catch (err: any) {
        return { ok: false, message: `Draft reply failed: ${err.message}` };
      }
    }

    // ─── delegate ────────────────────────────────────────────────
    case 'delegate': {
      if (!ix.targetFeedEventId) return { ok: false, message: 'Tell me which email you want delegated and I\'ll forward it.' };
      const delegateeName = ix.params.delegateeName ?? null;
      const delegateeEmail = ix.params.delegateeEmail ?? null;
      const note = ix.params.delegateeNote ?? null;
      if (!delegateeName && !delegateeEmail) return { ok: false, message: 'Who should I delegate to? Say a name or email.' };

      try {
        // If we don't have an email, look up via the same delegatee
        // resolver the picker uses.
        let resolvedEmail = delegateeEmail;
        if (!resolvedEmail && delegateeName) {
          const u = await prisma.user.findFirst({
            where: { clientNumber, name: { contains: delegateeName, mode: 'insensitive' } } as any,
            select: { email: true, integrationEmail: true },
          });
          resolvedEmail = (u?.integrationEmail ?? u?.email) ?? null;
        }
        if (!resolvedEmail) return { ok: false, message: `Couldn\'t resolve an email for ${delegateeName}. Try saying their email directly.` };

        const fe = await prisma.feedEvent.findFirst({
          where: { id: ix.targetFeedEventId, clientNumber, userId, sourceType: 'gmail' },
          select: { senderEmail: true, senderName: true, rawPayload: true },
        });
        if (!fe) return { ok: false, message: 'That email isn\'t in your recent feed.' };
        const payload: any = fe.rawPayload ?? {};
        const subject = String(payload.subject ?? '');

        // Reuse composeForwardNote so the delegatee email reads in the
        // user's voice with the verbatim instruction baked in.
        const { composeForwardNote } = await import('../knowledge/toneService');
        const userRow = await prisma.user.findFirst({ where: { id: userId }, select: { name: true } });
        const cover = await composeForwardNote({
          userId,
          userName: userRow?.name ?? undefined,
          delegateeName: delegateeName ?? undefined,
          originalSender: payload.from ?? fe.senderEmail ?? '',
          originalSubject: subject,
          originalSnippet: String(payload.snippet ?? '').slice(0, 800),
          mdNote: note ?? undefined,
        });

        const { sendUserEmail } = await import('../gmailService');
        const r = await sendUserEmail(
          userId,
          resolvedEmail,
          `Fwd: ${subject}`,
          cover,
          undefined,
        );
        if (!r.success) return { ok: false, message: `Forward failed: ${r.error}` };

        // Create open_item + delegationLog, mirroring the /brief/decide
        // delegate path so audit history is consistent.
        const op = await prisma.openItem.create({
          data: {
            title: subject || 'Voice-delegated task',
            description: [
              `Delegated by voice instruction to ${delegateeName ?? resolvedEmail}.`,
              note ? `Instruction: ${note}` : '',
              `Original from: ${payload.from ?? fe.senderEmail ?? '(unknown)'}`,
            ].filter(Boolean).join('\n'),
            type: 'email',
            status: 'DELEGATED',
            priority: 'medium',
            ownerId: userId,
            delegateeName: delegateeName ?? null,
            delegateeEmail: resolvedEmail,
            sourceFeed: 'gmail',
            sourceRef: ix.targetFeedEventId,
            clientNumber,
            userId,
            sourceFeedEventId: ix.targetFeedEventId,
            archetype: 'delegate',
            delegationTrail: [{
              from: 'voice_instruction',
              at: new Date().toISOString(),
              note: note ?? null,
            }],
          } as any,
          select: { id: true },
        });
        return {
          ok: true,
          artifactId: op.id,
          message: `Forwarded to ${delegateeName ?? resolvedEmail}${note ? ` with your instruction` : ''}. Tracking as an open item.`,
        };
      } catch (err: any) {
        return { ok: false, message: `Delegate failed: ${err.message}` };
      }
    }

    // ─── schedule_meeting ────────────────────────────────────────
    case 'schedule_meeting': {
      const title = ix.params.meetingTitle ?? 'Discussion';
      const whenText = ix.params.meetingWhen ?? '';
      const duration = ix.params.meetingDurationMin ?? 30;
      const attendees = ix.params.meetingAttendees ?? [];
      try {
        // Calendar event creation lives in calendarService — call it
        // through the existing helper. We pass natural-language `when`
        // and let that service parse / fall back to a reasonable slot.
        const { createCalendarEvent } = await import('../calendarService').catch(() => ({} as any));
        if (typeof createCalendarEvent !== 'function') {
          // Calendar create not yet wired — log a draft so user can act manually.
          await prisma.agentAction.create({
            data: {
              clientNumber, userId,
              actionType: 'meeting_draft',
              status: 'pending_approval',
              requiresApproval: true,
              executedByAgent: 'voice_instruction',
              input: { title, whenText, duration, attendees, sourceFeedEventId: ix.targetFeedEventId } as any,
              output: { note: 'Calendar create not yet wired — review on Day Brief and create manually.' } as any,
            } as any,
          });
          return {
            ok: true,
            message: `I\'ll create a meeting "${title}" for ${whenText}${attendees.length ? ` with ${attendees.join(', ')}` : ''}. Calendar create isn\'t fully wired yet — staged for your review on Day Brief.`,
            warnings: ['calendar-create-stub'],
          };
        }
        const ev = await createCalendarEvent({
          userId, clientNumber, title, whenText, durationMin: duration, attendees,
        });
        return {
          ok: true,
          artifactId: ev?.id,
          message: `Meeting "${title}" set for ${ev?.start ?? whenText}${attendees.length ? ` with ${attendees.join(', ')}` : ''}.`,
        };
      } catch (err: any) {
        return { ok: false, message: `Schedule failed: ${err.message}` };
      }
    }

    // ─── add_open_item ───────────────────────────────────────────
    case 'add_open_item': {
      const title = ix.params.itemTitle ?? 'Voice note follow-up';
      const note = ix.params.itemNote ?? '';
      try {
        const op = await prisma.openItem.create({
          data: {
            title, description: note,
            type: 'manual',
            status: 'NEW',
            priority: 'medium',
            ownerId: userId,
            clientNumber, userId,
            sourceFeed: 'voice',
            sourceFeedEventId: ix.targetFeedEventId ?? null,
          } as any,
          select: { id: true },
        });
        return { ok: true, artifactId: op.id, message: `Added "${title}" to your open items.` };
      } catch (err: any) {
        return { ok: false, message: `Add open item failed: ${err.message}` };
      }
    }

    case 'none':
    default:
      return { ok: false, message: '' }; // caller should suppress
  }
}
