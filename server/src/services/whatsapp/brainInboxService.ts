/**
 * DEF-305 / CL-052 — Brain's own inbox: record everything, decide what matters, route it right.
 *
 * OWNER RULING, 2026-09-03, verbatim:
 *
 *   "since brain knows his own number so the message sent to this number is the message for
 *    brain (not for user), brain will analyze and see to whom it is relevant to notify or not,
 *    brain will decide what to do with messages receiving, if something really important to
 *    notify user then do (but brain should know to which user he should notify)"
 *
 * This REVERSES the standing Section 35 behaviour (owner ruling 2026-08-04), under which every
 * message from an allowed sender was relayed to the tenant owner unconditionally, worded as
 * "X messaged YOU on WhatsApp". Both halves of that were wrong under the new ruling: the message
 * was sent to Brain, not to him, and it should not go out unless it matters.
 *
 * THE TENSION THIS HAS TO SURVIVE, and it is his own. On the SAME DAY he said:
 *
 *   "i also often see that someone has sent messaged to brain but it didnt notify"
 *
 * So "fewer notifications" must not become "missed messages". Three properties keep both true:
 *
 *   1. RECORDING IS UNCONDITIONAL and happens before any decision. Whatever Brain decides, the
 *      message is in `brain_inbox_messages` and "who messaged you" stays answerable. Without
 *      this, selective notification would delete the record along with the notification and
 *      recreate DEF-270 — a defect he reported and which was fixed by reading the relay log.
 *   2. THE DECISION IS STORED, not just acted on. `relevant_user_id`, `relevance_reason`,
 *      `notify_decision` and `notify_reason` make every withheld message explainable later.
 *      Otherwise "brain will decide" becomes "brain silently dropped it" — the shape of DEF-060,
 *      where real people messaged, the owner was never told, and the only trace was a log line.
 *   3. EVERY FAILURE FAILS TOWARD NOTIFYING. If routing throws, if scoring throws, if the model
 *      is unavailable — the message goes out. An undecided message is not a withheld one.
 *
 * WHY IT REUSES `scoreCriticality` RATHER THAN JUDGING FOR ITSELF. That engine already takes
 * `itemType: 'whatsapp'` and already produces exactly the field this ruling needs — `substantive`,
 * documented in place as "Brain's binary judgment on whether this message warrants a push to the
 * user RIGHT NOW", with `substantiveWhy` for audit. A second importance judgement here would be
 * `protection-with-two-implementations`, which this codebase has recorded ten times.
 *
 * HONEST LIMIT ON THE ROUTING, stated because the code would otherwise imply more than it does:
 * this tenant has exactly ONE active user today (id 2, SA; id 3 is inactive). So "which user"
 * currently has one possible answer nearly always, and the signal-based routing below is correct
 * but barely exercised. It is written from real signals rather than hardcoded because he asked
 * for the distinction and because the second active user is a configuration change away — not
 * because it is doing clever work today.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { looksLikeLidDigits } from './waIdentity';

const log = createLogger('brain-inbox');

export type NotifyDecision =
  | 'pending'
  | 'notified'
  | 'withheld_not_substantive'
  | 'withheld_no_user'
  | 'withheld_ignored_sender'
  | 'asked_owner'
  | 'notify_failed';

export interface RecordedInbound {
  id: string;
}

/**
 * Record a message that arrived on Brain's own number. ALWAYS. Before any decision.
 *
 * Never throws: an inbound must not be lost because the audit write failed, and a message that
 * reaches Brain but not this table is invisible to every later question about it. Returns null
 * when the write failed, and the caller carries on — the notification path does not depend on
 * this succeeding.
 *
 * `sender_phone` is left NULL for an @lid sender rather than filled with the synthetic
 * `'+' + lid-digits`, because the owner has ruled twice that value must never appear anywhere
 * owner-facing (DEF-293, DEF-298) and a column called `sender_phone` is exactly where a future
 * reader would trust it as a number.
 */
export async function recordInboundToBrain(params: {
  clientNumber: string;
  rawSenderId?: string | null;
  senderPhone?: string | null;
  senderName?: string | null;
  body: string;
  waMessageId?: string | null;
}): Promise<RecordedInbound | null> {
  const phone = params.senderPhone && !looksLikeLidDigits(params.senderPhone)
    ? params.senderPhone
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: bigint }>>(
      `INSERT INTO brain_inbox_messages
         (client_number, raw_sender_id, sender_phone, sender_name, body, wa_message_id)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text)
       RETURNING id`,
      params.clientNumber,
      params.rawSenderId ?? null,
      phone,
      params.senderName ?? null,
      params.body,
      params.waMessageId ?? null,
    );
    const id = rows[0]?.id;
    return id === undefined || id === null ? null : { id: String(id) };
  } catch (error: any) {
    log.error('inbox record FAILED — this message is now invisible to later questions', {
      error: String(error?.message ?? error).slice(0, 200),
    });
    return null;
  }
}

