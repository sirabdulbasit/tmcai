import crypto from 'crypto';
import prisma from '../../db/prisma';
import { publish } from '../infra/pubsubPublisher';
import { PUBSUB_TOPICS } from '../../config/pubsub';
import { getRedis } from '../../utils/redisClient';
import { REDIS_KEY_PATTERNS, REDIS_TTL } from '../../config/redis';
import { extractSourceEventTime } from './feedEventTime';

export type FeedSourceType = 'gmail' | 'whatsapp' | 'gchat' | 'gcal' | 'gtasks' | 'slack' | 'crm'
  | 'outlook' | 'outlook_calendar' | 'ms_teams' | 'onedrive_personal' | 'manual';

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
  /** MyOS — the user whose connector produced this event. Scopes per-user
   *  volume counts, triage, and Day Brief. Should always be set for
   *  user-scoped sources (gmail, whatsapp, gcal, gchat). Leave unset only
   *  for tenant-wide sources (crm, erp). */
  userId?: number;
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
    // Source-native event time (Gmail Date / Calendar start /
    // WhatsApp ts / Tasks updated). Lets every consumer query "when
    // did this happen in the world" without having to re-parse the
    // raw payload at read time. Falls back to null when the source
    // didn't carry a parseable timestamp — display layer falls back
    // to createdAt in that case.
    const eventAt = extractSourceEventTime(input.payload);

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
        userId: input.userId,
        eventAt,
      } as any,
    });

    // Tier 1 #8 — Entity discipline: lightweight UPSERT of an
    // entity_person wiki page for this sender so Brain has a stable
    // reference id from now on. Heavy enrichment (signals + body) is
    // deferred to the nightly entity sweep — this hook is a fire-and-
    // forget side-effect; failures must never break ingestion.
    if ((sender?.email || sender?.phone) && input.userId !== undefined) {
      void import('../knowledge/entitySweepService')
        .then(({ ensureEntityForSender }) => ensureEntityForSender({
          clientNumber: input.clientNumber,
          userId: input.userId!,
          senderEmail: sender.email ?? null,
          senderName: sender.name ?? null,
          senderPhone: sender.phone ?? null,
          // Forward the feed source so metadata.channels[] tracks which
          // channels this sender has appeared on (gmail / whatsapp / gcal …).
          sourceType: input.sourceType ?? null,
        }))
        .catch(() => { /* non-fatal */ });
    }

    // Tier 2 — Sentiment + urgency: classify the inbound message and
    // stamp results onto the row. Async + best-effort — if the LLM is
    // slow or unavailable, the deterministic fallback inside the
    // service still produces values. The hot ingest path is unblocked.
    void import('../triage/sentimentService')
      .then(({ enrichFeedEvent }) => enrichFeedEvent(row.id))
      .catch((err: any) => {
        // Backfill cron will retry — no need to log loudly per event.
        if (process.env.NODE_ENV !== 'production') {
          console.warn(`[feedIngestion] sentiment enrich failed for ${row.id}: ${err.message}`);
        }
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

    // MyOS — autonomous executor: if this event matches an ACTIVE shadow rule
    // for the user, Brain handles it now. Fire-and-forget.
    if (input.userId) {
      void (async () => {
        try {
          const { executeIfMatched } = await import('../triage/autonomousExecutor');
          const r = await executeIfMatched({
            id: row.id,
            clientNumber: input.clientNumber,
            userId: input.userId!,
            sourceType: input.sourceType,
            senderEmail: sender?.email ?? null,
            senderName: sender?.name ?? null,
            rawPayload: input.payload,
            createdAt: row.createdAt,
          });
          if (r?.executed) {
            console.log(`[autoExec] ${row.id} → ${r.action} via rule ${r.ruleId} (agent_action ${r.agentActionId})`);
          }
        } catch (err: any) {
          console.warn(`[autoExec] failed for ${row.id}: ${err.message}`);
        }
      })();
    }

    // MyOS — delegation tracker: if this inbound is from a delegatee on an
    // active DELEGATED open item for the user, classify and auto-close/
    // update. Fire-and-forget; any auto-action gets logged into agent_actions
    // and surfaces in the BRIEF section of Day Brief.
    if (input.userId) {
      void (async () => {
        try {
          const { checkInboundForDelegationUpdate } = await import('../delegation/delegationTrackerService');
          await checkInboundForDelegationUpdate({
            feedEventId: row.id,
            clientNumber: input.clientNumber,
            userId: input.userId!,
            sourceType: input.sourceType,
            senderEmail: sender?.email ?? null,
            senderName: sender?.name ?? null,
            rawPayload: input.payload,
          });
        } catch (err: any) {
          console.warn(`[delegationTracker] failed for ${row.id}: ${err.message}`);
        }
      })();
    }

    // Phase C — ingest propagation: extract project/policy references and
    // update the related tenant-shared wiki pages. One Flash call per
    // ingest; bounded, fire-and-forget.
    if (input.userId && sender?.email) {
      void (async () => {
        try {
          const p: any = input.payload ?? {};
          const { propagateFeedEvent } = await import('../knowledge/propagationService');
          await propagateFeedEvent({
            clientNumber: input.clientNumber,
            userId: input.userId!,
            feedEventId: row.id,
            sourceType: input.sourceType,
            subject: p.subject ?? null,
            snippet: p.snippet ?? p.body ?? null,
            senderEmail: sender.email ?? null,
            senderName: sender.name ?? null,
            receivedAt: row.createdAt,
          });
        } catch (err: any) {
          console.warn(`[propagation] failed for ${row.id}: ${err.message}`);
        }
      })();
    }

    // MyOS — Delegatee reply matcher. When the user previously emailed a
    // delegatee asking "by when?" via delegateeEmailProducer, Brain
    // stamped the open item with metadata.deadlineInquiry.threadId. This
    // hook matches inbound gmail events on threadId, parses the body for
    // a date phrase, updates dueDate, and notifies the user via the
    // prompt queue. Fire-and-forget: never blocks ingestion.
    if (input.userId && input.sourceType === 'gmail' && sender?.email) {
      void (async () => {
        try {
          const p: any = input.payload ?? {};
          const threadId: string | null = p.threadId ?? p.gmailThreadId ?? null;
          if (!threadId) return;
          const { checkInboundForDelegateeReply } = await import('../brainPrompts/delegateeReplyHandler');
          await checkInboundForDelegateeReply({
            clientNumber: input.clientNumber,
            threadId,
            senderEmail: sender.email ?? null,
            body: String(p.body ?? p.snippet ?? ''),
          });
        } catch (err: any) {
          console.warn(`[delegateeReply] failed for ${row.id}: ${err.message}`);
        }
      })();
    }

    // Star cadence — sender-stars-driven WhatsApp notification schedule.
    // Triggers HERE (at feed-ingest) rather than at open-item creation,
    // so a starred contact's message ALWAYS gets the cadence treatment
    // — even if the message ends up classified as inform_only and never
    // becomes an open item. Without this, a 5★ contact's email would
    // silently bypass the voice-call schedule whenever the classifier
    // didn't promote it to an open item. Fire-and-forget; failures
    // never block ingestion.
    if (input.userId && sender?.email) {
      void (async () => {
        try {
          const p: any = input.payload ?? {};
          const { scheduleStarCadence } = await import('../triage/starCadenceService');
          await scheduleStarCadence({
            clientNumber: input.clientNumber,
            userId: input.userId!,
            feedEventId: row.id,
            senderEmail: sender.email!,
            senderName: sender.name ?? null,
            itemTitle: p.subject ?? p.title ?? '(no subject)',
            itemBody: p.snippet ?? p.body ?? null,
            // Classification hasn't run yet at ingest time — pass null
            // so the content gate uses its regex fallbacks (action verbs,
            // question marks, deadline phrases, thanks/OOO detection).
            intent: null,
          });
        } catch (err: any) {
          console.warn(`[starCadence] feed-ingest schedule failed ${row.id}: ${err.message}`);
        }
      })();
    }

    // MyOS Knowledge — email_message page per Gmail message. Captures
    // the full body (HTML → plaintext) so Brain has "the actual content",
    // not just the 280-char snippet. Fire-and-forget from the ingest path.
    if (input.userId && input.sourceType === 'gmail' && sender?.email) {
      void (async () => {
        try {
          const p: any = input.payload ?? {};
          const messageId: string | undefined = p.messageId ?? p.gmailMessageId ?? input.sourceId;
          if (!messageId) return;
          const { ingestEmailBody } = await import('../knowledge/emailBodyIngestService');
          await ingestEmailBody({
            clientNumber: input.clientNumber,
            userId: input.userId!,
            gmailMessageId: messageId,
            feedEventId: row.id,
            senderEmail: sender.email ?? null,
            senderName: sender.name ?? null,
            subject: p.subject ?? null,
            receivedAt: row.createdAt,
          });
        } catch (err: any) {
          console.warn(`[emailBody] failed for ${row.id}: ${err.message}`);
        }
      })();
    }

    // MyOS Knowledge — attachment_doc pages for Gmail attachments.
    // Fire-and-forget: downloads each attachment, extracts text
    // (pdf/docx/xlsx/txt), creates/updates an attachment_doc wiki page
    // so Brain can open + quote + cite the attachment like any other
    // wiki page. Skipped for non-Gmail sources.
    if (input.userId && input.sourceType === 'gmail') {
      void (async () => {
        try {
          const p: any = input.payload ?? {};
          const messageId: string | undefined = p.messageId ?? p.gmailMessageId ?? input.sourceId;
          if (!messageId) return;
          const { ingestMessageAttachments } = await import('../knowledge/attachmentWikiService');
          await ingestMessageAttachments({
            clientNumber: input.clientNumber,
            userId: input.userId!,
            senderEmail: sender?.email ?? null,
            gmailMessageId: messageId,
            feedEventId: row.id,
            subject: p.subject ?? null,
            receivedAt: row.createdAt,
          });
        } catch (err: any) {
          console.warn(`[attachmentWiki] failed for ${row.id}: ${err.message}`);
        }
      })();
    }

    // MyOS Knowledge — sender & sender+topic wiki pages. These are the
    // LLM-readable "running memory" of each relationship, updated on
    // every ingest. Triage reads the markdown body directly instead of
    // recomputing history from feed_events each call.
    // Gate: we accept email OR phone — WhatsApp senders come with phone only.
    if (input.userId && (sender?.email || sender?.phone)) {
      void (async () => {
        try {
          const { updateSenderWikiOnIngest } = await import('../knowledge/senderWikiService');
          // Compute dedup_hash + archetype lazily (avoids a hard dep on triage)
          let dedupHash: string | undefined;
          let archetype: string | undefined;
          try {
            const p: any = input.payload ?? {};
            const { classifyArchetypeFromPayload } = await import('../triage/executorHelpers');
            const { computeDedupHash } = await import('../triage/triageSuggester');
            const itemType =
              input.sourceType === 'gmail' ? 'email' :
              input.sourceType === 'whatsapp' ? 'whatsapp' :
              input.sourceType === 'gcal' ? 'meeting' :
              input.sourceType === 'gtasks' ? 'task' : 'email';
            archetype = classifyArchetypeFromPayload(
              String(p.subject ?? ''),
              String(p.snippet ?? p.body ?? ''),
              String(p.from ?? sender?.email ?? ''),
            );
            const senderDomain = sender?.email?.split('@')[1]?.toLowerCase();
            dedupHash = computeDedupHash({ userId: input.userId!, itemType: itemType as any, archetype: archetype as any, senderDomain });
          } catch { /* hash is best-effort — topic page just skipped */ }

          await updateSenderWikiOnIngest({
            clientNumber: input.clientNumber,
            userId: input.userId!,
            senderEmail: sender.email ?? null,
            senderPhone: sender.phone ?? null,
            senderName: sender.name ?? null,
            subject: String((input.payload as any)?.subject ?? '') || null,
            preview: String((input.payload as any)?.snippet ?? (input.payload as any)?.body ?? '') || null,
            dedupHash,
            archetype,
            sourceType: input.sourceType,
            feedEventId: row.id,
            receivedAt: row.createdAt,
          });
        } catch (err: any) {
          console.warn(`[senderWiki] failed for ${row.id}: ${err.message}`);
        }
      })();
    }

    // MyOS Knowledge — wiki_scribe: maintain entity graph + auto-create wiki
    // pages for contacts/companies. Fire-and-forget; no user-visible failure.
    void (async () => {
      try {
        const { scribeFromFeedEvent } = await import('../knowledge/wikiScribeService');
        await scribeFromFeedEvent({
          clientNumber: input.clientNumber,
          userId: input.userId ?? null,
          senderEmail: sender?.email ?? null,
          senderName: sender?.name ?? null,
          fromHeader: (input.payload as any)?.from ?? null,
          createdAt: row.createdAt,
          feedEventId: row.id,
        });
      } catch (err: any) {
        console.warn(`[wikiScribe] failed for ${row.id}: ${err.message}`);
      }
    })();

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
