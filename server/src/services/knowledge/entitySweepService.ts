/**
 * Entity Discipline Sweep.
 *
 * v16's "1335 people files" pattern — every distinct sender MyOS has
 * encountered gets exactly ONE canonical wiki_page (`page_type='entity_person'`)
 * that the Brain reads from on every reasoning turn. Without this, Brain
 * re-derives "who is X" from feed history every prompt — slow, inconsistent,
 * token-expensive.
 *
 * Two paths:
 *   1) On-event hook (real-time, lightweight)
 *      ensureEntityForSender(clientNumber, userId, senderEmail, senderName)
 *      Idempotent UPSERT of the entity page row. No LLM, no aggregation —
 *      just makes sure the page exists. Called from feed ingestion.
 *
 *   2) Nightly sweep (batch)
 *      sweepForTenant(clientNumber)
 *      Discovers entities from recent feed_events, computes aggregate
 *      signals (last contact, frequency, recent topics, active open items,
 *      delegation area, CRM relationship), composes the canonical body,
 *      UPSERTs, re-embeds for vector search.
 *
 * Multi-tenant + multi-user:
 *   - Corporate-domain senders → tenant-shared (page_type='entity_person',
 *     visible to every user in the tenant per TENANT_SHARED_PAGE_TYPES).
 *   - Personal-domain senders (gmail, outlook personal, yahoo, etc.) →
 *     user-scoped fallback so a personal contact doesn't leak across users.
 *   - Domains classified as "tenant-wide" can be configured per-tenant
 *     via system_config.entity_tenant_domains (comma-separated).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { getConfig } from '../configService';
import { embedWikiPage } from './wikiEmbeddingService';

const log = createLogger('entity-sweep');

// Personal-mail domains where the sender → user-scoped (not tenant-shared)
// unless the admin explicitly adds the domain to the tenant list.
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com',
  'aol.com',
]);

// Stable id format. Email is the canonical identifier when present;
// otherwise we fall back to phone (whatsapp). Both are normalized.
function entityIdForEmail(email: string): string {
  return `person:${email.trim().toLowerCase()}`;
}
function entityIdForPhone(phone: string): string {
  return `person:phone:${phone.replace(/[^\d+]/g, '')}`;
}

/**
 * On-event hook: ensure an entity page exists for a sender. Called from
 * feed ingestion. Lightweight — no aggregation, no LLM, no embed. Just
 * an UPSERT so the entity row exists for the nightly sweep to enrich.
 */
