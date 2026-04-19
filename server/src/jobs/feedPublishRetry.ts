import prisma from '../db/prisma';
import { publish } from '../services/infra/pubsubPublisher';
import { PUBSUB_TOPICS } from '../config/pubsub';
import { verifySourceIntegrity } from '../services/feed/feedIngestionService';

/**
 * L1.4 — catch-up worker for feed_events whose publish failed at ingest time.
 *
 * Scans for rows with `published_message_id IS NULL AND status = 'new'` and
 * `created_at < now() - 5m` (grace period so in-flight ingests aren't touched),
 * then re-publishes them with the original trace + ordering. Max attempts is
 * capped so a poisonous row doesn't hot-loop forever — after 10 attempts we
 * mark it DLQ for manual review.
 */

const MAX_ATTEMPTS = 10;
const GRACE_SECONDS = 5 * 60;

export interface RetryStats {
  scanned: number;
  republished: number;
  errors: number;
  deadLettered: number;
}

export async function retryUnpublishedFeedEvents(batchSize = 50): Promise<RetryStats> {
  const graceCutoff = new Date(Date.now() - GRACE_SECONDS * 1000);
  const rows = (await prisma.feedEvent.findMany({
    where: {
      status: 'new',
      publishedMessageId: null,
      createdAt: { lt: graceCutoff },
      publishAttempts: { lt: MAX_ATTEMPTS },
    } as any,
    orderBy: { createdAt: 'asc' },
    take: batchSize,
  })) as any[];

  let republished = 0;
  let errors = 0;
  let deadLettered = 0;

  for (const row of rows) {
    const orderingKey = `${row.clientNumber}:${row.sourceType}:${row.sourceId}`;
    // L1.5 gate — refuse to republish a row whose integrity HMAC fails, so the
    // catch-up worker never re-emits a tampered payload to downstream consumers.
    if (row.sourceIntegrity) {
      const ok = verifySourceIntegrity(
        row.clientNumber,
        row.sourceType,
        row.sourceId,
        row.contentHash,
        row.sourceIntegrity,
      );
      if (!ok) {
        await prisma.feedEvent.update({
          where: { id: row.id },
          data: { status: 'dlq' },
        }).catch(() => {});
        deadLettered += 1;
        console.warn(`[feedPublishRetry] ${row.id} integrity failed — routed to DLQ`);
        continue;
      }
    }
    try {
      const messageId = await publish(
        PUBSUB_TOPICS.FEED_RAW,
        {
          feedEventId: row.id,
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          eventType: row.eventType ?? 'unknown',
          sender: {
            id: row.senderId ?? undefined,
            email: row.senderEmail ?? undefined,
            name: row.senderName ?? undefined,
            phone: row.senderPhone ?? undefined,
          },
          payload: row.rawPayload,
        },
        {
          tenantId: row.clientNumber,
          traceId: row.traceId ?? undefined,
          orderingKey,
          attributes: {
            sourceType: row.sourceType,
            eventType: row.eventType ?? 'unknown',
            senderEmail: row.senderEmail ?? undefined,
            catchUp: 'true',
          },
        },
      );
      await prisma.feedEvent.update({
        where: { id: row.id },
        data: {
          publishedMessageId: messageId,
          publishedAt: new Date(),
          publishAttempts: { increment: 1 },
        } as any,
      });
      republished += 1;
    } catch (err: any) {
      errors += 1;
      const nextAttempts = (row.publishAttempts ?? 0) + 1;
      const updateData: any = { publishAttempts: { increment: 1 } };
      if (nextAttempts >= MAX_ATTEMPTS) {
        updateData.status = 'dlq';
        deadLettered += 1;
      }
      await prisma.feedEvent.update({ where: { id: row.id }, data: updateData }).catch(() => {});
      console.warn(`[feedPublishRetry] ${row.id} failed attempt=${nextAttempts}: ${err.message}`);
    }
  }

  return { scanned: rows.length, republished, errors, deadLettered };
}
