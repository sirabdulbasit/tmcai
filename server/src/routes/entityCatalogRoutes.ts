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
    // 2026-05-13 rule: phone-only contacts cannot become Public.
    // Mirrors the guard in PATCH /:id/scope.
    const hasEmail = typeof meta.email === 'string' && (meta.email as string).trim() !== '';
    if (!hasEmail) {
      res.status(400).json({
        error: 'WhatsApp / phone-only contacts cannot be made Public. Add an email identifier first.',
      });
      return;
    }
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
    try {
      const { invalidateBrainMuteCache } = await import('../services/knowledge/brainMuteService');
      invalidateBrainMuteCache(req.user!.clientNumber, (page as any).userId);
    } catch { /* non-critical */ }
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
    // 2026-05-13 three-state model: /unpublish flips back to 'normal'
    // (was 'user' which meant the same thing — kept as compat alias on
    // read via projectListItem until migration runs).
    const next: Record<string, unknown> = { ...meta, scope: 'normal' };
    delete next.publicSince;
    delete next.publicSetBy;
    next.unpublishedAt = new Date().toISOString();
    next.unpublishedBy = req.user!.id;
    await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages SET metadata = $1::jsonb, last_updated_at = NOW() WHERE id = $2`,
      JSON.stringify(next), id,
    );
    try {
      const { invalidateBrainMuteCache } = await import('../services/knowledge/brainMuteService');
      invalidateBrainMuteCache(req.user!.clientNumber, (page as any).userId);
    } catch { /* non-critical */ }
    res.json({ id, scope: 'normal' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * PATCH /:id/scope  — unified scope setter (2026-05-13 three-state model)
 *  Body: { scope: 'private' | 'normal' | 'tenant' }
 *
 * One endpoint, three states. Replaces the two-button publish/unpublish
 * model (those endpoints stay as compat wrappers for callers that still
 * use them — both ultimately update metadata.scope).
 *
 * Semantics:
 *   - 'private': Brain ignores this contact entirely — out of My
 *                Attention, no WhatsApp brain processing, no Day Brief
 *                surfacing, no Open Items extraction. Owner still sees
 *                the row in Contacts.
 *   - 'normal' : default for every auto-discovered contact. Owner-only
 *                visibility; Brain processes interactions normally.
 *   - 'tenant' : visible to every user in the tenant + Brain on.
 *                Owner identity recorded in publicSetBy/publicSince
 *                so any teammate can see who shared it.
 *
 * Auth: owner-or-admin. Per the 2026-05-13 contacts-visibility-is-
 * user-decided rule, Brain MUST NOT auto-call this endpoint.
 */
router.patch('/:id/scope', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const requested = String((req.body ?? {}).scope ?? '').trim().toLowerCase();
    if (requested !== 'private' && requested !== 'normal' && requested !== 'tenant') {
      res.status(400).json({ error: "scope must be one of 'private' | 'normal' | 'tenant'" });
      return;
    }
    const page = await prisma.wikiPage.findUnique({
      where: { id },
      select: { clientNumber: true, pageType: true, userId: true, metadata: true },
    });
    if (!page || page.clientNumber !== req.user!.clientNumber || page.pageType !== 'entity_person') {
      res.status(404).json({ error: 'not found' }); return;
    }
    const isOwner = (page as any).userId === req.user!.id;
    if (!isOwner && !req.user!.isAdmin) {
      res.status(403).json({ error: 'only the contact owner or a tenant admin can change scope' }); return;
    }
    const meta = ((page.metadata as Record<string, unknown> | null) ?? {});
    // 2026-05-13 rule: WhatsApp-only contacts (phone, no email) cannot
    // be made Public. A phone number is a personal identifier; sharing
    // it across the tenant doesn't have the same legitimacy as sharing
    // a work email. Private is still allowed — Brain-mute applies
    // regardless of channel. Normal is also fine.
    const hasEmail = typeof meta.email === 'string' && (meta.email as string).trim() !== '';
    if (requested === 'tenant' && !hasEmail) {
      res.status(400).json({
        error: 'WhatsApp / phone-only contacts cannot be made Public. Add an email identifier first, or keep it Normal/Private.',
      });
      return;
    }
    const next: Record<string, unknown> = { ...meta, scope: requested };
    const nowIso = new Date().toISOString();
    if (requested === 'tenant') {
      next.publicSince = meta.publicSince ?? nowIso;
      next.publicSetBy = meta.publicSetBy ?? req.user!.id;
      delete next.brainMutedAt;
      delete next.brainMutedBy;
    } else if (requested === 'private') {
      // Mute audit — useful for "you muted Brain on this contact"
      // breadcrumbs and for restoring Private on reset-and-rebuild.
      next.brainMutedAt = meta.brainMutedAt ?? nowIso;
      next.brainMutedBy = meta.brainMutedBy ?? req.user!.id;
      delete next.publicSince;
      delete next.publicSetBy;
    } else {
      // 'normal' — clear both Public and Private audit fields.
      delete next.publicSince;
      delete next.publicSetBy;
      delete next.brainMutedAt;
      delete next.brainMutedBy;
      next.unpublishedAt = nowIso;
      next.unpublishedBy = req.user!.id;
    }
    await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages SET metadata = $1::jsonb, last_updated_at = NOW() WHERE id = $2`,
      JSON.stringify(next), id,
    );
    // Bust the muted-senders cache so the next Brain pipeline read
    // sees the new state (the cache TTL is 30s — too slow if the user
    // just clicked Private and immediately reopens My Attention).
    try {
      const { invalidateBrainMuteCache } = await import('../services/knowledge/brainMuteService');
      invalidateBrainMuteCache(req.user!.clientNumber, (page as any).userId);
    } catch { /* non-critical */ }
    res.json({ id, scope: requested });
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
 * POST /entity-catalog/smart-cleanup
 *
 * Brain's autonomous contact maintenance. Replaces the old cleanup-junk
 * endpoint (which only handled isLikelyAutomated patterns). Now also:
 *   - Repoints cross-user-leaked rows (evidence-based ownership)
 *   - Archives no-evidence rows (no feed + no user action + grace expired)
 *   - Surfaces merge candidates (same email/phone, distinct rows)
 *   - Applies isLikelyAutomated junk filter (legacy behaviour)
 *
 * Two-step: dryRun:true returns a plan, dryRun:false applies it.
 * Per-user — only operates on the caller's tenant; ownership decisions
 * are evidence-based so other users' contacts can't be touched without
 * actual feed_events backing the move.
 */