export async function ensureEntityForSender(input: {
  clientNumber: string;
  userId: number;
  senderEmail: string | null;
  senderName: string | null;
  senderPhone?: string | null;
  /** Feed source that discovered this sender (gmail, whatsapp, gcal,
   *  outlook, slack, etc.). Tracked in metadata.channels[] so the UI
   *  can show "this contact came from gmail + whatsapp". */
  sourceType?: string | null;
  /** Manual / google_import / microsoft_import bypass the junk filter.
   *  Default unset = ingest path = filter applies. */
  importSource?: string;
}): Promise<{ id: string; created: boolean } | null> {
  const email = (input.senderEmail ?? '').trim().toLowerCase();
  const phone = (input.senderPhone ?? '').trim();
  if (!email && !phone) return null;

  // Self-filter: a user shouldn't appear as their own contact. This
  // happens when feed ingestion processes an event the user themselves
  // sent (or where their email shows up in the To/CC). Compare against
  // both the login email AND the integrationEmail (Gmail OAuth subject).
  // Always applies — no bypass — because adding yourself as a contact
  // is never useful regardless of source.
  if (email) {
    const me = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { email: true, integrationEmail: true } as any,
    }).catch(() => null) as { email?: string | null; integrationEmail?: string | null } | null;
    const myEmails = [me?.email, me?.integrationEmail]
      .map((e) => (e ?? '').trim().toLowerCase())
      .filter(Boolean);
    if (myEmails.includes(email)) {
      return null;
    }
  }

  // Junk filter — skip auto-discovery for senders that look like
  // newsletters / no-reply / tracking tokens. Bypassed when caller
  // is a manual add or a Google/Outlook import (explicit user intent).
  // Pass-2 signal gating (sent-to history, inbound count, calendar
  // attendance) happens in entitySweep / sender-promotion paths after
  // some history accumulates. For NEW unknown senders, the junk filter
  // alone is the gate — anything that smells like noreply never gets
  // a contact row created.
  const importSource = input.importSource ?? '';
  const bypassFilter = importSource === 'manual' || importSource.endsWith('_import') || input.sourceType === 'whatsapp';
  if (!bypassFilter && email) {
    const { isLikelyAutomated } = await import('./senderQualityFilter');
    if (isLikelyAutomated(email)) {
      return null;  // silently skip — sender_history may still record
                    // the message, but no contact row is created.
    }
  }

  const id = email ? entityIdForEmail(email) : entityIdForPhone(phone);
  // Scope policy: USER-private by default. A discovered sender belongs
  // to the user whose feed surfaced it. Tenant-shared scope is opt-in
  // either by admin domain allowlist (system_config.entity_tenant_domains)
  // or by manual entry with admin's `forceTenantShared` flag. This way
  // user A's auto-discovered contacts are NOT visible to user B.
  const scope = await classifyScope(input.clientNumber, email);
  const ownerUserId = scope === 'tenant' ? await pickSystemUserId(input.clientNumber) : input.userId;
  if (!ownerUserId) return null;

  // Title preference: name when known, else local-part of email, else phone
  const localPart = email.includes('@') ? email.split('@')[0] : '';
  const title = (input.senderName?.trim() || localPart || phone || 'Unknown').slice(0, 280);

  const existing = await prisma.wikiPage.findUnique({
    where: { id },
    select: { id: true, metadata: true },
  });
  if (existing) {
    // Two updates may need to happen:
    //   · append the source channel (gmail/whatsapp/…) if new
    //   · add this user to discovered_by_users so they can see the
    //     contact in their own list (multi-user visibility)
    const meta = (existing.metadata as Record<string, unknown> | null) ?? {};
    const channels = Array.isArray(meta.channels) ? (meta.channels as string[]) : [];
    const discoveredBy = Array.isArray(meta.discovered_by_users)
      ? (meta.discovered_by_users as number[])
      : [];

    const newChannel = input.sourceType && !channels.includes(input.sourceType);
    const newDiscoverer = !discoveredBy.includes(input.userId);

    if (newChannel || newDiscoverer) {
      const next: Record<string, unknown> = { ...meta };
      if (newChannel) next.channels = [...channels, input.sourceType!];
      if (newDiscoverer) next.discovered_by_users = [...discoveredBy, input.userId];
      await prisma.$executeRawUnsafe(
        `UPDATE wiki_pages SET metadata = $1::jsonb WHERE id = $2`,
        JSON.stringify(next), id,
      ).catch(() => {});
    }
    return { id, created: false };
  }

  await prisma.$executeRawUnsafe(
    `INSERT INTO wiki_pages
       (id, client_number, user_id, page_type, title, storage,
        body_markdown, status, confidence, metadata,
        last_updated_by, last_updated_at, created_at)
     VALUES ($1, $2, $3, 'entity_person', $4, 'postgres',
             $5, 'active', 0.7, $6::jsonb,
             'entity_sweep', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    id, input.clientNumber, ownerUserId, title,
    seedBodyForNewEntity(title, email, phone),
    JSON.stringify({
      source: 'entity_sweep',
      imported_from: 'auto_discovered',
      scope,
      email: email || null,
      phone: phone || null,
      channels: input.sourceType ? [input.sourceType] : [],
      // Multi-user visibility: the discovering user is the first member
      // of this set. Subsequent ingest hooks for other users append.
      discovered_by_users: [input.userId],
      first_seen_at: new Date().toISOString(),
      last_enriched_at: null,
    }),
  );
  return { id, created: true };
}

/**
 * Nightly sweep for one tenant. Discovers every sender from the last
 * 30 days, enriches each entity page with aggregate signals, and
 * re-embeds for vector search.
 */
export async function sweepForTenant(
  clientNumber: string,
  opts: { lookbackDays?: number } = {},
): Promise<{ scanned: number; created: number; enriched: number; errors: number }> {
  const lookback = opts.lookbackDays ?? 30;
  const result = { scanned: 0, created: 0, enriched: 0, errors: 0 };

  const senders = await prisma.$queryRawUnsafe<any[]>(
    `SELECT sender_email,
            MAX(sender_name) AS sender_name,
            MAX(sender_phone) AS sender_phone,
            MIN(user_id) AS first_user_id,
            COUNT(*)::int AS event_count,
            MAX(created_at) AS last_seen
       FROM feed_events
      WHERE client_number = $1
        AND created_at >= NOW() - (INTERVAL '1 day' * $2)
        AND (sender_email IS NOT NULL OR sender_phone IS NOT NULL)
      GROUP BY sender_email
      ORDER BY event_count DESC
      LIMIT 2000`,
    clientNumber, lookback,
  ).catch((err) => { log.error('sender discovery failed', { error: err.message }); return [] as any[]; });

  for (const s of senders) {
    result.scanned += 1;
    try {
      const ensured = await ensureEntityForSender({
        clientNumber,
        userId: Number(s.first_user_id),
        senderEmail: s.sender_email,
        senderName: s.sender_name,
        senderPhone: s.sender_phone,
      });
      if (!ensured) continue;
      if (ensured.created) result.created += 1;
      const enriched = await enrichEntityPage(clientNumber, ensured.id);
      if (enriched) result.enriched += 1;
    } catch (err: any) {
      result.errors += 1;
      log.warn('entity enrich failed', { sender: s.sender_email, error: err.message });
    }
  }

  log.info('entity sweep complete', { clientNumber, ...result });
  return result;
}

/**
 * Recompute aggregate signals + canonical markdown body for a single
 * entity page. Called from the sweep AND from on-demand admin refresh.
 * Idempotent — safe to run repeatedly.
 *
 * Returns true when the page was actually updated; false when the
 * computed signature matches what's already stored (skip-on-noop).
 */
export async function enrichEntityPage(clientNumber: string, entityPageId: string): Promise<boolean> {
  const page = await prisma.wikiPage.findUnique({ where: { id: entityPageId } });
  if (!page || page.clientNumber !== clientNumber) return false;
  const meta = (page.metadata as Record<string, unknown> | null) ?? {};
  const email = String(meta.email ?? '').toLowerCase();
  const phone = String(meta.phone ?? '');
  if (!email && !phone) return false;

  // ── Aggregate signals ────────────────────────────────────────
  const stats = await computeStats(clientNumber, email, phone);
  const recentTopics = await getRecentTopics(clientNumber, email, phone);
  const openItems = await getActiveOpenItems(clientNumber, email);
  const delegationOwner = await findDelegationOwner(clientNumber, email);
  const odooMatch = await findOdooPartnerMatch(clientNumber, email);

  const signature = JSON.stringify({
    last_seen: stats.lastSeen?.toISOString() ?? null,
    weekly: stats.weeklyVolume,
    open: openItems.length,
    deleg: delegationOwner?.area ?? null,
    odoo: odooMatch?.partnerId ?? null,
    topicsHash: recentTopics.join('|'),
  });
  if (meta.signature === signature) return false;

  // ── Compose body ─────────────────────────────────────────────
  const title = page.title;
  const body = composeEntityBody({
    title, email, phone,
    role: typeof meta.role === 'string' ? meta.role : null,
    stats, recentTopics, openItems, delegationOwner, odooMatch,
  });

  await prisma.$executeRawUnsafe(
    `UPDATE wiki_pages
        SET body_markdown = $1,
            metadata = $2::jsonb,
            last_updated_by = 'entity_sweep',
            last_updated_at = NOW()
      WHERE id = $3`,
    body,
    JSON.stringify({
      ...meta,
      signature,
      last_enriched_at: new Date().toISOString(),
      stats: {
        weeklyVolume: stats.weeklyVolume,
        replyRatio: stats.replyRatio,
        lastSeen: stats.lastSeen?.toISOString() ?? null,
        relationshipStrength: stats.relationshipStrength,
      },
    }),
    entityPageId,
  );

  // Re-embed so vector retrieval picks up the new content. Fire-and-forget;
  // failure here is non-fatal (next sweep retries).
  embedWikiPage(entityPageId).catch(() => {});
  return true;
}

// ─── Manual contact creation ──────────────────────────────────────
//
// User-initiated "Add contact" flow. Same canonical entity_person row,
// stable id `person:<email>` (or phone fallback). Manual entries get
// `metadata.imported_from='manual'` so the source pill renders correctly.
//
// Multi-tenant: tenant-shared by default for corporate-domain emails;
// user-scoped for personal-domain emails. Admin can force tenant-shared
// regardless via the `forceTenantShared` flag.

export interface ManualContactInput {
  clientNumber: string;
  actorUserId: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  organization?: string | null;
  notes?: string | null;
  /** Admin-only: forces page_type=entity_person + scope=tenant regardless
   *  of whether the email is a personal-domain. Non-admin callers should
   *  pass false; the route enforces the role check. */
  forceTenantShared?: boolean;
}

export async function createManualContact(input: ManualContactInput): Promise<{ id: string; created: boolean }> {
  const email = (input.email ?? '').trim().toLowerCase();
  const phone = (input.phone ?? '').trim();
  const name = input.name.trim();
  if (!name) throw new Error('name required');
  if (!email && !phone) throw new Error('email or phone required');

  const ensured = await ensureEntityForSender({
    clientNumber: input.clientNumber,
    userId: input.actorUserId,
    senderEmail: email || null,
    senderName: name,
    senderPhone: phone || null,
    importSource: 'manual',  // bypass junk filter — explicit user intent
  });
  if (!ensured) throw new Error('failed to create entity');

  // Stamp manual-source metadata + override scope when admin forced it.
  const patch: Record<string, unknown> = {
    imported_from: 'manual',
    imported_at: new Date().toISOString(),
    role: input.role ?? null,
    organization: input.organization ?? null,
    manual_notes: input.notes ?? null,
  };
  if (input.forceTenantShared) patch.scope = 'tenant';

  await prisma.$executeRawUnsafe(
    `UPDATE wiki_pages
        SET title = COALESCE($1, title),
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
            last_updated_by = 'manual_entry',
            last_updated_at = NOW()
      WHERE id = $3`,
    name, JSON.stringify(patch), ensured.id,
  );

  // Light enrich + re-embed so search picks it up.
  enrichEntityPage(input.clientNumber, ensured.id).catch(() => {});
  return ensured;
}

// ─── User-facing star rating (per-user importance) ───────────────
//
// Per-user 0..5 importance rating attached to an entity_person page.
// Stars stack on top of the criticality engine: routine messages from
// a 5-star sender always reach the user, never silently auto-archived.
//
// Storage: `wiki_pages.metadata.user_stars` is an object keyed by userId
// → integer 0..5. Per-user so different roles can rate the same person
// differently (your CFO's "5-star" vs your support lead's "5-star"
// describe different things).

export const STAR_BUMP = {
  // How much each star adds to relationshipRisk (capped at 1.0 in
  // criticality engine). 5 stars = +0.50 ≈ guaranteed relationship_risk
  // at minimum, before any other signal stacks on top.
  relationshipRiskAdd: [0, 0.05, 0.10, 0.20, 0.35, 0.50],
  // Criticality FLOOR — score from these stars alone is at least this
  // band, ignoring any signal-based dampening.
  bandFloor: ['low', 'low', 'medium', 'medium', 'high', 'critical'] as const,
} as const;

/**
 * Read the per-user importance stars for an entity. Returns 0 when
 * the user hasn't rated this entity (the default = "no boost").
 */
export async function getStars(entityPageId: string, userId: number): Promise<number> {
  const row = await prisma.wikiPage.findUnique({
    where: { id: entityPageId },
    select: { metadata: true },
  }).catch(() => null);
  const meta = (row?.metadata as Record<string, unknown> | null) ?? {};
  const stars = (meta.user_stars as Record<string, unknown> | undefined) ?? {};
  const raw = Number(stars[String(userId)] ?? 0);
  return Math.max(0, Math.min(5, Math.floor(raw)));
}

/**
 * Set the per-user importance rating for an entity. Accepts 0..5; 0
 * removes the rating. Returns the new effective rating.
 *
 * Multi-tenant: caller must verify clientNumber match before calling.
 */
export async function setStars(entityPageId: string, userId: number, stars: number): Promise<number> {
  const clamped = Math.max(0, Math.min(5, Math.floor(Number(stars) || 0)));
  const row = await prisma.wikiPage.findUnique({ where: { id: entityPageId }, select: { metadata: true } });
  if (!row) throw new Error('entity not found');
  const meta = ((row.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  const userStars = { ...((meta.user_stars as Record<string, unknown>) ?? {}) };
  if (clamped === 0) {
    delete userStars[String(userId)];
  } else {
    userStars[String(userId)] = clamped;
  }
  await prisma.wikiPage.update({
    where: { id: entityPageId },
    data: {
      metadata: { ...meta, user_stars: userStars } as unknown as object,
      lastUpdatedBy: 'user_stars',
      lastUpdatedAt: new Date(),
    },
  });
  return clamped;
}

/**
 * Bulk-fetch stars for many entities for one user — used by
 * criticality engine + list views.
 */
export async function getStarsForEntities(entityPageIds: string[], userId: number): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (entityPageIds.length === 0) return result;
  const rows = await prisma.wikiPage.findMany({
    where: { id: { in: entityPageIds } },
    select: { id: true, metadata: true },
  });
  for (const r of rows) {
    const meta = (r.metadata as Record<string, unknown> | null) ?? {};
    const stars = (meta.user_stars as Record<string, unknown> | undefined) ?? {};
    result.set(r.id, Math.max(0, Math.min(5, Math.floor(Number(stars[String(userId)] ?? 0)))));
  }
  return result;
}

/**
 * Look up stars for a sender by email — returns 0 if no entity page
 * exists yet or the user hasn't rated. Used by the criticality engine
 * to bump relationshipRisk on inbound events.
 */
export async function getStarsForSender(clientNumber: string, userId: number, senderEmail: string | null): Promise<number> {
  if (!senderEmail) return 0;
  const id = entityIdForEmail(senderEmail);
  const row = await prisma.wikiPage.findUnique({
    where: { id },
    select: { metadata: true, clientNumber: true },
  }).catch(() => null);
  if (!row || row.clientNumber !== clientNumber) return 0;
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  const stars = (meta.user_stars as Record<string, unknown> | undefined) ?? {};
  return Math.max(0, Math.min(5, Math.floor(Number(stars[String(userId)] ?? 0))));
}

// ─── Cross-tenant entry point for the cron ───────────────────────

export async function sweepForAllTenants(): Promise<{ tenants: number; aggregate: { scanned: number; created: number; enriched: number; errors: number } }> {
  const tenants = await prisma.$queryRawUnsafe<Array<{ client_number: string }>>(
    `SELECT DISTINCT client_number FROM feed_events
      WHERE created_at >= NOW() - INTERVAL '30 days'`,
  );
  const agg = { scanned: 0, created: 0, enriched: 0, errors: 0 };
  for (const t of tenants) {
    const r = await sweepForTenant(t.client_number).catch((err) => {
      log.error('tenant sweep failed', { clientNumber: t.client_number, error: err.message });
      return { scanned: 0, created: 0, enriched: 0, errors: 1 };
    });
    agg.scanned += r.scanned; agg.created += r.created;
    agg.enriched += r.enriched; agg.errors += r.errors;
  }
  return { tenants: tenants.length, aggregate: agg };
}

// ─── Helpers (signal gatherers) ──────────────────────────────────

interface EntityStats {
  totalEvents: number;
  weeklyVolume: number;
  replyRatio: number;        // 0..1, replies-from-us / received-from-them
  lastSeen: Date | null;
  typicalReplyHours: number | null;
  relationshipStrength: number; // 0..1
}

async function computeStats(clientNumber: string, email: string, phone: string): Promise<EntityStats> {
  const filter = email ? { col: 'sender_email', val: email } : { col: 'sender_phone', val: phone };
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT
        COUNT(*)::int AS total_events,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS week_volume,
        MAX(created_at) AS last_seen,
        MIN(created_at) AS first_seen
      FROM feed_events
      WHERE client_number = $1 AND ${filter.col} = $2`,
    clientNumber, filter.val,
  ).catch(() => [{ total_events: 0, week_volume: 0, last_seen: null, first_seen: null }] as any[]);
  const r = rows[0] ?? {};
  const total = Number(r.total_events ?? 0);
  const weekly = Number(r.week_volume ?? 0);
  const lastSeen: Date | null = r.last_seen ? new Date(r.last_seen) : null;
  // Relationship strength: blend frequency × recency. Saturates around
  // 5 events/week and decays past 14 days of silence.
  const recency = lastSeen ? Math.max(0, 1 - (Date.now() - lastSeen.getTime()) / (14 * 86400000)) : 0;
  const frequency = Math.min(1, weekly / 5);
  const relationshipStrength = Math.round((0.6 * frequency + 0.4 * recency) * 100) / 100;
  return {
    totalEvents: total,
    weeklyVolume: weekly,
    replyRatio: 0,
    lastSeen,
    typicalReplyHours: null,
    relationshipStrength,
  };
}

