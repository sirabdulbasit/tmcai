/**
 * Entity catalog routes — the tenant's auto-discovered "address book of
 * intelligence". Backed by entitySweepService + the wiki_pages table.
 *
 *   GET    /                             list entities for the tenant (paginated, searchable)
 *   GET    /:id                          single entity page (full body + metadata)
 *   POST   /:id/refresh                  re-enrich one entity (admin or owner only)
 *   POST   /sweep                        manually trigger the tenant sweep (admin only)
 *
 * Multi-tenant: every read scopes by clientNumber. Tenant-shared
 * entity pages (page_type='entity_person' on a corporate domain) are
 * visible to every user; user-scoped (personal-domain) entities are
 * filtered to the requester.
 */
import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import prisma from '../db/prisma';
import { sweepForTenant, enrichEntityPage, setStars, createManualContact } from '../services/knowledge/entitySweepService';
import { syncAllContactsFromGoogle } from '../services/googleContactsService';
import { syncAllContactsFromMicrosoft } from '../services/microsoftContactsService';

const router = Router();
router.use(requireAuth);

router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 500);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const titleFilter = q ? { contains: q, mode: 'insensitive' as const } : undefined;
    // Filter: minimum stars (?minStars=4 = only 4-5 star contacts)
    const minStars = Math.max(0, Math.min(5, parseInt(String(req.query.minStars ?? '0'), 10) || 0));
    // Filter: by import source ('google_contacts' | 'whatsapp_history' | …)
    const source = String(req.query.source ?? '').trim();
    // Sort: stars (default) | recent. Stars-first puts the contacts the
    // user has explicitly marked important at the top; recency is the
    // tiebreaker (most rows are 0 stars).
    const sort = String(req.query.sort ?? 'stars').trim();

    // Visibility rule:
    //   · entities the requesting user owns (user_id = self)
    //   · tenant-shared entities (metadata.scope = 'tenant')
    //   · entities the user has DISCOVERED (their id is in
    //     metadata.discovered_by_users) — covers the case where two
    //     users both received from the same sender and Brain only
    //     created one canonical row, owned by whoever was first.
    // Done as raw SQL so we can use the @> jsonb-contains operator.
    const userIdJson = JSON.stringify([req.user!.id]);
    const titleClause = titleFilter ? `AND lower(title) LIKE $4` : '';
    const args: any[] = [req.user!.clientNumber, req.user!.id, userIdJson];
    if (titleFilter) args.push(`%${q.toLowerCase()}%`);
    const rawRows = await prisma.$queryRawUnsafe<any[]>(
      // Status filter: hide archived (junk_filter / self_contact /
      // duplicate_collapsed), inactive (user-marked), deleted, and
      // contradicted. Keep active + orphan + stale — the wiki linter
      // marks contacts as 'orphan' when nothing else links to them
      // but they're still legitimate contacts.
      `SELECT id, title, last_updated_at AS "lastUpdatedAt", status, confidence,
              metadata, user_id AS "userId"
         FROM wiki_pages
        WHERE client_number = $1
          AND page_type = 'entity_person'
          AND status NOT IN ('archived', 'inactive', 'deleted', 'contradicted')
          AND (
            user_id = $2
            OR metadata->>'scope' = 'tenant'
            OR metadata->'discovered_by_users' @> $3::jsonb
          )
          ${titleClause}
        ORDER BY last_updated_at DESC
        LIMIT 1000`,
      ...args,
    ).catch(() => [] as any[]);
    const rows = rawRows;

    const userId = req.user!.id;
    let projected = rows.map((r) => projectListItem(r, userId));

    if (minStars > 0) projected = projected.filter((p) => (p.stars ?? 0) >= minStars);
    if (source) projected = projected.filter((p) => p.importedFrom === source);

    if (sort === 'stars') {
      projected.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0)
        || new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());
    }
    // sort === 'recent' falls through — rows already arrive
    // last_updated_at DESC from the SQL above.

    const total = projected.length;
    const paged = projected.slice(offset, offset + limit);
    res.json({ count: paged.length, total, entities: paged });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * PATCH /:id/inactive  →  mark a contact as inactive (soft-delete).
 *
 * Sets status='inactive' + stamps metadata.markedInactiveByUser=true.
 * Sticky: ensureEntityForSender treats inactive rows as no-ops, so
 * future emails / WhatsApp messages from this address will NOT
 * resurrect the contact. The row stays in the DB so the entity_id
 * collision rule (deterministic from normalized email) prevents
 * recreation; sender_history pages may still link to it.
 *
 * Reversible: PATCH /:id/restore flips it back to 'active'.
 *
 * Tenant-scoped — caller can only mark contacts in their own tenant
 * inactive. Owner-scoped: only the owning user OR an admin in the
 * tenant can mark a contact inactive (a teammate's contact list isn't
 * yours to clean up).
 */
