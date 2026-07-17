import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:expected-external-reply');
const EXPECTED_REPLY_WINDOW_DAYS = 14;

export interface ExpectedExternalReplyInput {
  clientNumber: string;
  fromNumber: string;
  body: string;
  messageType: string;
  sourceId: string;
  timestamp?: number;
}

export interface ExpectedExternalReplyResult {
  matched: boolean;
  userId?: number;
  contactName?: string;
  openItemId?: string;
  feedEventId?: string;
}

function phoneVariants(phone: string): string[] {
  const digits = phone.replace(/[^\d]/g, '');
  // Keep exactly four values because the parameterized SQL below binds four
  // placeholders. Duplicates are harmless; removing them could leave an
  // `undefined` bind value for ordinary +92 numbers.
  return [
    phone,
    digits,
    `+${digits}`,
    `0${digits.startsWith('92') ? digits.slice(2) : digits}`,
  ];
}

/**
 * Admit a non-user inbound only when it is a reply from the exact recipient
 * of a recent, user-authorized tenant WhatsApp send. This is the narrow safety
 * exception that lets delegatees answer status requests without turning the
 * Nexeo number into an open chatbot for strangers.
 *
 * The reply is stored as evidence and surfaced to the owner. It is never sent
 * into the registered-user chat pipeline and never receives an automatic
 * response.
 */
