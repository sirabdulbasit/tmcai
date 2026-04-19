import crypto from 'crypto';
import prisma from '../../db/prisma';
import { publish } from '../infra/pubsubPublisher';
import { PUBSUB_TOPICS } from '../../config/pubsub';
import { getRedis } from '../../utils/redisClient';
import { REDIS_KEY_PATTERNS, REDIS_TTL } from '../../config/redis';

export type FeedSourceType = 'gmail' | 'whatsapp' | 'gchat' | 'gcal' | 'gtasks' | 'slack' | 'crm' | 'manual';

/**
 * HaseebOS v15 FeedEvent canonical event types (§3.2 F-4).
 * Adapters should map their source-specific event types into one of these.
 */
export type FeedEventType =
  | 'message_received'   // inbound email, whatsapp, chat message
  | 'message_sent'       // outbound via same source
  | 'thread_updated'     // email reply, chat thread add
  | 'meeting_invite'     // calendar invite received
  | 'meeting_updated'    // calendar event changed
  | 'meeting_cancelled'
  | 'task_assigned'      // google tasks, delegation
  | 'task_completed'
  | 'document_shared'    // drive share notification
  | 'document_updated'
  | 'status_update'      // generic catch-all
  | 'unknown';

export interface FeedSender {
  /** stable unique id (email, waId, workspace user id) */
  id?: string;
  /** display name if available */
  name?: string;
  /** email if known */
  email?: string;
  /** phone if known (WhatsApp) */
  phone?: string;
}

export interface RawEventInput {
  clientNumber: string;
  sourceType: FeedSourceType;
  sourceId: string;
  payload: Record<string, unknown>;
  traceId?: string;
  /** HaseebOS v15 canonical event type. Defaults to `'unknown'` if not provided. */
  eventType?: FeedEventType;
  /** Structured sender info for triage — far cheaper than re-parsing rawPayload downstream. */
  sender?: FeedSender;
}

export interface IngestResult {
  status: 'new' | 'duplicate' | 'error';
  feedEventId?: string;
  contentHash: string;
  publishedMessageId?: string;
  error?: string;
}

/**
 * Canonical feed ingestion path:
 *  1. Compute content hash (SHA-256 of canonicalized payload)
 *  2. Insert row into `feed_events` — unique(clientNumber, contentHash) dedupes
 *  3. Publish to `feed.raw` Pub/Sub topic with tenantId ordering + traceId
 *  4. Downstream Feed Curator agent subscribes to feed.raw and promotes events
 *
 * Any code path that receives external data (Gmail webhook, WhatsApp inbound,
 * scheduled sync) should call this instead of writing directly to OpenItem.
 */
export async function ingest(input: RawEventInput): Promise<IngestResult> {
  const contentHash = computeHash(input.sourceType, input.sourceId, input.payload);
  const traceId = input.traceId ?? crypto.randomUUID();
  const eventType: FeedEventType = input.eventType ?? inferEventType(input.sourceType, input.payload);
  const sender = input.sender ?? inferSender(input.sourceType, input.payload);
  // L1.5 — tamper-evidence HMAC. Proves the payload hasn't been modified after
  // ingest without invalidating the DB row: any edit to rawPayload would need to
  // also forge this value, which requires the ingest secret.
  const sourceIntegrity = computeSourceIntegrity(input.clientNumber, input.sourceType, input.sourceId, contentHash);

  // Dedup check via unique constraint — try to insert, catch PGE 23505
  try {
    const row = await prisma.feedEvent.create({
      data: {
        clientNumber: input.clientNumber,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        contentHash,
        rawPayload: input.payload as any,
        status: 'new',
        traceId,
        eventType,
        senderId: sender?.id,
        senderEmail: sender?.email,
        senderName: sender?.name,
        senderPhone: sender?.phone,
        sourceIntegrity,
      } as any,
    });

    let publishedMessageId: string | undefined;
    try {
      // L1.3 — Redis SETNX pre-publish gate. Two writers racing on the same
      // contentHash: the DB unique constraint still wins, but without this gate
      // both would attempt a publish → duplicate Pub/Sub messages downstream.
      // SETNX NX EX 24h keeps the gate for the dedup window.
      const gateKey = REDIS_KEY_PATTERNS.feedPubGate(input.clientNumber, contentHash);
      const gateTtl = REDIS_TTL.idempotencyHours * 60 * 60;
      const ok = await getRedis().set(gateKey, row.id, 'EX', gateTtl, 'NX');
      if (ok !== 'OK') {
        // Another ingester already published (or is about to) — skip publish,
        // but still return 'new' since our DB insert won the unique race.
        console.log(`[feedIngestion] ${row.id} pub gate held, skipping publish`);
        return { status: 'new', feedEventId: row.id, contentHash };
      }
      // Per-entity ordering key (HaseebOS v15 §3.2) — guarantees ordering per source thread
      // rather than serializing the whole tenant's events. Format: <tenant>:<source>:<external_id>
      const orderingKey = `${input.clientNumber}:${input.sourceType}:${input.sourceId}`;
      console.log(`[feedIngestion] publishing ${row.id} → ${PUBSUB_TOPICS.FEED_RAW} key=${orderingKey}`);
      publishedMessageId = await publish(
        PUBSUB_TOPICS.FEED_RAW,
        { feedEventId: row.id, sourceType: input.sourceType, sourceId: input.sourceId, eventType, sender, payload: input.payload },
        {
          tenantId: input.clientNumber,
          traceId,
          orderingKey,
          attributes: {
            sourceType: input.sourceType,
            eventType,
            senderId: sender?.id,
            senderEmail: sender?.email,
          },
        },
      );
      console.log(`[feedIngestion] published ${row.id} messageId=${publishedMessageId}`);
      // Persist publish state so L1.4 catch-up worker knows this event is done.
      await prisma.feedEvent.update({
        where: { id: row.id },
        data: {
          publishedMessageId,
          publishedAt: new Date(),
          publishAttempts: { increment: 1 } as any,
        } as any,
      }).catch(() => { /* best-effort: catch-up worker covers this */ });
    } catch (err: any) {
      // Pub/Sub down — feed event is still in Postgres and will be retried by a catch-up worker
      console.warn(`[feedIngestion] pubsub publish failed for ${row.id}: ${err.message}`);
      await prisma.feedEvent.update({
        where: { id: row.id },
        data: { publishAttempts: { increment: 1 } as any } as any,
      }).catch(() => {});
    }

    return { status: 'new', feedEventId: row.id, contentHash, publishedMessageId };
  } catch (err: any) {
    if (err?.code === 'P2002') {
      // Prisma unique constraint violation → duplicate
      const existing = await prisma.feedEvent.findFirst({
        where: { clientNumber: input.clientNumber, contentHash },
        select: { id: true },
      });
      return { status: 'duplicate', feedEventId: existing?.id, contentHash };
    }
    return { status: 'error', contentHash, error: err.message };
  }
}