/** Store what Brain decided, so a withheld message can be explained later. */
export async function recordDecision(params: {
  id: string | null;
  relevantUserId?: number | null;
  relevanceReason?: string | null;
  decision: NotifyDecision;
  notifyReason?: string | null;
}): Promise<void> {
  if (!params.id) return;
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE brain_inbox_messages
          SET relevant_user_id = $2::int,
              relevance_reason = $3::text,
              notify_decision  = $4::text,
              notify_reason    = $5::text,
              notified_at      = CASE WHEN $4::text = 'notified' THEN NOW() ELSE notified_at END
        WHERE id = $1::bigint`,
      params.id,
      params.relevantUserId ?? null,
      params.relevanceReason ?? null,
      params.decision,
      params.notifyReason ?? null,
    );
  } catch (error: any) {
    // The decision was already acted on by the time this runs; a failed audit write must not
    // undo it or throw into the messaging path.
    log.warn('inbox decision write failed', {
      id: params.id, decision: params.decision,
      error: String(error?.message ?? error).slice(0, 140),
    });
  }
}

export interface Relevance {
  userId: number | null;
  reason: string;
}

/**
 * WHICH user does this message concern?
 *
 * Signals, in order of how strongly they attribute. Each is a real relationship recorded in the
 * database, never an inference from the message text — a routing decision that can be moved by
 * what a stranger writes is a routing decision a stranger controls.
 *
 *   1. the sender is a contact belonging to a user
 *   2. the sender is named on an open item belonging to a user
 *   3. exactly one active user exists in the tenant — today this is the answer nearly always,
 *      and saying so in `reason` keeps the audit honest about how little work was done
 *
 * Returns `{ userId: null }` when nothing attributes it. That is a fact about the message, and
 * the caller treats it as "record, do not notify" rather than as an error.
 */
export async function resolveRelevantUser(params: {
  clientNumber: string;
  senderPhone?: string | null;
  rawSenderId?: string | null;
}): Promise<Relevance> {
  const digits = String(params.senderPhone ?? '').replace(/[^0-9]/g, '');

  try {
    if (digits.length >= 7) {
      // 1. A contact of theirs. Matched on the last 9 digits so a country-code or formatting
      //    difference does not lose the match — the same tail comparison DEF-292 settled on.
      const tail = digits.slice(-9);
      const contact = await prisma.$queryRawUnsafe<Array<{ userId: number; title: string }>>(
        `SELECT user_id AS "userId", title
           FROM wiki_pages
          WHERE client_number = $1 AND page_type = 'entity_person'
            AND right(regexp_replace(coalesce(metadata->>'phone',''), '[^0-9]', '', 'g'), 9) = $2
            AND length(regexp_replace(coalesce(metadata->>'phone',''), '[^0-9]', '', 'g')) >= 7
          LIMIT 1`,
        params.clientNumber, tail,
      );
      if (contact[0]?.userId) {
        return {
          userId: Number(contact[0].userId),
          reason: `sender is a contact of this user (${contact[0].title})`,
        };
      }

      // 2. Named on one of their open items, joined through the ENTITY rather than a phone
      //    column. `open_items` has no phone field at all — my first version of this query
      //    filtered on `counterpart_phone`, which does not exist, and the `.catch()` around it
      //    would have turned a 42703 into a silent "no match" forever. That is the same
      //    silent-no-op shape as DEF-276. The real path is entities.phone -> open_items.entity_id,
      //    and every query in this function was then run against the live database before
      //    shipping.
      const item = await prisma.$queryRawUnsafe<Array<{ userId: number; title: string }>>(
        `SELECT oi.user_id AS "userId", oi.title
           FROM open_items oi
           JOIN entities e ON e.id = oi.entity_id
          WHERE oi.client_number = $1
            AND oi.status NOT IN ('CLOSED','CANCELLED')
            AND right(regexp_replace(coalesce(e.phone,''), '[^0-9]', '', 'g'), 9) = $2
            AND length(regexp_replace(coalesce(e.phone,''), '[^0-9]', '', 'g')) >= 7
          ORDER BY oi.updated_at DESC NULLS LAST
          LIMIT 1`,
        params.clientNumber, tail,
      );
      if (item[0]?.userId) {
        return {
          userId: Number(item[0].userId),
          reason: `sender appears on this user's open item "${item[0].title}"`,
        };
      }
    }

    // 3. One active user, so there is only one place this could go.
    const actives = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
      `SELECT id FROM users
        WHERE client_number = $1 AND is_active = TRUE AND user_type IN ('SA','AD')
        ORDER BY user_type, id`,
      params.clientNumber,
    );
    if (actives.length === 1) {
      return {
        userId: Number(actives[0].id),
        reason: 'the only active user in this tenant — not an attribution, just the only option',
      };
    }

    return {
      userId: null,
      reason: actives.length === 0
        ? 'no active user in this tenant'
        : 'more than one active user and nothing ties this sender to any of them',
    };
  } catch (error: any) {
    // FAIL TOWARD A RECIPIENT. An unroutable message that gets recorded and never surfaces is
    // the missed-notification defect he reported; falling back to the tenant owner is worse
    // than nothing only in the sense of being noisy, and noise is recoverable.
    log.warn('relevance routing failed — falling back to the tenant owner', {
      error: String(error?.message ?? error).slice(0, 140),
    });
    const owner = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
      `SELECT id FROM users
        WHERE client_number = $1 AND is_active = TRUE AND user_type IN ('SA','AD')
        ORDER BY user_type, id LIMIT 1`,
      params.clientNumber,
    ).catch(() => [] as any[]);
    return {
      userId: owner[0]?.id ? Number(owner[0].id) : null,
      reason: 'routing failed; fell back to the tenant owner rather than withholding',
    };
  }
}