async function getRecentTopics(clientNumber: string, email: string, phone: string): Promise<string[]> {
  const filter = email ? { col: 'sender_email', val: email } : { col: 'sender_phone', val: phone };
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT DISTINCT raw_payload->>'subject' AS subject
       FROM feed_events
      WHERE client_number = $1 AND ${filter.col} = $2
        AND raw_payload->>'subject' IS NOT NULL
        AND created_at >= NOW() - INTERVAL '14 days'
      ORDER BY MAX(created_at) DESC
      LIMIT 5`,
    clientNumber, filter.val,
  ).catch(() => [] as any[]);
  return rows.map((r) => normaliseSubject(String(r.subject))).filter(Boolean).slice(0, 5);
}

function normaliseSubject(s: string): string {
  // Strip "Re:", "Fwd:" and trim. Subjects often re-appear with prefixes
  // and we want to treat them as the same topic.
  return s.replace(/^(re:|fwd?:|fw:|\[.*?\])\s*/gi, '').trim().slice(0, 120);
}

interface ActiveOpenItem { id: string; itemNumber: number; title: string; status: string; priority: string; }
async function getActiveOpenItems(clientNumber: string, email: string): Promise<ActiveOpenItem[]> {
  if (!email) return [];
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT DISTINCT oi.id, oi.item_number AS "itemNumber", oi.title, oi.status, oi.priority
       FROM open_items oi
       JOIN feed_events fe ON fe.id = oi.source_feed_event_id
      WHERE oi.client_number = $1
        AND fe.sender_email = $2
        AND oi.status NOT IN ('CLOSED','INFORMED')
      ORDER BY oi.created_at DESC
      LIMIT 8`,
    clientNumber, email,
  ).catch(() => [] as any[]);
  return rows.map((r) => ({
    id: String(r.id),
    itemNumber: Number(r.itemNumber),
    title: String(r.title),
    status: String(r.status),
    priority: String(r.priority),
  }));
}