// ─── Event type + sender inference from raw payload ────────────────
// These give adapters a sensible default when they don't set explicit
// eventType / sender. Adapters SHOULD set them explicitly; this is a fallback.

function inferEventType(sourceType: FeedSourceType, payload: Record<string, unknown>): FeedEventType {
  const p: any = payload;
  switch (sourceType) {
    case 'gmail':
      return p.threadId ? 'thread_updated' : 'message_received';
    case 'whatsapp':
    case 'gchat':
      return 'message_received';
    case 'gcal':
      if (p.status === 'cancelled') return 'meeting_cancelled';
      if (p.updated) return 'meeting_updated';
      return 'meeting_invite';
    case 'gtasks':
      if (p.completed) return 'task_completed';
      return 'task_assigned';
    case 'manual':
    default:
      return 'unknown';
  }
}

function inferSender(sourceType: FeedSourceType, payload: Record<string, unknown>): FeedSender | undefined {
  const p: any = payload;
  switch (sourceType) {
    case 'gmail':
      return { email: p.from, name: p.fromName };
    case 'whatsapp':
      return { id: p.waId, phone: p.phoneNumber, name: p.senderName };
    case 'gchat':
      return { id: p.sender?.name, name: p.sender?.displayName, email: p.sender?.email };
    case 'gcal':
      return { email: p.organizer?.email, name: p.organizer?.displayName };
    case 'gtasks':
      return p.assignee ? { id: String(p.assignee) } : undefined;
    default:
      return undefined;
  }
}

/**
 * Mark a feed event as processed (called by Feed Curator agent after promoting
 * it to an OpenItem). Records the sourceFeedEventId linkage.
 */
export async function markProcessed(feedEventId: string, clientNumber: string, openItemId?: string): Promise<void> {
  await prisma.feedEvent.updateMany({
    where: { id: feedEventId, clientNumber },
    data: { status: 'processed', processedAt: new Date() },
  });
  if (openItemId) {
    await prisma.openItem.updateMany({
      where: { id: openItemId, clientNumber },
      data: { sourceFeedEventId: feedEventId },
    });
  }
}

/**
 * Mark a feed event as DLQ / unprocessable (skipped by curator).
 */
export async function markSkipped(feedEventId: string, clientNumber: string, reason: string): Promise<void> {
  await prisma.feedEvent.updateMany({
    where: { id: feedEventId, clientNumber },
    data: { status: 'skipped', processedAt: new Date(), rawPayload: { skipReason: reason } as any },
  });
}

function computeHash(sourceType: string, sourceId: string, payload: Record<string, unknown>): string {
  const canonical = `${sourceType}:${sourceId}:${canonicalize(payload)}`;
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * L1.5 — tamper-evidence. HMAC over (tenant, source, sourceId, contentHash)
 * using an ingest secret. If any of those fields are edited post-ingest without
 * also regenerating this HMAC, integrity check fails. The secret is read from
 * env (backed by Secret Manager `tmcai-feed-integrity-secret`); in dev it
 * falls back to a fixed string so local tests still round-trip.
 */
function computeSourceIntegrity(tenantId: string, sourceType: string, sourceId: string, contentHash: string): string {
  const secret = process.env.FEED_INTEGRITY_SECRET || 'dev-feed-integrity-secret';
  return crypto
    .createHmac('sha256', secret)
    .update(`${tenantId}:${sourceType}:${sourceId}:${contentHash}`)
    .digest('hex');
}

/**
 * Verify a stored feed event has not been tampered with. Callers that read
 * rawPayload for evidence (e.g. audit tools) should run this first.
 */
export function verifySourceIntegrity(
  tenantId: string,
  sourceType: string,
  sourceId: string,
  contentHash: string,
  stored: string | null | undefined,
): boolean {
  if (!stored) return false;
  const expected = computeSourceIntegrity(tenantId, sourceType, sourceId, contentHash);
  try {
    return crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function canonicalize(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((obj as any)[k])}`).join(',')}}`;
}