router.post('/smart-cleanup', async (req: Request, res: Response) => {
  try {
    const dryRun = (req.body?.dryRun ?? true) === true;
    const { runSmartCleanupForUser } = await import('../services/knowledge/smartCleanupService');
    const result = await runSmartCleanupForUser(
      req.user!.clientNumber,
      req.user!.id,
      { dryRun, cronMode: false },
    );
    res.json({
      dryRun,
      ...result,
      // For UI banner — keep the existing 'samples' shape for back-compat
      // with ContactsPage's cleanupPreview state.
      total: result.leakedRepointed + result.leakedArchivedDuplicate
           + result.noEvidenceArchived + result.junkArchived,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /entity-catalog/cleanup-junk — legacy alias for /smart-cleanup.
 * Existing clients keep working; new clients should call smart-cleanup
 * directly. (TODO: remove after 2026-07-01 once UI is fully migrated.)
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
    // Three-state visibility (2026-05-13 model):
    //   'private' = Brain-muted, owner-only
    //   'normal'  = default, Brain processes, owner-only
    //   'tenant'  = Brain processes, visible to whole tenant
    // Legacy rows have scope='user' — treat as 'normal' until migrated.
    scope: ((): 'private' | 'normal' | 'tenant' => {
      const raw = String(meta.scope ?? 'normal');
      if (raw === 'tenant' || raw === 'private') return raw;
      return 'normal';
    })(),
    // linkedPersonId — when multiple wiki rows represent the same
    // person (e.g. work email + personal email + phone), they share
    // this id. UI groups them under one collapsible header; each row
    // keeps its own scope so the user can share work email publicly
    // while keeping the personal one private.
    linkedPersonId: meta.linkedPersonId ?? null,
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

/**
 * POST /entity-catalog/link
 *  Body: { ids: string[] }
 *
 * Link multiple entity_person wiki rows under a shared linkedPersonId,
 * so the UI groups them as one logical person (e.g. work email +
 * personal email + phone are three rows for one person). Each row
 * keeps its own scope/stars; the link is purely identity-grouping.
 *
 * If any of the supplied rows already has a linkedPersonId, that id
 * becomes the canonical group id and the others adopt it. This way
 * adding a 4th identifier to an existing group is a single call.
 *
 * Ownership rule: caller must own (or be tenant admin for) every row
 * in the group — you can't link someone else's contacts.
 */
router.post('/link', async (req: Request, res: Response) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids)
      ? (req.body.ids as unknown[]).map((x) => String(x))
      : [];
    if (ids.length < 2) {
      res.status(400).json({ error: 'need at least 2 ids to link' });
      return;
    }
    const rows = await prisma.wikiPage.findMany({
      where: { id: { in: ids }, clientNumber: req.user!.clientNumber, pageType: 'entity_person' } as any,
      select: { id: true, userId: true, metadata: true },
    });
    if (rows.length !== ids.length) {
      res.status(404).json({ error: 'one or more rows not found in your tenant' });
      return;
    }
    if (!req.user!.isAdmin) {
      const notOwned = rows.find((r) => (r as any).userId !== req.user!.id);
      if (notOwned) {
        res.status(403).json({ error: 'you can only link contacts you own' });
        return;
      }
    }
    // Reuse existing linkedPersonId if any row already has one;
    // otherwise mint a fresh one.
    let groupId: string | null = null;
    for (const r of rows) {
      const m = (r.metadata as any) ?? {};
      if (typeof m.linkedPersonId === 'string' && m.linkedPersonId) {
        groupId = m.linkedPersonId;
        break;
      }
    }
    if (!groupId) {
      // cuid-ish: 16 hex chars is plenty for tenant-scoped uniqueness
      groupId = `lpg_${Math.random().toString(16).slice(2, 10)}${Date.now().toString(36)}`;
    }
    const linkedAt = new Date().toISOString();
    for (const r of rows) {
      const m = ((r.metadata as Record<string, unknown> | null) ?? {});
      const next = { ...m, linkedPersonId: groupId, linkedAt };
      await prisma.$executeRawUnsafe(
        `UPDATE wiki_pages SET metadata = $1::jsonb, last_updated_at = NOW() WHERE id = $2`,
        JSON.stringify(next), r.id,
      );
    }
    res.json({ ok: true, linkedPersonId: groupId, count: rows.length });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * DELETE /entity-catalog/:id
 *  Body: { confirmPhrase: string }
 *
 * Hard delete a single contact. Distinct from PATCH /:id/inactive
 * which is sticky (won't recreate from feed). Hard delete removes
 * the wiki_page row entirely so a future feed event from the same
 * sender WILL create a fresh row.
 *
 * Destructive — requires typed-phrase confirmation (user types the
 * contact's title) to prevent misclicks.
 *
 * Owner-or-admin gate. Sender_history pages that referenced this
 * entityId get their entityId field nulled (kept around for search;
 * just unlinked from a deleted person).
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const confirmPhrase = String((req.body ?? {}).confirmPhrase ?? '').trim();
    const page = await prisma.wikiPage.findUnique({
      where: { id },
      select: { id: true, clientNumber: true, pageType: true, userId: true, title: true },
    });
    if (!page || page.clientNumber !== req.user!.clientNumber || page.pageType !== 'entity_person') {
      res.status(404).json({ error: 'not found' }); return;
    }
    if ((page as any).userId !== req.user!.id && !req.user!.isAdmin) {
      res.status(403).json({ error: 'you can only delete contacts you own' }); return;
    }
    const expected = String(page.title || '').toLowerCase();
    if (!confirmPhrase || confirmPhrase.toLowerCase() !== expected) {
      res.status(400).json({
        error: 'confirmPhrase must match the contact title to confirm delete',
        expected,
      });
      return;
    }
    // Unlink sender_history pages so they don't point at a deleted entity.
    await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages
         SET metadata = jsonb_set(metadata, '{entityId}', 'null'::jsonb)
       WHERE client_number = $1
         AND page_type IN ('sender_history','sender_topic')
         AND metadata->>'entityId' = $2`,
      req.user!.clientNumber, id,
    ).catch(() => null);
    // Hard delete the wiki_page row + cascade related (entity, etc.).
    await prisma.$executeRawUnsafe(`DELETE FROM wiki_pages WHERE id = $1`, id).catch(() => null);
    res.json({ ok: true, deleted: id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /entity-catalog/reclaim-ownership
 *  Body: { confirmPhrase: string }
 *
 * Take ownership of every entity_person row in the tenant that the
 * caller can see. After this call, the requesting user is the user_id
 * on every contact they had visibility on — so the ScopeSelector
 * (gated on isOwner in the UI) renders for all of them and they can
 * mark Public / Private / Normal across the full list.
 *
 * Why this exists: contacts created BEFORE the reset-and-rebuild
 * forceOwnerUserId fix (or before this user existed) belong to
 * legacy / system users. Visibility was correct via discovered_by_users,
 * but the user had no scope-change agency. This endpoint is the
 * one-shot fix; future resets handle it automatically via
 * forceOwnerUserId.
 *
 * Safety:
 *  - Typed-phrase confirmation = login email
 *  - Only operates on entity_person rows the caller could already see
 *    (visibility query inherited from list endpoint)
 *  - In a multi-Brain-user tenant, this WILL take rows from teammates
 *    who own them. The endpoint is owner-or-admin-only and the typed
 *    phrase is the safeguard. For Basit's single-user tenant this is
 *    a no-op concern; flagged here for future hardening.
 */
router.post('/reclaim-ownership', async (req: Request, res: Response) => {
  try {
    const confirmPhrase = String((req.body ?? {}).confirmPhrase ?? '').trim().toLowerCase();
    const me = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { email: true },
    });
    const expected = String(me?.email ?? '').toLowerCase();
    if (!confirmPhrase || confirmPhrase !== expected) {
      res.status(400).json({
        error: 'confirmPhrase must match your login email to confirm reclaim',
        expected,
      });
      return;
    }
    // Take ownership of every entity_person row in the tenant the
    // user has visibility on:
    //   · already-owned rows (no-op)
    //   · tenant-shared rows (scope='tenant')
    //   · rows where the user is in discovered_by_users
    // Done as a single UPDATE with a UNION-equivalent WHERE.
    const userIdJson = JSON.stringify([req.user!.id]);
    const updated = await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages
          SET user_id = $2,
              last_updated_at = NOW()
        WHERE client_number = $1
          AND page_type = 'entity_person'
          AND status NOT IN ('inactive','deleted')
          AND (
                user_id = $2
                OR metadata->>'scope' = 'tenant'
                OR metadata @> $3::jsonb
              )`,
      req.user!.clientNumber, req.user!.id,
      JSON.stringify({ discovered_by_users: JSON.parse(userIdJson) }),
    ).catch((e: any) => { throw e; });
    res.json({ ok: true, reclaimed: Number(updated) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /entity-catalog/reset-and-rebuild
 *  Body: { confirmPhrase: string, lookbackDays?: number }
 *
 * Nuke + rebuild: deletes EVERY entity_person wiki_page this user owns,
 * then re-runs sweepForTenant which re-discovers contacts from the
 * user's feed_events (gmail / whatsapp / etc.). Useful when contacts
 * have accumulated cruft and you want Brain to rebuild its view of
 * who you've been corresponding with.
 *
 * Destructive — requires typed phrase. Caller types their own login
 * email as confirmation (something they know that no misclick produces).
 *
 * Per the user 2026-05-13 feed-dedup principle: the rebuild goes
 * through ensureEntityForSender which now content-matches by phone/
 * email before insert, so the rebuild won't recreate duplicates.
 */
router.post('/reset-and-rebuild', async (req: Request, res: Response) => {
  try {
    const confirmPhrase = String((req.body ?? {}).confirmPhrase ?? '').trim().toLowerCase();
    const lookbackDays = Math.max(7, Math.min(365, Number((req.body ?? {}).lookbackDays ?? 90)));
    const me = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { email: true },
    });
    const expected = String(me?.email ?? '').toLowerCase();
    if (!confirmPhrase || confirmPhrase !== expected) {
      res.status(400).json({
        error: 'confirmPhrase must match your login email to confirm reset',
        expected,
      });
      return;
    }
    // Snapshot every explicit scope choice BEFORE delete (both Public
    // AND Brain-muted Private) so we can restore them on the rebuilt
    // rows. classifyScope() always returns 'normal' for auto-discovery,
    // so without this every contact would come back Normal — losing
    // the user's manual Make-Public / Make-Private opt-ins.
    //
    // Match by metadata.email or metadata.phone — those are stable
    // across wipe/rebuild because they're sourced from feed_events.
    const scopeSnapshot = await prisma.$queryRawUnsafe<Array<{
      email: string | null; phone: string | null;
      scope: 'tenant' | 'private';
      publicSince: string | null; publicSetBy: number | null;
      brainMutedAt: string | null; brainMutedBy: number | null;
    }>>(
      `SELECT lower(metadata->>'email')         AS email,
              metadata->>'phone'                AS phone,
              metadata->>'scope'                AS scope,
              metadata->>'publicSince'          AS "publicSince",
              (metadata->>'publicSetBy')::int   AS "publicSetBy",
              metadata->>'brainMutedAt'         AS "brainMutedAt",
              (metadata->>'brainMutedBy')::int  AS "brainMutedBy"
         FROM wiki_pages
        WHERE client_number = $1
          AND user_id = $2
          AND page_type = 'entity_person'
          AND metadata->>'scope' IN ('tenant', 'private')`,
      req.user!.clientNumber, req.user!.id,
    ).catch(() => [] as any[]);
    // Count + delete current user-owned entity_person rows.
    const deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM wiki_pages
        WHERE client_number = $1
          AND user_id = $2
          AND page_type = 'entity_person'`,
      req.user!.clientNumber, req.user!.id,
    ).catch(() => 0);
    // Run a fresh sweep for the tenant. This walks recent feed_events
    // and calls ensureEntityForSender per unique sender. With the
    // cc7bb4d content-dedup in place, no duplicates get recreated.
    //
    // forceOwnerUserId: the resetting user becomes the owner of every
    // rebuilt row (new AND content-dedup matches). Without this,
    // pre-existing rows owned by system/legacy users would survive
    // the reset and the requesting user wouldn't see the scope
    // selector on them — that was the 2026-05-13 "auto / gmail /
    // google" pattern Basit hit.
    const r = await sweepForTenant(req.user!.clientNumber, {
      lookbackDays,
      forceOwnerUserId: req.user!.id,
    })
      .catch((e: any) => ({ scanned: 0, created: 0, enriched: 0, errors: 1, error: e.message }));
    // Restore explicit Public AND Private opt-ins onto the rebuilt
    // rows. We carry the audit fields too (publicSince/publicSetBy for
    // tenant rows, brainMutedAt/brainMutedBy for private rows) so the
    // history doesn't get reset along with the row data.
    let publicRestored = 0;
    let privateRestored = 0;
    for (const snap of scopeSnapshot) {
      const email = snap.email ? snap.email.toLowerCase() : null;
      const phone = snap.phone ? snap.phone.replace(/[^\d+]/g, '') : null;
      if (!email && !phone) continue;
      const isPrivate = snap.scope === 'private';
      const auditPatch = isPrivate
        ? `jsonb_build_object(
             'scope', 'private',
             'brainMutedAt', COALESCE($3, metadata->>'brainMutedAt', NOW()::text),
             'brainMutedBy', COALESCE($4::int, (metadata->>'brainMutedBy')::int)
           )`
        : `jsonb_build_object(
             'scope', 'tenant',
             'publicSince', COALESCE($3, metadata->>'publicSince', NOW()::text),
             'publicSetBy', COALESCE($4::int, (metadata->>'publicSetBy')::int)
           )`;
      const updated = await prisma.$executeRawUnsafe(
        `UPDATE wiki_pages
            SET metadata = metadata || ${auditPatch},
                last_updated_at = NOW()
          WHERE client_number = $1
            AND page_type = 'entity_person'
            AND (
                  ($2 <> '' AND lower(metadata->>'email') = $2)
                  OR ($5 <> '' AND regexp_replace(coalesce(metadata->>'phone',''),'[^0-9+]','','g') = $5)
                )`,
        req.user!.clientNumber,
        email ?? '',
        isPrivate ? snap.brainMutedAt : snap.publicSince,
        isPrivate ? snap.brainMutedBy : snap.publicSetBy,
        phone ?? '',
      ).catch(() => 0);
      const n = Number(updated) || 0;
      if (isPrivate) privateRestored += n; else publicRestored += n;
    }
    res.json({
      ok: true,
      deleted: Number(deleted),
      rebuilt: (r as any).created ?? 0,
      scanned: (r as any).scanned ?? 0,
      publicRestored,
      privateRestored,
      scopeSnapshotSize: scopeSnapshot.length,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /entity-catalog/merge
 *  Body: { primaryId: string, secondaryIds: string[], confirmPhrase: string }
 *
 * Collapse one or more secondary contact rows INTO a primary row.
 * After merge:
 *   - Secondary rows are DELETED.
 *   - Primary keeps its existing identifiers; fills email/phone from
 *     secondaries if it was missing them.
 *   - Stars become max across all rows (per-user user_stars maps merged).
 *   - Channels become union of all rows' channel lists.
 *   - discovered_by_users become union.
 *   - sender_history pages whose metadata.entityId references any
 *     secondary row get repointed at the primary id (so per-sender
 *     history stays intact and queryable from the surviving row).
 *
 * Destructive. Requires a typed-phrase confirmation (the user must
 * echo the primary's title) so a misclick can't silently delete
 * legitimate records.
 *
 * Owner-or-admin on every row (you can't merge someone else's
 * contacts).
 */
router.post('/merge', async (req: Request, res: Response) => {
  try {
    const primaryId = String(req.body?.primaryId ?? '').trim();
    const secondaryIds: string[] = Array.isArray(req.body?.secondaryIds)
      ? (req.body.secondaryIds as unknown[]).map((x) => String(x)).filter((x) => x && x !== primaryId)
      : [];
    const confirmPhrase = String(req.body?.confirmPhrase ?? '').trim();
    if (!primaryId || secondaryIds.length === 0) {
      res.status(400).json({ error: 'primaryId + at least one secondaryId required' });
      return;
    }
    const allIds = [primaryId, ...secondaryIds];
    const rows = await prisma.wikiPage.findMany({
      where: { id: { in: allIds }, clientNumber: req.user!.clientNumber, pageType: 'entity_person' } as any,
      select: { id: true, title: true, userId: true, metadata: true, bodyMarkdown: true, status: true },
    });
    if (rows.length !== allIds.length) {
      res.status(404).json({ error: 'one or more rows not found in your tenant' });
      return;
    }
    const primary = rows.find((r) => r.id === primaryId);
    if (!primary) { res.status(404).json({ error: 'primary not found' }); return; }
    // Ownership gate — caller must own every row (or be tenant admin).
    if (!req.user!.isAdmin) {
      const notOwned = rows.find((r) => (r as any).userId !== req.user!.id);
      if (notOwned) {
        res.status(403).json({ error: 'you can only merge contacts you own' });
        return;
      }
    }
    // Typed-phrase confirmation — destructive op, prevent misclick.
    const expected = String(primary.title || '').toLowerCase();
    if (!confirmPhrase || confirmPhrase.toLowerCase() !== expected) {
      res.status(400).json({
        error: 'confirmPhrase must match the primary contact title to confirm merge',
        expected,
      });
      return;
    }

    // Build merged metadata.
    const primaryMeta = ((primary.metadata as Record<string, unknown> | null) ?? {});
    const secondaries = rows.filter((r) => r.id !== primaryId);
    let mergedEmail = (primaryMeta as any).email ?? null;
    let mergedPhone = (primaryMeta as any).phone ?? null;
    const channelsSet = new Set<string>(Array.isArray((primaryMeta as any).channels) ? (primaryMeta as any).channels : []);
    const discoverersSet = new Set<number>(Array.isArray((primaryMeta as any).discovered_by_users) ? (primaryMeta as any).discovered_by_users : []);
    const userStars: Record<string, number> = { ...((primaryMeta as any).user_stars ?? {}) };
    const mergedFromAudit: Array<{ id: string; title: string; mergedAt: string }> = [];
    let bestRelStrength = ((primaryMeta as any).stats?.relationshipStrength as number | null) ?? null;
    let bestWeeklyVolume = ((primaryMeta as any).stats?.weeklyVolume as number | null) ?? null;
    let latestLastSeen: string | null = ((primaryMeta as any).stats?.lastSeen as string | null) ?? null;

    for (const s of secondaries) {
      const sm = ((s.metadata as Record<string, unknown> | null) ?? {}) as any;
      if (!mergedEmail && sm.email) mergedEmail = sm.email;
      if (!mergedPhone && sm.phone) mergedPhone = sm.phone;
      if (Array.isArray(sm.channels)) for (const c of sm.channels) channelsSet.add(String(c));
      if (Array.isArray(sm.discovered_by_users)) for (const u of sm.discovered_by_users) discoverersSet.add(Number(u));
      // user_stars: merge per-user (max if both have a rating for the same user).
      if (sm.user_stars && typeof sm.user_stars === 'object') {
        for (const [uid, val] of Object.entries(sm.user_stars as Record<string, unknown>)) {
          const cur = userStars[uid] ?? 0;
          const next = Math.max(cur, Number(val) || 0);
          if (next > 0) userStars[uid] = next;
        }
      }
      const ss = sm.stats ?? {};
      if (typeof ss.relationshipStrength === 'number' && (bestRelStrength == null || ss.relationshipStrength > bestRelStrength)) {
        bestRelStrength = ss.relationshipStrength;
      }
      if (typeof ss.weeklyVolume === 'number' && (bestWeeklyVolume == null || ss.weeklyVolume > bestWeeklyVolume)) {
        bestWeeklyVolume = ss.weeklyVolume;
      }
      if (typeof ss.lastSeen === 'string' && (!latestLastSeen || ss.lastSeen > latestLastSeen)) {
        latestLastSeen = ss.lastSeen;
      }
      mergedFromAudit.push({ id: s.id, title: s.title, mergedAt: new Date().toISOString() });
    }

    const mergedMeta: Record<string, unknown> = {
      ...primaryMeta,
      email: mergedEmail,
      phone: mergedPhone,
      channels: Array.from(channelsSet),
      discovered_by_users: Array.from(discoverersSet),
      user_stars: userStars,
      stats: {
        ...((primaryMeta as any).stats ?? {}),
        relationshipStrength: bestRelStrength,
        weeklyVolume: bestWeeklyVolume,
        lastSeen: latestLastSeen,
      },
      mergedFrom: [
        ...(Array.isArray((primaryMeta as any).mergedFrom) ? (primaryMeta as any).mergedFrom : []),
        ...mergedFromAudit,
      ],
    };

    // 1. Write the merged metadata onto the primary.
    await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages SET metadata = $1::jsonb, last_updated_at = NOW() WHERE id = $2`,
      JSON.stringify(mergedMeta), primaryId,
    );

    // 2. Repoint sender_history pages that reference any secondary's
    //    entityId to point at the primary. The catalog's "entityId"
    //    convention is the wiki_page id itself (for entity_person rows
    //    where id starts with 'person:') or the Entity table id.
    //    sender_history pages stash entityId in their metadata.
    for (const s of secondaries) {
      await prisma.$executeRawUnsafe(
        `UPDATE wiki_pages
           SET metadata = jsonb_set(metadata, '{entityId}', to_jsonb($1::text))
         WHERE client_number = $2
           AND page_type IN ('sender_history','sender_topic')
           AND metadata->>'entityId' = $3`,
        primaryId, req.user!.clientNumber, s.id,
      ).catch(() => null);
    }

    // 3. Delete the secondary wiki_pages (status=deleted is cleaner
    //    than hard-delete — keeps audit trail and allows recovery if
    //    the merge was wrong). The catalog GET filters status='deleted'
    //    so they disappear from the UI immediately.
    for (const s of secondaries) {
      await prisma.$executeRawUnsafe(
        `UPDATE wiki_pages
           SET status = 'deleted',
               metadata = jsonb_set(metadata, '{mergedInto}', to_jsonb($1::text)),
               last_updated_at = NOW()
         WHERE id = $2`,
        primaryId, s.id,
      ).catch(() => null);
    }

    res.json({
      ok: true,
      primaryId,
      mergedCount: secondaries.length,
      mergedFrom: mergedFromAudit,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /entity-catalog/unlink
 *  Body: { id: string }
 *
 * Remove ONE row from its linked-person group. Other rows in the
 * group remain linked. If only one row remains after this unlink, the
 * link is also stripped from that remaining row (cleanup: a group of
 * 1 is meaningless).
 */
router.post('/unlink', async (req: Request, res: Response) => {
  try {
    const id = String(req.body?.id ?? '').trim();
    if (!id) { res.status(400).json({ error: 'id required' }); return; }
    const row = await prisma.wikiPage.findUnique({
      where: { id },
      select: { clientNumber: true, pageType: true, userId: true, metadata: true },
    });
    if (!row || row.clientNumber !== req.user!.clientNumber || row.pageType !== 'entity_person') {
      res.status(404).json({ error: 'not found' }); return;
    }
    if ((row as any).userId !== req.user!.id && !req.user!.isAdmin) {
      res.status(403).json({ error: 'you can only unlink contacts you own' }); return;
    }
    const meta = ((row.metadata as Record<string, unknown> | null) ?? {});
    const groupId = (meta as any).linkedPersonId as string | undefined;
    if (!groupId) {
      res.json({ ok: true, note: 'already unlinked' });
      return;
    }
    const next = { ...meta };
    delete (next as any).linkedPersonId;
    delete (next as any).linkedAt;
    await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages SET metadata = $1::jsonb, last_updated_at = NOW() WHERE id = $2`,
      JSON.stringify(next), id,
    );
    // Group-of-1 cleanup
    const remaining = await prisma.$queryRawUnsafe<Array<{ id: string; metadata: any }>>(
      `SELECT id, metadata FROM wiki_pages
        WHERE client_number = $1 AND page_type = 'entity_person'
          AND metadata->>'linkedPersonId' = $2`,
      req.user!.clientNumber, groupId,
    ).catch(() => [] as any[]);
    if (remaining.length === 1) {
      const r = remaining[0];
      const m = (r.metadata as any) ?? {};
      delete m.linkedPersonId;
      delete m.linkedAt;
      await prisma.$executeRawUnsafe(
        `UPDATE wiki_pages SET metadata = $1::jsonb, last_updated_at = NOW() WHERE id = $2`,
        JSON.stringify(m), r.id,
      );
    }
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