router.patch('/:id/inactive', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const page = await prisma.wikiPage.findUnique({
      where: { id },
      select: { clientNumber: true, pageType: true, userId: true },
    });
    if (!page || page.clientNumber !== req.user!.clientNumber || page.pageType !== 'entity_person') {
      res.status(404).json({ error: 'not found' }); return;
    }
    const isOwner = (page as any).userId === req.user!.id;
    if (!isOwner && !req.user!.isAdmin) {
      res.status(403).json({ error: 'only the contact owner or a tenant admin can mark inactive' }); return;
    }
    await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages
          SET status = 'inactive',
              last_updated_at = NOW(),
              last_updated_by = 'user_marked_inactive',
              metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
        WHERE id = $2`,
      JSON.stringify({
        markedInactiveByUser: true,
        markedInactiveAt: new Date().toISOString(),
        markedInactiveBy: req.user!.id,
      }),
      id,
    );
    res.json({ ok: true, id, status: 'inactive' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/** PATCH /:id/restore  →  flip an inactive contact back to active. */
router.patch('/:id/restore', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const page = await prisma.wikiPage.findUnique({
      where: { id },
      select: { clientNumber: true, pageType: true, userId: true },
    });
    if (!page || page.clientNumber !== req.user!.clientNumber || page.pageType !== 'entity_person') {
      res.status(404).json({ error: 'not found' }); return;
    }
    const isOwner = (page as any).userId === req.user!.id;
    if (!isOwner && !req.user!.isAdmin) {
      res.status(403).json({ error: 'only the contact owner or a tenant admin can restore' }); return;
    }
    await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages
          SET status = 'active',
              last_updated_at = NOW(),
              last_updated_by = 'user_restored',
              metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
        WHERE id = $2`,
      JSON.stringify({
        markedInactiveByUser: false,
        restoredAt: new Date().toISOString(),
        restoredBy: req.user!.id,
      }),
      id,
    );
    res.json({ ok: true, id, status: 'active' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/** PATCH /:id/rename  →  user-overrideable display name. Sets
 *  metadata.userRenamed=true so feed ingest can never overwrite.
 *  Body: { name: string }. */
router.patch('/:id/rename', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const raw = String((req.body ?? {}).name ?? '').trim();
    if (!raw) { res.status(400).json({ error: 'name required' }); return; }
    if (raw.length > 280) { res.status(400).json({ error: 'name too long (max 280)' }); return; }
    const page = await prisma.wikiPage.findUnique({
      where: { id },
      select: { clientNumber: true, pageType: true, userId: true },
    });
    if (!page || page.clientNumber !== req.user!.clientNumber || page.pageType !== 'entity_person') {
      res.status(404).json({ error: 'not found' }); return;
    }
    const isOwner = (page as any).userId === req.user!.id;
    if (!isOwner && !req.user!.isAdmin) {
      res.status(403).json({ error: 'only the contact owner or a tenant admin can rename' }); return;
    }
    // Trust the user — don't title-case their input. They may have a
    // specific casing in mind ("McDonald", "iPhone"). We only enforce
    // length and stamp the override flag.
    await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages
          SET title = $1,
              last_updated_at = NOW(),
              last_updated_by = 'user_renamed',
              metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $3`,
      raw.slice(0, 280),
      JSON.stringify({
        userRenamed: true,
        renamedAt: new Date().toISOString(),
        renamedBy: req.user!.id,
      }),
      id,
    );
    res.json({ ok: true, id, name: raw.slice(0, 280) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * PATCH /:id/publish   →  make a contact visible to the whole tenant.
 * PATCH /:id/unpublish →  flip it back to private (owner-only).
 *
 * Per user 2026-05-11: contacts default to private. The owner (or a
 * tenant admin) explicitly opts a contact into Public via this
 * endpoint, after which every teammate sees it in their Contacts
 * list. Unpublish restores private scope.
 *
 * Ownership rule: only the contact's owner OR a tenant admin can
 * flip scope. A teammate who happens to see a Public contact can't
 * unpublish it from under the owner.
 *
 * Audit fields: metadata.scope, metadata.publicSince,
 * metadata.publicSetBy (userId) — so we can later answer "who shared
 * this and when".
 */
router.patch('/:id/publish', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const page = await prisma.wikiPage.findUnique({
      where: { id },
      select: { clientNumber: true, pageType: true, userId: true, metadata: true },
    });
    if (!page || page.clientNumber !== req.user!.clientNumber || page.pageType !== 'entity_person') {
      res.status(404).json({ error: 'not found' }); return;
    }
    const isOwner = (page as any).userId === req.user!.id;
    if (!isOwner && !req.user!.isAdmin) {
      res.status(403).json({ error: 'only the contact owner or a tenant admin can publish' }); return;
    }
    const meta = ((page.metadata as Record<string, unknown> | null) ?? {});
    const next = {
      ...meta,
      scope: 'tenant',
      publicSince: new Date().toISOString(),
      publicSetBy: req.user!.id,
    };
    await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages SET metadata = $1::jsonb, last_updated_at = NOW() WHERE id = $2`,
      JSON.stringify(next), id,
    );
    res.json({ id, scope: 'tenant' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id/unpublish', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const page = await prisma.wikiPage.findUnique({
      where: { id },
      select: { clientNumber: true, pageType: true, userId: true, metadata: true },
    });
    if (!page || page.clientNumber !== req.user!.clientNumber || page.pageType !== 'entity_person') {
      res.status(404).json({ error: 'not found' }); return;
    }
    const isOwner = (page as any).userId === req.user!.id;
    if (!isOwner && !req.user!.isAdmin) {
      res.status(403).json({ error: 'only the contact owner or a tenant admin can unpublish' }); return;
    }
    const meta = ((page.metadata as Record<string, unknown> | null) ?? {});
    const next: Record<string, unknown> = { ...meta, scope: 'user' };
    delete next.publicSince;
    delete next.publicSetBy;
    next.unpublishedAt = new Date().toISOString();
    next.unpublishedBy = req.user!.id;
    await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages SET metadata = $1::jsonb, last_updated_at = NOW() WHERE id = $2`,
      JSON.stringify(next), id,
    );
    res.json({ id, scope: 'user' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id/stars', async (req: Request, res: Response) => {
  // Per-user star rating. Returns the new effective stars value.
  // Caller doesn't need admin — every user manages their own stars.
  try {
    const id = req.params.id as string;
    const stars = Math.max(0, Math.min(5, Math.floor(Number((req.body ?? {}).stars ?? 0))));
    const page = await prisma.wikiPage.findUnique({ where: { id }, select: { clientNumber: true, pageType: true } });
    if (!page || page.clientNumber !== req.user!.clientNumber || page.pageType !== 'entity_person') {
      res.status(404).json({ error: 'not found' }); return;
    }
    const newStars = await setStars(id, req.user!.id, stars);
    res.json({ id, stars: newStars });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const page = await prisma.wikiPage.findUnique({ where: { id } });
    if (!page || page.clientNumber !== req.user!.clientNumber || page.pageType !== 'entity_person') {
      res.status(404).json({ error: 'not found' }); return;
    }
    // Visibility: tenant-shared OR user owns OR user has discovered
    // (matches the list query rule, kept consistent so a user can drill
    // into any contact they see in the list).
    const meta = (page.metadata as Record<string, unknown> | null) ?? {};
    const isTenantShared = meta.scope === 'tenant';
    const isOwner = page.userId === req.user!.id;
    const discoveredBy = Array.isArray(meta.discovered_by_users) ? (meta.discovered_by_users as number[]) : [];
    const isDiscoverer = discoveredBy.includes(req.user!.id);
    if (!isTenantShared && !isOwner && !isDiscoverer) {
      res.status(403).json({ error: 'not visible to this user' }); return;
    }
    res.json({ entity: page });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/refresh', async (req: Request, res: Response) => {
  // Admin or page-owner can trigger a re-enrich on demand. Useful when
  // someone updates a CRM stage and wants the entity page to catch up.
  try {
    const id = req.params.id as string;
    const page = await prisma.wikiPage.findUnique({ where: { id } });
    if (!page || page.clientNumber !== req.user!.clientNumber || page.pageType !== 'entity_person') {
      res.status(404).json({ error: 'not found' }); return;
    }
    const isOwner = page.userId === req.user!.id;
    const isAdmin = !!req.user!.isAdmin;
    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'admin or owner required' }); return;
    }
    const updated = await enrichEntityPage(req.user!.clientNumber, id);
    res.json({ ok: true, updated });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Import flows ─────────────────────────────────────────────────

/**
 * Import contacts from the user's connected Google account. Per-user —
 * each user pulls from their own Google address book using their own
 * OAuth token. Returns counts so the UI can render a result toast.
 */
router.post('/import/google', async (req: Request, res: Response) => {
  try {
    const result = await syncAllContactsFromGoogle(req.user!.clientNumber, req.user!.id);
    res.json({ ok: !result.error, result });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * Import contacts from the user's connected Outlook (Microsoft Graph)
 * account. Uses the existing msGraphHelper + OAuth grant.
 */
router.post('/import/microsoft', async (req: Request, res: Response) => {
  try {
    const result = await syncAllContactsFromMicrosoft(req.user!.clientNumber, req.user!.id);
    res.json({ ok: !result.error, result });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * Manual contact entry. Body: { name, email?, phone?, role?, organization?,
 * notes?, forceTenantShared? (admin-only) }. Returns the created/updated
 * entity id.
 */
router.post('/manual', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const forceTenantShared = !!body.forceTenantShared;
    if (forceTenantShared && !req.user!.isAdmin) {
      res.status(403).json({ error: 'forceTenantShared requires admin role' });
      return;
    }
    const { id, created } = await createManualContact({
      clientNumber: req.user!.clientNumber,
      actorUserId: req.user!.id,
      name: String(body.name ?? '').trim(),
      email: body.email ?? null,
      phone: body.phone ?? null,
      role: body.role ?? null,
      organization: body.organization ?? null,
      notes: body.notes ?? null,
      forceTenantShared,
    });
    res.status(created ? 201 : 200).json({ id, created });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

/**
 * POST /contacts/cleanup-junk
 *
 * Two-step ergonomics matching the Open Items Smart cleanup pattern:
 *   - dryRun: true   → return preview { total, samples[] } without
 *                       changing anything. UI shows "About to archive
 *                       N contacts" banner.
 *   - dryRun: false  → archive flagged rows. Reversible: status flips
 *                       from 'active' → 'archived'; flipping back via
 *                       SQL or future "Show archived" view restores.
 *
 * Tenant-scoped — only operates on the caller's tenant. Admin role NOT
 * required: any user can clean their own visible contacts (the listing
 * filter already scopes by user/tenant visibility).
 *
 * Conservative criteria — uses isLikelyAutomated() pattern checks, the
 * same gate that blocks NEW junk on auto-discovery. We do NOT use the
 * signal-based shouldCreateContact pass-2 here because that would
 * archive low-frequency real contacts the user hasn't replied to yet.
 */
router.post('/cleanup-junk', async (req: Request, res: Response) => {
  const dryRun = (req.body?.dryRun ?? true) === true;
  try {
    const { isLikelyAutomated } = await import('../services/knowledge/senderQualityFilter');
    const prismaClient = (await import('../db/prisma')).default;
    // Caller's own emails — used to flag self-contact rows (a user
    // shouldn't appear in their own contacts list).
    const me = await prismaClient.user.findUnique({
      where: { id: req.user!.id },
      select: { email: true, integrationEmail: true } as any,
    }).catch(() => null) as { email?: string | null; integrationEmail?: string | null } | null;
    const myEmails = new Set(
      [me?.email, me?.integrationEmail]
        .map((e) => (e ?? '').trim().toLowerCase())
        .filter(Boolean),
    );
    // Pull all active entity_person rows visible to this caller's tenant
    // and OWNED by this caller (user-private contacts).
    const rows = await prismaClient.$queryRawUnsafe<Array<{
      id: string; title: string; user_id: number; metadata: any;
    }>>(
      `SELECT id, title, user_id, metadata
         FROM wiki_pages
        WHERE page_type = 'entity_person'
          AND status = 'active'
          AND client_number = $1`,
      req.user!.clientNumber,
    );
    const flagged: Array<{ id: string; title: string; email: string; reason: string }> = [];
    for (const r of rows) {
      const email = String(r.metadata?.email ?? '').trim().toLowerCase();
      if (!email) continue;
      // Self: archive when this caller's contact row points to their
      // own email. Don't archive other users' contact rows for the
      // caller — those are legit (Asad's contact list might include
      // basit, that's fine).
      if (r.user_id === req.user!.id && myEmails.has(email)) {
        flagged.push({ id: r.id, title: r.title, email, reason: 'self_contact' });
      } else if (isLikelyAutomated(email)) {
        flagged.push({ id: r.id, title: r.title, email, reason: 'junk_filter' });
      }
    }
    if (dryRun) {
      res.json({
        total: flagged.length,
        samples: flagged.slice(0, 50).map(({ title, email }) => ({ title, email })),
      });
      return;
    }
    // Apply — soft-archive each flagged row. Stamp metadata so we know
    // why and when, so a future "show archived" UI can render it.
    let archived = 0;
    for (const f of flagged) {
      try {
        await prismaClient.$executeRawUnsafe(
          `UPDATE wiki_pages
              SET status = 'archived',
                  last_updated_at = NOW(),
                  last_updated_by = $1,
                  metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
            WHERE id = $3`,
          'contacts_cleanup_user',
          JSON.stringify({
            archivedReason: f.reason,
            archivedAt: new Date().toISOString(),
            archivedBy: req.user!.id,
            archivedEmail: f.email,
          }),
          f.id,
        );
        archived += 1;
      } catch (err: any) {
        void err;
      }
    }
    res.json({ total: flagged.length, archived });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sweep', requireAdmin, async (req: Request, res: Response) => {
  // Admin-only: trigger the full tenant sweep right now (out of cycle).
  // Safe to call repeatedly — sweep is idempotent on signature.
  try {
    const days = Math.min(parseInt(String((req.body ?? {}).lookbackDays ?? '30'), 10) || 30, 90);
    const result = await sweepForTenant(req.user!.clientNumber, { lookbackDays: days });
    res.json({ ok: true, result });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

function projectListItem(row: any, userId: number) {
  const meta = row.metadata ?? {};
  const userStars = (meta.user_stars ?? {}) as Record<string, number>;
  const stars = Math.max(0, Math.min(5, Math.floor(Number(userStars[String(userId)] ?? 0))));
  return {
    id: row.id,
    title: row.title,
    lastUpdatedAt: row.lastUpdatedAt,
    status: row.status,
    confidence: row.confidence,
    email: meta.email ?? null,
    phone: meta.phone ?? null,
    scope: meta.scope ?? 'user',
    // Ownership signal so the UI can render Make Public / Make
    // Private only on contacts the current user owns.
    ownerUserId: row.userId ?? null,
    isOwner: row.userId === userId,
    importedFrom: meta.imported_from ?? meta.source ?? 'auto_discovered',
    // Channels this sender has appeared on (gmail / whatsapp / gcal /
    // outlook / slack …). Drives the source pill rendering — for an
    // auto-discovered contact we show the actual channel(s), not just
    // a generic "Auto" label.
    channels: Array.isArray(meta.channels) ? meta.channels : [],
    stars,
    relationshipStrength: meta.stats?.relationshipStrength ?? null,
    weeklyVolume: meta.stats?.weeklyVolume ?? null,
    lastSeen: meta.stats?.lastSeen ?? null,
    lastEnrichedAt: meta.last_enriched_at ?? null,
  };
}

export default router;
