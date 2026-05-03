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
    // Sort: recent | stars (default: stars desc when filter applied, else recent)
    const sort = String(req.query.sort ?? '').trim();

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
      `SELECT id, title, last_updated_at AS "lastUpdatedAt", status, confidence,
              metadata, user_id AS "userId"
         FROM wiki_pages
        WHERE client_number = $1
          AND page_type = 'entity_person'
          AND status <> 'deleted'
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

    if (sort === 'stars' || (sort === '' && minStars > 0)) {
      projected.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0)
        || new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());
    }

    const total = projected.length;
    const paged = projected.slice(offset, offset + limit);
    res.json({ count: paged.length, total, entities: paged });
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