export async function captureExpectedExternalReply(
  input: ExpectedExternalReplyInput,
): Promise<ExpectedExternalReplyResult> {
  const variants = phoneVariants(input.fromNumber);

  const outbound = await prisma.$queryRawUnsafe<Array<{
    id: number;
    user_id: number;
    to_number: string;
    content: string;
    created_at: Date;
  }>>(
    `SELECT id, user_id, to_number, content, created_at
       FROM whatsapp_messages
      WHERE client_number = $1
        AND direction IN ('outbound', 'out')
        AND status IN ('sent', 'sent_unconfirmed', 'delivered', 'read')
        AND created_at >= NOW() - ($6::int * INTERVAL '1 day')
        AND to_number IN ($2, $3, $4, $5)
      ORDER BY created_at DESC
      LIMIT 1`,
    input.clientNumber, variants[0], variants[1], variants[2], variants[3],
    EXPECTED_REPLY_WINDOW_DAYS,
  ).catch(() => []);

  if (!outbound.length) return { matched: false };
  const owner = outbound[0];

  // A human reply is stronger delivery evidence than a missing Web.js receipt.
  await prisma.$executeRawUnsafe(
    `UPDATE whatsapp_messages
        SET status = 'delivered', updated_at = NOW(),
            error_message = NULL
      WHERE id = $1 AND client_number = $2`,
    owner.id, input.clientNumber,
  ).catch(() => {});

  const contacts = await prisma.$queryRawUnsafe<Array<{ id: string; name: string }>>(
    `SELECT id, name
       FROM entities
      WHERE client_number = $1
        AND entity_type = 'contact'
        AND (owner_user_id = $2 OR scope = 'tenant')
        AND phone IN ($3, $4, $5, $6)
      ORDER BY CASE WHEN owner_user_id = $2 THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1`,
    input.clientNumber, owner.user_id,
    variants[0], variants[1], variants[2], variants[3],
  ).catch(() => []);
  const contactName = contacts[0]?.name ?? input.fromNumber;

  // Prefer an item whose title appeared in the outbound ask. If there is only
  // one active item delegated to this contact, use it as the safe fallback.
  const candidates = contacts[0]
    ? await prisma.$queryRawUnsafe<Array<{ id: string; title: string }>>(
        `SELECT id, title
           FROM open_items
          WHERE client_number = $1 AND user_id = $2
            AND status NOT IN ('CLOSED', 'DONE')
            AND LOWER(delegatee_name) = LOWER($3)
          ORDER BY updated_at DESC
          LIMIT 10`,
        input.clientNumber, owner.user_id, contactName,
      ).catch(() => [])
    : [];
  const outboundLower = String(owner.content ?? '').toLowerCase();
  const item = candidates.find((c) => outboundLower.includes(c.title.toLowerCase()))
    ?? (candidates.length === 1 ? candidates[0] : undefined);
  let lifecycleNeedsIntervention = false;

  const { ingest } = await import('../feed/feedIngestionService');
  const occurredAt = input.timestamp ?? Date.now();
  const feed = await ingest({
    clientNumber: input.clientNumber,
    sourceType: 'whatsapp',
    sourceId: input.sourceId,
    eventType: 'message_received',
    userId: owner.user_id,
    sender: { id: input.fromNumber, phone: input.fromNumber, name: contactName },
    payload: {
      waMessageId: input.sourceId,
      phoneNumber: input.fromNumber,
      senderName: contactName,
      body: input.body,
      type: input.messageType,
      timestamp: occurredAt,
      expectedExternalReply: true,
      relatedOpenItemId: item?.id ?? null,
      relatedOpenItemTitle: item?.title ?? null,
      outboundContext: String(owner.content ?? '').slice(0, 1000),
    },
  });

  if (item) {
    const note = {
      at: new Date(occurredAt).toISOString(),
      source: 'whatsapp_delegatee_reply',
      from: contactName,
      phone: input.fromNumber,
      body: input.body.slice(0, 2000),
      feedEventId: feed.feedEventId ?? null,
    };
    await prisma.$executeRawUnsafe(
      `UPDATE open_items
          SET notes = COALESCE(notes, '[]'::jsonb) || $1::jsonb,
              metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{lastDelegateeWhatsAppReply}', $2::jsonb, true
              ),
              updated_at = NOW()
        WHERE id = $3 AND client_number = $4 AND user_id = $5`,
      JSON.stringify([note]), JSON.stringify(note), item.id,
      input.clientNumber, owner.user_id,
    ).catch((e: any) => log.warn('open item reply evidence write failed', { error: e.message }));

    // Feed the same reply into the canonical living-action state machine.
    // It extracts completion, blockers, delay reasons, and new commitments;
    // the generic evidence note above remains as the immutable source trail.
    const { recordActionLifecycleReply } = await import('../openItems/actionLifecycleService');
    const lifecycleResult = await recordActionLifecycleReply({
      openItemId: item.id,
      clientNumber: input.clientNumber,
      body: input.body,
      source: 'whatsapp',
      sourceId: input.sourceId,
    }).catch((e: any) => {
      log.warn('action lifecycle reply update failed', { error: e.message });
      return null;
    });
    lifecycleNeedsIntervention = lifecycleResult?.needsUserIntervention === true;
  }

  // Blocker replies already generated an immediate high-criticality
  // intervention prompt. Do not add a second routine prompt for the same
  // message; ordinary progress/completion replies still notify the owner.
  if (!lifecycleNeedsIntervention) {
    const { enqueueBrainPrompt } = await import('../brainPrompts/brainPromptQueueService');
    await enqueueBrainPrompt({
      userId: owner.user_id,
      clientNumber: input.clientNumber,
      question: item
        ? `${contactName} replied about "${item.title}": “${input.body.slice(0, 500)}”`
        : `${contactName} replied to your WhatsApp message: “${input.body.slice(0, 500)}”`,
      openItemId: item?.id,
      sideEffect: { kind: 'noop' },
      criticality: 'routine',
      dedupKey: `external_wa_reply:${input.sourceId}`,
      metadata: {
        source: 'expected_external_whatsapp_reply',
        phone: input.fromNumber,
        feedEventId: feed.feedEventId,
      },
    }).catch(() => {});
  }

  log.info('expected external reply captured', {
    userId: owner.user_id,
    contactName,
    openItemId: item?.id,
    feedEventId: feed.feedEventId,
  });
  return {
    matched: true,
    userId: owner.user_id,
    contactName,
    openItemId: item?.id,
    feedEventId: feed.feedEventId,
  };
}