async function findDelegationOwner(clientNumber: string, email: string): Promise<{ area: string; ownerName: string; ownerRole: string | null } | null> {
  if (!email) return null;
  const domain = email.includes('@') ? email.split('@')[1] : '';
  // Match the area whose owner_email shares this email or domain. Simple
  // for now; a richer match (subject keywords) is a Phase 2 enhancement.
  const rows = await prisma.delegationMatrix.findMany({
    where: {
      clientNumber, isActive: true,
      OR: [
        { ownerEmail: email },
        ...(domain ? [{ ownerEmail: { endsWith: `@${domain}` } as any }] : []),
      ],
    },
    take: 1,
  });
  if (rows[0]) {
    return { area: rows[0].area, ownerName: rows[0].ownerName, ownerRole: rows[0].ownerRole };
  }
  return null;
}

async function findOdooPartnerMatch(clientNumber: string, email: string): Promise<{ partnerId: number; title: string; pageId: string } | null> {
  if (!email) return null;
  // Odoo mirror writes partners with metadata.odoo_id and page_type='entity'.
  // Use a Postgres JSONB query so we don't need a join through model.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, metadata->>'odoo_id' AS odoo_id
       FROM wiki_pages
      WHERE client_number = $1
        AND last_updated_by = 'odoo_mirror'
        AND page_type = 'entity'
        AND metadata->>'odoo_id' IS NOT NULL
      LIMIT 200`,
    clientNumber,
  ).catch(() => [] as any[]);
  // Best-effort: title-substring match on the email's local part. The
  // Odoo mirror doesn't currently store partner email, so we rely on
  // name overlap. A deterministic email→partner_id index is Phase 2.
  const localPart = email.split('@')[0].toLowerCase();
  const hit = rows.find((r) => String(r.title ?? '').toLowerCase().includes(localPart));
  if (!hit) return null;
  return { partnerId: Number(hit.odoo_id), title: hit.title, pageId: hit.id };
}

// ─── Body composer ───────────────────────────────────────────────

function seedBodyForNewEntity(title: string, email: string, phone: string): string {
  const lines = [`# ${title}`, ''];
  if (email) lines.push(`**Email:** ${email}`);
  if (phone) lines.push(`**Phone:** ${phone}`);
  lines.push('', '_Auto-discovered. The nightly entity sweep will enrich this page._');
  return lines.join('\n');
}

