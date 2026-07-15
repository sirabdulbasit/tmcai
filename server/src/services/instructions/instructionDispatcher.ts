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

/** Normalize a possibly-naive ISO datetime to include an explicit
 *  timezone offset. If the input already carries Z or +HH:MM, return
 *  as-is. If it's naive (e.g. "2026-05-22T11:00"), append the offset
 *  and ensure seconds are present.
 *
 *  Critical for Google Calendar correctness: passing a naive datetime
 *  through `new Date()` reinterprets it as UTC. The dispatcher must
 *  pre-attach the user's local offset BEFORE that conversion so the
 *  emitted UTC ISO matches the user's intent.
 *
 *  The offset is resolved per-user (DST-aware, as of the meeting
 *  date) by the caller and passed in. */
function normalizeWhenIsoToLocalTz(whenIso: string, fixedOffset: string): string {
  if (!whenIso || typeof whenIso !== 'string') return whenIso;
  // Already has offset / Z suffix — trust it.
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(whenIso)) return whenIso;
  // Add seconds if missing: "2026-05-22T11:00" → "2026-05-22T11:00:00"
  let s = whenIso;
  if (/T\d{2}:\d{2}$/.test(s)) s = s + ':00';
  return s + fixedOffset;
}

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
              // Stamp toName so the Brief row reads "Replied to {name}"
              // instead of the raw chatId. senderLabel is already
              // computed above from senderName/senderEmail/senderPhone.
              output: {
                to: chatId, subject: '', body: polished,
                channel: fe.sourceType,
                toName: senderLabel,
              } as any,
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

        // B5 (2026-07-08): route through the registry executor instead of
        // calling gmailService directly. This path previously sent a REAL
        // email with no AgentAction row — no executor-owned status, no
        // confirm() read-back, no undo, no audit trail. Now the send gets
        // the full validate→execute→confirm pipeline.
        const { executeViaRegistry } = await import('../actions/executeViaRegistry');
        const r = await executeViaRegistry({
          actionType: 'send_email',
          clientNumber,
          userId,
          executedByAgent: 'voice_instruction',
          payload: { to: [resolvedEmail], subject: `Fwd: ${subject}`, body: cover },
          disambiguator: `delegate:${ix.targetFeedEventId}:${resolvedEmail}`,
        });
        if (!r.ok) return { ok: false, message: `Forward failed: ${r.error ?? 'send could not be confirmed'}` };

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
      const whenIso = ix.params.meetingWhen ?? '';
      const duration = Math.max(1, Number(ix.params.meetingDurationMin ?? 30));
      const attendeesRaw = ix.params.meetingAttendees ?? [];
      // The composer passes a mixed array of emails + names. We can only
      // send invites to emails — filter to addresses with an "@".
      const attendees = (attendeesRaw as string[]).filter((a) => typeof a === 'string' && a.includes('@'));

      try {
        // brainComposer emits whenIso as "YYYY-MM-DDTHH:MM" intended to
        // mean the USER's local time. The previous version passed that
        // through `new Date(whenIso).toISOString()` — which parses naive
        // ISO as UTC and re-emits with the Z suffix. Then calendarService
        // passes `timeZone: 'Asia/Karachi'` alongside, but the Z-suffixed
        // dateTime overrides — Google Calendar uses the fixed UTC time
        // and ignores the timeZone field for interpretation.
        //
        // Net effect observed 2026-05-21 02:24 PKT: Basit asked for
        // "tomorrow 11am", LLM emitted "2026-05-21T11:00", dispatcher
        // converted to "2026-05-21T11:00:00.000Z", Google read it as
        // 11:00 UTC = 16:00 PKT. User got a 4 PM invite instead of 11 AM.
        //
        // Fix: ALWAYS normalize whenIso to include an explicit timezone
        // offset derived from the USER's tz (not a hardcoded +05:00).
        // Sprint 4A (2026-05-21): swapped to per-user lookup so users
        // outside Pakistan get correct local times.
        const { getUserTimezoneOffset, getTimezoneOffset, systemDefaultTimezone } = await import('../userTimezoneService');
        // Offset as of the MEETING date, not today — a meeting across a
        // DST boundary (e.g. New York in November) shifts offsets.
        const meetingDate = /^\d{4}-\d{2}-\d{2}/.test(whenIso) ? new Date(`${whenIso.slice(0, 10)}T12:00:00Z`) : new Date();
        const userOffset = await getUserTimezoneOffset(userId, meetingDate)
          .catch(() => getTimezoneOffset(systemDefaultTimezone(), meetingDate));
        const normalizedWhenIso = normalizeWhenIsoToLocalTz(whenIso, userOffset);
        const startDate = new Date(normalizedWhenIso);
        if (Number.isNaN(startDate.getTime())) {
          return { ok: false, message: `Schedule failed: I couldn't parse the time "${whenIso}". Tell me the date and time clearly (e.g. "tomorrow 3pm" or "2026-05-21 15:00").` };
        }
        const endDate = new Date(startDate.getTime() + duration * 60_000);

        // B5 (2026-07-08): route through the registry executor (create_event
        // handler) instead of calling calendarService directly. The direct
        // call created a REAL calendar event with no AgentAction row — no
        // executor-owned status, no confirm() read-back (provider re-list of
        // the booked window), no undo. History note kept: an earlier version
        // imported a non-existent `createCalendarEvent` and silently claimed
        // success while the calendar stayed untouched (observed 2026-05-20) —
        // exactly the class of lie the confirm() pipeline now catches.
        const { executeViaRegistry } = await import('../actions/executeViaRegistry');
        const r = await executeViaRegistry({
          actionType: 'create_event',
          clientNumber,
          userId,
          executedByAgent: 'voice_instruction',
          payload: {
            summary: title,
            startTime: startDate.toISOString(),
            endTime: endDate.toISOString(),
            attendees,
          },
          disambiguator: `schedule:${title}:${startDate.toISOString()}`,
        });

        if (!r.ok) {
          return { ok: false, message: `Schedule failed: ${r.error ?? 'event could not be confirmed on Google Calendar'}` };
        }

        const out = (r.output ?? {}) as { eventId?: string };
        return {
          ok: true,
          artifactId: out.eventId ?? String(r.actionId),
          message: `Meeting "${title}" scheduled for ${startDate.toISOString()}${attendees.length ? ` with ${attendees.join(', ')}` : ''}.${attendees.length ? ' Invites sent.' : ''}`,
        };
      } catch (err: any) {
        return { ok: false, message: `Schedule failed: ${err.message}` };
      }
    }

    // ─── cancel_meeting ──────────────────────────────────────────
    case 'cancel_meeting': {
      const eventId = String(ix.params.eventId ?? '').trim();
      const titleHint = String(ix.params.titleHint ?? '').trim();
      const reason = String(ix.params.reason ?? '').trim();
      if (!eventId) {
        return { ok: false, message: `Cancel failed: no eventId provided.` };
      }
      try {
        // B5 (2026-07-08): route through the registry executor (cancel_event
        // handler — confirm() verifies the event is actually gone/cancelled
        // on the provider) instead of calling calendarService directly.
        const { executeViaRegistry } = await import('../actions/executeViaRegistry');
        const r = await executeViaRegistry({
          actionType: 'cancel_event',
          clientNumber,
          userId,
          executedByAgent: 'voice_instruction',
          payload: { eventId, reason: reason || undefined },
          disambiguator: `cancel:${eventId}`,
        });
        if (!r.ok) {
          return { ok: false, message: `Cancel failed: ${r.error ?? 'cancellation could not be confirmed'}` };
        }
        const titleBit = titleHint ? ` "${titleHint}"` : '';
        const reasonBit = reason ? ` (${reason})` : '';
        return {
          ok: true,
          artifactId: eventId,
          message: `Cancelled meeting${titleBit}.${reasonBit} Attendees notified.`,
        };
      } catch (err: any) {
        return { ok: false, message: `Cancel failed: ${err.message}` };
      }
    }

    // ─── reschedule_meeting ──────────────────────────────────────
    case 'reschedule_meeting': {
      const eventId = String(ix.params.eventId ?? '').trim();
      const titleHint = String(ix.params.titleHint ?? '').trim();
      const newWhenIso = String(ix.params.newWhenIso ?? '').trim();
      const newDurationMin = Number(ix.params.newDurationMin ?? 0);
      const reason = String(ix.params.reason ?? '').trim();
      if (!eventId) {
        return { ok: false, message: `Reschedule failed: no eventId provided.` };
      }
      if (!newWhenIso && !newDurationMin) {
        return { ok: false, message: `Reschedule failed: provide a new time or new duration.` };
      }
      try {
        const patch: { startTime?: string; endTime?: string } = {};
        if (newWhenIso) {
          const { getUserTimezoneOffset } = await import('../userTimezoneService');
          const userOffset = await getUserTimezoneOffset(userId).catch(() => '+05:00');
          const normalizedNewIso = normalizeWhenIsoToLocalTz(newWhenIso, userOffset);
          const startDate = new Date(normalizedNewIso);
          if (Number.isNaN(startDate.getTime())) {
            return { ok: false, message: `Reschedule failed: couldn't parse new time "${newWhenIso}".` };
          }
          patch.startTime = startDate.toISOString();
          // If duration wasn't specified, default to 30 min from start
          const duration = newDurationMin > 0 ? newDurationMin : 30;
          patch.endTime = new Date(startDate.getTime() + duration * 60_000).toISOString();
        } else if (newDurationMin) {
          // Only changing duration — need to fetch current start to compute end.
          // Skipping this branch for now; treat duration-only as needing
          // a new time too. Return helpful error.
          return { ok: false, message: `Reschedule failed: please tell me the new time as well as the duration change.` };
        }
        // B5 exception LIFTED (2026-07-09): reschedule_event's execute()
        // is real now (F1 gap-fill), so voice reschedule routes through the
        // registry executor like schedule/cancel — AgentAction audit row,
        // provider read-back confirm(), undo with previousStart.
        const { executeViaRegistry } = await import('../actions/executeViaRegistry');
        const r = await executeViaRegistry({
          actionType: 'reschedule_event',
          clientNumber,
          userId,
          executedByAgent: 'voice_instruction',
          payload: { eventId, newStartTime: patch.startTime!, newEndTime: patch.endTime! },
          disambiguator: `reschedule:${eventId}:${patch.startTime}`,
        });
        if (!r.ok) {
          return { ok: false, message: `Reschedule failed: ${r.error ?? 'move could not be confirmed on Google Calendar'}` };
        }
        const titleBit = titleHint ? ` "${titleHint}"` : '';
        const reasonBit = reason ? ` (${reason})` : '';
        return {
          ok: true,
          artifactId: eventId,
          message: `Rescheduled meeting${titleBit} to ${patch.startTime}.${reasonBit} Attendees notified.`,
        };
      } catch (err: any) {
        return { ok: false, message: `Reschedule failed: ${err.message}` };
      }
    }

    // ─── add_open_item ───────────────────────────────────────────
    case 'add_open_item': {
      const title = ix.params.itemTitle ?? 'Follow-up';
      const note = ix.params.itemNote ?? '';
      let dueDate: Date | null = null;
      if (ix.params.itemDueDate) {
        const parsed = new Date(ix.params.itemDueDate);
        if (!Number.isNaN(parsed.getTime())) dueDate = parsed;
      }

      // Hygiene-level dedup. Per user 2026-05-13: "why brain is creating
      // duplicate records?? similarly it is creating duplication in open
      // items". This block was previously reverted as "hardcoded
      // judgement" — but the user clarified the distinction: hygiene
      // ≠ judgement.
      //
      //   Judgement (LLM owns): is "Revisit Phoenix pricing" the same
      //     TASK as "follow up on Phoenix"? Different strings, possibly
      //     same intent. The LLM has the open-items snapshot in its
      //     prompt and is instructed to detect paraphrased matches
      //     before emitting add_open_item.
      //
      //   Hygiene (DB owns): two rows with LITERALLY IDENTICAL titles
      //     should never coexist. That's data integrity, not a decision
      //     about meaning. If the user (or Brain) tries to add an item
      //     whose title is byte-equal to an existing active one, return
      //     the existing id instead of creating a duplicate row.
      //
      // The check is intentionally narrow (case-insensitive exact
      // match on this user's active items only). Paraphrase detection
      // remains the LLM's responsibility via the composer prompt.
      try {
        const existing = await prisma.openItem.findFirst({
          where: {
            clientNumber, userId,
            ownerId: userId,
            status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'DELEGATED', 'WAITING_INFO', 'SNOOZED'] },
            title: { equals: title, mode: 'insensitive' as any },
          },
          select: { id: true, title: true, status: true, dueDate: true },
          orderBy: { createdAt: 'desc' },
        });
        if (existing) {
          // If the caller specified a dueDate and the existing row has
          // none, update the existing row's dueDate (treat the duplicate
          // call as "set due date on existing X"). Otherwise just
          // return the existing row's id with a "already exists" note.
          if (dueDate && !existing.dueDate) {
            await prisma.openItem.update({
              where: { id: existing.id },
              data: { dueDate } as any,
            }).catch(() => null);
            return {
              ok: true,
              artifactId: existing.id,
              message: `"${existing.title}" already on your list — set due date to ${dueDate.toISOString().slice(0, 10)}.`,
            };
          }
          return {
            ok: true,
            artifactId: existing.id,
            message: `You already have "${existing.title}" on your list (${existing.status.toLowerCase()}). I kept the existing one — want me to follow up on it or update it?`,
          };
        }
      } catch { /* fall through to create */ }

      // ─── Substring-containment dedup ────────────────────────────
      // Catches the wrapper-vs-inner pattern that exact-match misses:
      //   existing: "Revisit pricing for Phoenix Systems" (manual)
      //   new:      "add 'revisit pricing for Phoenix Systems' as an open item"
      //             (extracted from user's own outbound saying "I'll add this")
      // Same intent, different framing. Per user 2026-05-14: this exact
      // pair was visible side-by-side in Action Center.
      //
      // Rule: if NEW title's normalised text contains an existing active
      // item's normalised title (or vice versa) for THIS user, treat as
      // duplicate. Normalisation strips quotes, the "add ... as an open
      // item" wrapper, and case differences. Length floor (>= 6 chars
      // after normalisation) avoids matching trivial substrings like "ok".
      //
      // This is hygiene-level pattern recognition, not LLM judgement —
      // the wrapper is a known structural artefact of commitment
      // extraction reading the user's own self-referential outbound.
      // Real semantic paraphrase dedup ("revisit Phoenix pricing" vs
      // "follow up on Phoenix") still belongs to the LLM via the
      // composer prompt.
      try {
        const normalize = (s: string) => s
          .toLowerCase()
          .replace(/^(add|please add|note|please note|track|create an open item for|add to open items)\s+/i, '')
          .replace(/\s+as an open item$/i, '')
          .replace(/['"`'']/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        const newNorm = normalize(title);
        if (newNorm.length >= 6) {
          const candidates = await prisma.openItem.findMany({
            where: {
              clientNumber, userId,
              ownerId: userId,
              status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'DELEGATED', 'WAITING_INFO', 'SNOOZED'] },
            },
            select: { id: true, title: true, status: true, dueDate: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 100,
          });
          for (const c of candidates) {
            const existingNorm = normalize(c.title);
            if (existingNorm.length < 6) continue;
            // Containment in either direction = duplicate.
            const isDup = newNorm.includes(existingNorm) || existingNorm.includes(newNorm);
            if (isDup) {
              return {
                ok: true,
                artifactId: c.id,
                message: `That's already on your list as "${c.title}" (${c.status.toLowerCase()}). I didn't add a duplicate — want me to follow up on it or update it?`,
              };
            }
          }
        }
      } catch { /* fall through to create */ }

      // ─── Gate ─────────────────────────────────────────────────────
      // Centralised pre-create checks: Private-contact filter +
      // delegation normalisation + DRAFT routing for missing
      // priority/deadline. See services/openItems/openItemGate.ts.
      const callerPriority = (ix.params as any).priority as ('critical'|'high'|'medium'|'low'|null|undefined);
      const { gateOpenItemCreate } = await import('../openItems/openItemGate');
      const gate = await gateOpenItemCreate({
        clientNumber, userId,
        sourceFeedEventId: ix.targetFeedEventId ?? null,
        title,
        description: note,
        delegateeId: (ix.params as any).delegateeId ?? null,
        delegateeName: (ix.params as any).delegateeName ?? null,
        delegateeEmail: (ix.params as any).delegateeEmail ?? null,
        priority: callerPriority ?? null,
        dueDate,
      });
      if (gate.block) {
        return { ok: false, message: gate.reason ?? 'Open-item creation gated.' };
      }

      try {
        // priority: keep caller value if they provided one; for DRAFT
        // status (slot-filling pending), store null-equivalent via the
        // default 'medium' but mark missingSlots in metadata so the
        // daily ask job knows what to fetch.
        const op = await prisma.openItem.create({
          data: {
            title, description: note,
            type: 'manual',
            status: gate.status,
            priority: callerPriority ?? 'medium',
            ownerId: userId,
            ...(gate.delegateeId  != null ? { delegateeId: gate.delegateeId } : {}),
            ...(gate.delegateeName       ? { delegateeName: gate.delegateeName } : {}),
            ...(gate.delegateeEmail      ? { delegateeEmail: gate.delegateeEmail } : {}),
            clientNumber, userId,
            sourceFeed: ix.targetFeedEventId ? 'brain_chat' : 'manual',
            sourceFeedEventId: ix.targetFeedEventId ?? null,
            ...(dueDate ? { dueDate } : {}),
            ...(gate.status === 'DRAFT' ? {
              metadata: {
                draft: {
                  missingSlots: gate.missingSlots,
                  asksSentCount: 0,
                  firstAskScheduledAt: null,
                  lastAskAt: null,
                },
              } as any,
            } : {}),
          } as any,
          select: { id: true },
        });
        const dueStr = dueDate ? ` (due ${dueDate.toISOString().slice(0, 10)})` : '';
        const delegStr = gate.status === 'DELEGATED' && gate.delegateeName
          ? ` — delegated to ${gate.delegateeName}`
          : '';
        const draftStr = gate.status === 'DRAFT'
          ? ` — parked as DRAFT (missing ${gate.missingSlots.join(' + ')}, I'll ask you on WhatsApp)`
          : '';
        return { ok: true, artifactId: op.id, message: `Added "${title}" to your open items${delegStr}${dueStr}${draftStr}.` };
      } catch (err: any) {
        return { ok: false, message: `Add open item failed: ${err.message}` };
      }
    }

    case 'none':
      return { ok: false, message: '' }; // caller should suppress

    // ── standing_instruction + any unknown non-none intent ─────────────
    // A8 (2026-07-08): instructions that don't match a structured intent
    // used to fall through here with ok:false and empty message — the
    // "acknowledged but not saved" failure mode ("I told it and it
    // agreed, then ignored it"). If the LLM classified the turn as an
    // instruction, we persist it as a free-form ACTIVE instruction
    // (wiki_page pageType='instruction') so it reaches every future
    // prompt via getActiveInstructions, and the ack names it.
    // Never ack without persisting.
    case 'standing_instruction':
    default: {
      const text = String(
        (ix.params as any).instructionText ?? ix.summary ?? '',
      ).trim();
      if (!text) return { ok: false, message: '' };
      try {
        const { createInstructionFromText } = await import('../knowledge/instructionService');
        const created = await createInstructionFromText(clientNumber, userId, text, 'user');
        if (!created) return { ok: false, message: `Couldn't save that instruction — please try again.` };
        const label = ix.summary || created.structured.title;
        log.info('free-form instruction persisted', { userId, intent: ix.intent, id: created.id });
        return { ok: true, artifactId: created.id, message: `Noted: ${label}. I'll apply this going forward.` };
      } catch (err: any) {
        log.warn('free-form instruction persist failed', { error: err.message });
        return { ok: false, message: `Couldn't save that instruction — please try again.` };
      }
    }
  }
}
