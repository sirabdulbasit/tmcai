/**
 * DEF-052 — outbound delivery acknowledgements.
 *
 * Owner, 2026-08-05: "there is a whatsapp standard function showing single tick
 * mean message has sent and double tick mean messages has received so why don't
 * it read it?"
 *
 * Nothing did. `grep message_ack services/whatsapp/` returned nothing, so after
 * every send Brain reported "WhatsApp accepted the message ... but did not
 * return a receipt ID. I won't retry automatically because that could send a
 * duplicate." The caution was right; the uncertainty was self-inflicted. The
 * answer arrives within seconds on an event nobody subscribed to.
 *
 * This is also the missing half of a bigger problem. Asked "did you inform
 * Hamna?", Brain guessed from the conversation transcript and got it wrong
 * twice (DEF-034, DEF-037). An ack is not a guess: level 2 means her phone has
 * the message, level 3 means she opened it. Ground truth, timestamped.
 *
 * Deliberately append-only and non-fatal. An ack that fails to record costs an
 * observability row; an ack that throws into the message pipeline would cost a
 * conversation.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:ack');

/** whatsapp-web.js ACK levels, named so call sites never compare magic ints. */
export const ACK = {
  ERROR: -1,
  PENDING: 0,
  SENT: 1,       // ✓  reached WhatsApp's servers
  DELIVERED: 2,  // ✓✓ reached the recipient's device
  READ: 3,       // ✓✓ blue — they opened it
  PLAYED: 4,     // voice note listened to
} as const;

export type AckStatus = 'sent' | 'delivered' | 'read';

/** Monotonic rank so a late-arriving lower ack cannot downgrade a higher one.
 *  WhatsApp does not guarantee ordering, and "read" must never regress to
 *  "delivered" because an out-of-order event landed second. */
const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, played: 4 };

export function statusForAck(ack: number): AckStatus | null {
  if (ack >= ACK.READ) return 'read';
  if (ack === ACK.DELIVERED) return 'delivered';
  if (ack === ACK.SENT) return 'sent';
  return null; // pending / error carry no delivery information
}

export interface RecordAckInput {
  clientNumber: string;
  providerId: string;
  ack: number;
  status?: AckStatus;
}

/**
 * Record the highest delivery state seen for an outbound message.
 * Returns true when a row was actually advanced.
 */
export async function recordOutboundAck(input: RecordAckInput): Promise<boolean> {
  const status = input.status ?? statusForAck(input.ack);
  if (!status) return false;

  try {
    const row = await prisma.whatsAppMessage.findFirst({
      where: { messageId: input.providerId, direction: 'outbound' },
      select: { id: true, status: true },
    });
    if (!row) return false; // an ack for something we did not send through this path

    // Never downgrade. A delayed `delivered` arriving after `read` is noise.
    if ((RANK[row.status] ?? 0) >= (RANK[status] ?? 0)) return false;

    await prisma.whatsAppMessage.update({
      where: { id: row.id },
      data: { status },
    });
    log.info('delivery ack recorded', { providerId: input.providerId.slice(-12), status });

    // Owner, 2026-08-05: "when received then just update me that 'Message sent
    // to Hamna'". Recording the tick is not telling him about it — the gap he
    // found by asking "will brain notify me when message will be received by
    // other?".
    //
    // On DELIVERED only. `sent` means it left our side and he saw that at send
    // time; `read` would be a second ping about one message and is available
    // from the ledger on request. One notice per message.
    if (status === 'delivered') {
      void notifyOwnerOfDelivery(input.clientNumber, input.providerId).catch(() => undefined);
    }
    return true;
  } catch (error: any) {
    log.warn('ack record failed', { error: error?.message?.slice(0, 200) });
    return false;
  }
}

/**
 * What actually happened to a message we sent — read from the ledger, never
 * inferred. This is what "did she get it?" must be answered from.
 */
export async function getDeliveryState(providerId: string): Promise<{
  status: string; at: Date | null;
} | null> {
  try {
    const row = await prisma.whatsAppMessage.findFirst({
      where: { messageId: providerId, direction: 'outbound' },
      select: { status: true, createdAt: true },
    });
    return row ? { status: row.status, at: row.createdAt } : null;
  } catch {
    return null;
  }
}

/**
 * Tell the owner his message landed.
 *
 * The recipient's name is NOT on `whatsapp_messages` — that table records who
 * SENT and never who received, which is the hole DEF-052 opened with. The name
 * comes from the dispatch artifact keyed on the same provider id: the ledger
 * knows, because that is where the target was recorded at send time.
 *
 * Silent when the artifact is missing. A delivery notice naming nobody is
 * worse than none, and this must never invent a recipient (DEF-041's class).
 */
async function notifyOwnerOfDelivery(clientNumber: string, providerId: string): Promise<void> {
  const artifact = await (prisma as any).brainActionArtifact.findFirst({
    where: { clientNumber, artifactExtId: providerId },
    select: { userId: true, payload: true },
  }).catch(() => null);
  if (!artifact?.userId) return;

  const payload = (artifact.payload ?? {}) as Record<string, any>;
  const full = typeof payload.recipientName === 'string' ? payload.recipientName.trim() : '';
  if (!full) return; // never "delivered to someone"
  const first = full.split(/\s+/)[0];

  const { enqueueBrainPrompt } = await import('../brainPrompts/brainPromptQueueService');
  await enqueueBrainPrompt({
    userId: artifact.userId,
    clientNumber,
    question: `Message delivered to ${first}.`,
    criticality: 'routine',
    // One notice per message, forever — a redelivered ack must not re-ping.
    dedupKey: `wa_delivered:${providerId}`,
    // DEF-063: "delivered" is a notice — it must never block the reply that
    // follows it, which is the thing the owner is actually waiting for.
    expectsReply: false,
    metadata: { source: 'delivery_ack', providerId, recipientName: full },
  });
}