interface ComposeInput {
  title: string;
  email: string;
  phone: string;
  role: string | null;
  stats: EntityStats;
  recentTopics: string[];
  openItems: ActiveOpenItem[];
  delegationOwner: { area: string; ownerName: string; ownerRole: string | null } | null;
  odooMatch: { partnerId: number; title: string; pageId: string } | null;
}

function composeEntityBody(c: ComposeInput): string {
  const lines: string[] = [];
  lines.push(`# ${c.title}`);
  lines.push('');
  if (c.email) lines.push(`**Email:** ${c.email}`);
  if (c.phone) lines.push(`**Phone:** ${c.phone}`);
  if (c.role) lines.push(`**Role:** ${c.role}`);
  lines.push(`**Source:** Feed (auto-discovered)`);
  if (c.odooMatch) lines.push(`**CRM:** Odoo partner #${c.odooMatch.partnerId} ([${c.odooMatch.title}](${c.odooMatch.pageId}))`);
  lines.push('');

  lines.push('## Activity (last 30 days)');
  lines.push(`- Total events: ${c.stats.totalEvents}`);
  lines.push(`- This week: ${c.stats.weeklyVolume}`);
  if (c.stats.lastSeen) {
    const ageDays = Math.floor((Date.now() - c.stats.lastSeen.getTime()) / 86400000);
    lines.push(`- Last contact: ${ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays}d ago`}`);
  } else {
    lines.push(`- Last contact: (never)`);
  }
  lines.push(`- Relationship strength: ${(c.stats.relationshipStrength * 100).toFixed(0)}%`);
  lines.push('');

  if (c.recentTopics.length > 0) {
    lines.push('## Recent topics');
    for (const t of c.recentTopics) lines.push(`- ${t}`);
    lines.push('');
  }

  if (c.openItems.length > 0) {
    lines.push('## Active open items');
    for (const oi of c.openItems) {
      lines.push(`- [#${oi.itemNumber}] ${oi.title} · ${oi.status} · priority=${oi.priority}`);
    }
    lines.push('');
  }

  if (c.delegationOwner) {
    lines.push('## Relationships');
    lines.push(`- Delegation area: **${c.delegationOwner.area}** — owned by ${c.delegationOwner.ownerName}${c.delegationOwner.ownerRole ? ` (${c.delegationOwner.ownerRole})` : ''}`);
    lines.push('');
  }

  lines.push('## Brain notes');
  lines.push('_(Reserved for explicit notes; auto-enrichment narrative is Phase 2.)_');

  return lines.join('\n');
}

