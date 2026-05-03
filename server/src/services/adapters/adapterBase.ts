/**
 * HaseebOS v15 §3.2 F-1 — canonical source adapter interface.
 *
 * Every feed adapter (Gmail, WhatsApp, GChat, GCal, GTasks, + MyOS extras like
 * Drive, Odoo, Notion) should implement this 10-method contract.
 *
 * Adapters that pre-date this interface don't need to implement every method —
 * the registry tracks capability support and the REST API rejects calls to
 * unsupported methods with 501 Not Implemented.
 */
import crypto from 'crypto';
import type { FeedEventType, FeedSender, FeedSourceType, IngestResult, RawEventInput } from '../feed/feedIngestionService';
import { ingest as feedIngest, markProcessed, markSkipped } from '../feed/feedIngestionService';

export interface NormalizedEvent {
  sourceId: string;
  eventType: FeedEventType;
  sender?: FeedSender;
  payload: Record<string, unknown>;
  /** Arrival time on our side. Adapter-specific time may differ (e.g. Gmail internalDate) */
  receivedAt: Date;
}

export interface AdapterHealth {
  ok: boolean;
  detail?: string;
  lastCheckedAt: string;
}

export interface BackfillRange {
  tenantId: string;
  since?: Date;
  until?: Date;
  maxEvents?: number;
}

export interface BackfillResult {
  fetched: number;
  ingested: number;
  duplicates: number;
  errors: number;
  firstEventAt?: Date;
  lastEventAt?: Date;
}

export interface TeardownResult {
  ok: boolean;
  connectionsRemoved: number;
  tokensRevoked: number;
  notes?: string;
}

export abstract class FeedAdapter {
  /** Stable source type this adapter handles (one of FeedSourceType). */
  abstract readonly sourceType: FeedSourceType;

  /** Human-readable display name. */
  abstract readonly displayName: string;

  // ─── 1. receive ────────────────────────────────────────────────
  /**
   * Fetch new events from the source since `since`. Returns raw provider
   * objects — caller (usually `backfill`) is responsible for normalising and
   * feeding each through `ingest()`.
   */
  receive?(tenantId: string, since?: Date, limit?: number): Promise<unknown[]>;

  // ─── 2. verify ─────────────────────────────────────────────────
  /**
   * Validate an inbound webhook or push notification. Returns true if the
   * request is authentic. For polling adapters this can be a no-op.
   */
  verify?(payload: unknown, signature?: string): Promise<boolean>;

  // ─── 3. dedup ──────────────────────────────────────────────────
  /**
   * Compute a deterministic id for dedup. Default implementation uses the
   * provider-supplied message id. Adapters can override for composite keys.
   */
  dedupKey(raw: unknown): string {
    const r = raw as any;
    return String(r.id ?? r.messageId ?? r.sourceId ?? r.externalId ?? crypto.randomUUID());
  }

  // ─── 4. normalise ──────────────────────────────────────────────
  /**
   * Convert a raw provider object into a NormalizedEvent. Sets eventType and
   * sender so Triage can index without re-parsing rawPayload.
   */
  abstract normalise(raw: unknown): NormalizedEvent;

  // ─── 5. enrich ─────────────────────────────────────────────────
  /**
   * Optional: pre-triage enrichment. Override to add entity linking, sentiment,
   * sender company resolution, etc. Default is pass-through.
   */
  async enrich(event: NormalizedEvent, _tenantId: string): Promise<NormalizedEvent> {
    return event;
  }

  // ─── 6. store ──────────────────────────────────────────────────
  // ─── 7. publish ────────────────────────────────────────────────
  /**
   * Store + publish pass through `feedIngestionService.ingest()` which handles
   * the unique-constraint dedup, Pub/Sub publish, and per-entity ordering.
   * This default implementation is the canonical path — most adapters should
   * not override it.
   */
  async storeAndPublish(event: NormalizedEvent, tenantId: string, traceId?: string): Promise<IngestResult> {
    // If the adapter attached a userId via payload.userId (e.g. Gmail, GCal,
    // Tasks each stamp the connector-owner's id), lift it to the column so
    // per-user queries (Day Brief volume, triage) scope correctly.
    const payloadUserId = typeof (event.payload as any)?.userId === 'number'
      ? ((event.payload as any).userId as number)
      : undefined;
    const input: RawEventInput = {
      clientNumber: tenantId,
      sourceType: this.sourceType,
      sourceId: event.sourceId,
      payload: event.payload,
      traceId,
      eventType: event.eventType,
      sender: event.sender,
      userId: payloadUserId,
    };
    return feedIngest(input);
  }

  // ─── 8. health ─────────────────────────────────────────────────
  /**
   * Is the source reachable right now? UI Health Check tab calls this.
   */
  abstract health(tenantId?: string): Promise<AdapterHealth>;

  // ─── 9. backfill ───────────────────────────────────────────────
  /**
   * Replay historical events in [since, until] into feed_events. New tenants
   * call this on onboarding; admins call it after a connector re-auth.
   *
   * Default implementation: "not_supported" — adapters must opt in by overriding.
   */
  async backfill(range: BackfillRange): Promise<BackfillResult> {
    throw new Error(`${this.sourceType} adapter does not support backfill`);
  }

  // ─── 10. teardown ──────────────────────────────────────────────
  /**
   * Disconnect the adapter for this tenant: revoke tokens, remove webhooks,
   * clear local state. Default is a no-op (adapters owning per-tenant state
   * MUST override).
   */
  async teardown(_tenantId: string): Promise<TeardownResult> {
    return { ok: true, connectionsRemoved: 0, tokensRevoked: 0, notes: 'no-op (no per-tenant state)' };
  }

  /** Helper for adapters that promote events via Feed Curator agent later. */
  protected async markIngestedProcessed(feedEventId: string, tenantId: string, openItemId?: string) {
    return markProcessed(feedEventId, tenantId, openItemId);
  }

  protected async markIngestedSkipped(feedEventId: string, tenantId: string, reason: string) {
    return markSkipped(feedEventId, tenantId, reason);
  }

  /**
   * Capability report — which optional methods this adapter actually supports.
   * Used by the REST API to return accurate 501 responses.
   */
  capabilities(): Record<string, boolean> {
    const proto = Object.getPrototypeOf(this);
    const parentProto = FeedAdapter.prototype;
    return {
      receive: typeof this.receive === 'function',
      verify: typeof this.verify === 'function',
      backfill: proto.backfill !== parentProto.backfill,
      teardown: proto.teardown !== parentProto.teardown,
      enrich: proto.enrich !== parentProto.enrich,
    };
  }
}
