/**
 * MyOS — Delegatee email reply handler.
 *
 * Counterpart to delegateeEmailProducer. Called from the gmail feed
 * ingestion path with each inbound email. Looks up open_items where
 * metadata.deadlineInquiry.threadId matches the inbound message's
 * threadId. If a match is found AND the inbound is FROM the delegatee
 * (not from someone else on the thread), parse the body for a date,
 * update dueDate, and notify the user via the prompt queue.
 *
 * Best-effort: failures here never break feed ingestion. The producer
 * keeps the metadata flag set even if reply parsing fails — the user
 * still sees the item as "inquiry sent" and can manually set the date.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { parseDuePhrase } from './promptReplyHandler';
import { enqueueBrainPrompt } from './brainPromptQueueService';

const log = createLogger('delegatee-reply-handler');

export interface InboundForMatch {
  clientNumber: string;
  /** Gmail thread id from feedEvent.rawPayload.threadId */
  threadId: string | null;
  /** Sender's email — must match the delegatee for the reply to count */
  senderEmail: string | null;
  /** Plain-text body / snippet to parse */
  body: string | null;
}

export interface MatchResult {
  matched: boolean;
  openItemId?: string;
  parsedDate?: Date;
  status: 'no_thread_id' | 'no_match' | 'wrong_sender' | 'parsed' | 'unparseable' | 'error';
  detail?: string;
}

export async function checkInboundForDelegateeReply(input: InboundForMatch): Promise<MatchResult> {
  if (!input.threadId) return { matched: false, status: 'no_thread_id' };

  // Find the open_item whose deadlineInquiry.threadId matches.
  let item;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: string; user_id: number; client_number: string;
      title: string; delegatee_email: string | null;
      meta: any;
    }>>(
      `SELECT id, user_id, client_number, title, delegatee_email,
              metadata as meta
         FROM open_items
        WHERE client_number = $1
          AND metadata->'deadlineInquiry'->>'threadId' = $2
          AND metadata->'deadlineInquiry'->>'status' IN ('sent','replied')
        LIMIT 1`,
      input.clientNumber, input.threadId,
    );
    item = rows[0];
  } catch (err: any) {
    log.warn('lookup failed', { err: err.message });
    return { matched: false, status: 'error', detail: err.message };
  }

  if (!item) return { matched: false, status: 'no_match' };

  // Sender must be the delegatee. Replies from other thread participants
  // (e.g. the user themselves) shouldn't auto-update dueDate.
  if (
    !input.senderEmail ||
    !item.delegatee_email ||
    input.senderEmail.toLowerCase() !== item.delegatee_email.toLowerCase()
  ) {
    return { matched: true, openItemId: item.id, status: 'wrong_sender' };
  }

  const parsed = parseDuePhrase(input.body ?? '');
  const now = new Date().toISOString();

  if (!parsed) {
    // Stamp the reply so the producer never re-asks, but flag for human
    // attention. The user sees the unparsed reply on the item details.
    await prisma.$executeRawUnsafe(
      `UPDATE open_items
          SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{deadlineInquiry}',
            (metadata->'deadlineInquiry') || $1::jsonb,
            true
          )
        WHERE id = $2`,
      JSON.stringify({
        status: 'replied',
        replyAt: now,
        rawReply: (input.body ?? '').slice(0, 1000),
        parsedDate: null,
        parseFailed: true,
      }),
      item.id,
    ).catch(() => {});

    // Tell the user via the prompt queue that the delegatee replied but
    // we couldn't parse a date.
    await enqueueBrainPrompt({
      userId: item.user_id,
      clientNumber: item.client_number,
      question: `${item.delegatee_email} replied about "${item.title}" but I couldn't extract a date. Open the item to read their reply.`,
      openItemId: item.id,
      sideEffect: { kind: 'set_due_date', openItemId: item.id },
      criticality: 'routine',
      dedupKey: `delegatee_reply_unparsed:${item.id}`,
      metadata: { source: 'delegatee_reply_unparsed' },
    }).catch(() => {});

    return { matched: true, openItemId: item.id, status: 'unparseable' };
  }

  // Parsed successfully — update dueDate + stamp metadata.
  try {
    await prisma.openItem.update({
      where: { id: item.id },
      data: { dueDate: parsed },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE open_items
          SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{deadlineInquiry}',
            (metadata->'deadlineInquiry') || $1::jsonb,
            true
          )
        WHERE id = $2`,
      JSON.stringify({
        status: 'parsed',
        replyAt: now,
        parsedDate: parsed.toISOString(),
        rawReply: (input.body ?? '').slice(0, 1000),
      }),
      item.id,
    );
  } catch (err: any) {
    log.warn('update dueDate failed', { itemId: item.id, err: err.message });
    return { matched: true, openItemId: item.id, status: 'error', detail: err.message };
  }

  // Tell the user. Routine prompt queue notification — no action required.
  const friendlyDate = parsed.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  await enqueueBrainPrompt({
    userId: item.user_id,
    clientNumber: item.client_number,
    question: `${item.delegatee_email} confirmed "${item.title}" by ${friendlyDate}. Item updated.`,
    openItemId: item.id,
    sideEffect: { kind: 'noop' },
    criticality: 'routine',
    dedupKey: `delegatee_reply_parsed:${item.id}`,
    metadata: { source: 'delegatee_reply_parsed', parsedDate: parsed.toISOString() },
  }).catch(() => {});

  return { matched: true, openItemId: item.id, parsedDate: parsed, status: 'parsed' };
}