// ─── Scope + system-user resolution ──────────────────────────────

async function classifyScope(clientNumber: string, email: string): Promise<'tenant' | 'user'> {
  // Default policy: USER-PRIVATE.
  //
  // Auto-discovered contacts belong only to the user whose feed surfaced
  // them. Tenant-sharing requires explicit opt-in by admin via the
  // `entity_tenant_domains` system_config key (comma-separated domain
  // allowlist) — only senders on that list become tenant-shared. This
  // prevents user A's auto-replies + vendor newsletters from appearing
  // in user B's contacts list.
  if (!email) return 'user';
  const domain = email.includes('@') ? email.split('@')[1] : '';
  if (!domain) return 'user';
  if (PERSONAL_DOMAINS.has(domain)) return 'user';
  // Admin allowlist: only domains on this list are tenant-shared.
  const extra = await getConfig(clientNumber, 'entity_tenant_domains').catch(() => null);
  if (extra) {
    const allow = new Set(extra.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean));
    if (allow.has(domain)) return 'tenant';
  }
  // Everything else: user-private.
  return 'user';
}

async function pickSystemUserId(clientNumber: string): Promise<number | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    `SELECT id FROM users WHERE client_number = $1 AND is_active = TRUE ORDER BY id ASC LIMIT 1`,
    clientNumber,
  );
  return rows[0]?.id ?? null;
}