export interface Substance {
  substantive: boolean;
  why: string;
}

/**
 * Is this worth interrupting a person for?
 *
 * Delegates to `scoreCriticality`, which already answers exactly this question for WhatsApp
 * items and calls it `substantive`. Nothing here re-judges it.
 *
 * FAILS TOWARD NOTIFYING, and this is the single most important line in the module. If the
 * engine throws, times out, or the model is unavailable, the message goes out. "Brain decides"
 * cannot be allowed to mean "Brain went quiet when the scorer broke" — that is precisely how
 * DEF-060 lost five days of real messages behind one swallowed exception.
 */
export async function decideSubstantive(params: {
  clientNumber: string;
  userId: number;
  senderLabel: string;
  senderPhone?: string | null;
  body: string;
  receivedAt?: Date;
}): Promise<Substance> {
  try {
    const { scoreCriticality } = await import('../triage/criticalityEngineService');
    const result = await scoreCriticality({
      clientNumber: params.clientNumber,
      userId: params.userId,
      itemType: 'whatsapp',
      sourceType: 'whatsapp',
      from: params.senderLabel,
      fromEmail: null,
      subject: params.body.slice(0, 80),
      preview: params.body.slice(0, 500),
      receivedAt: params.receivedAt ?? new Date(),
    });
    return {
      substantive: result.substantive !== false,
      why: result.substantiveWhy || `band=${result.band}`,
    };
  } catch (error: any) {
    log.warn('substance scoring failed — notifying, because undecided is not withheld', {
      error: String(error?.message ?? error).slice(0, 140),
    });
    return { substantive: true, why: 'could not judge importance, so passing it on' };
  }
}

/**
 * What Brain has actually received on its own number, for the reasoning context.
 *
 * Reads the RECORD rather than the notification log, which is the whole point of the table: a
 * message Brain decided not to forward is still a message it received, and "did anybody message
 * you" must include it. The previous block read `brain_user_messages`, i.e. what Brain had SENT
 * about the message, so a withheld message would have vanished from its own memory.
 */
export async function recentInboxForContext(params: {
  clientNumber: string;
  hours?: number;
  limit?: number;
}): Promise<Array<{
  receivedAt: Date;
  /**
   * The transport's own id. Returned for COUNTING DISTINCT SENDERS ONLY and never for display:
   * for an @lid sender it is the value the owner has twice ruled useless to him.
   *
   * It is here because the first version of the block counted distinct senders from name-or-phone,
   * and every backfilled row has neither — so it rendered "17 messages from 0 distinct senders".
   * A false zero is worse than no count, and DEF-295 is the row about exactly that: the block
   * must state how many PEOPLE, not leave the model to infer it.
   */
  rawSenderId: string | null;
  senderName: string | null;
  senderPhone: string | null;
  body: string;
  decision: string;
  notifyReason: string | null;
  relevantUserId: number | null;
}>> {
  const hours = params.hours ?? 24;
  const limit = params.limit ?? 40;
  try {
    return await prisma.$queryRawUnsafe(
      `SELECT received_at AS "receivedAt", raw_sender_id AS "rawSenderId",
              sender_name AS "senderName", sender_phone AS "senderPhone", body,
              notify_decision AS "decision", notify_reason AS "notifyReason",
              relevant_user_id AS "relevantUserId"
         FROM brain_inbox_messages
        WHERE client_number = $1::text
          AND received_at >= NOW() - ($2::int * INTERVAL '1 hour')
        ORDER BY received_at DESC
        LIMIT $3::int`,
      params.clientNumber, hours, limit,
    );
  } catch (error: any) {
    log.warn('inbox read for context failed', {
      error: String(error?.message ?? error).slice(0, 140),
    });
    return [];
  }
}
