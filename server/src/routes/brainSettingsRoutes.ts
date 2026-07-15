/**
 * brainSettingsRoutes — REST endpoints for the user's Brain Settings UI.
 *
 * Quality Sprint 5d (2026-05-21). Surfaces three categories of Brain
 * state for user review and curation:
 *
 *   - Memories (preferences Brain remembers across sessions)
 *       GET    /memories         — list applicable + pending inferred
 *       POST   /memories         — manually add an explicit memory
 *       PATCH  /memories/:key    — edit value / confirm an inferred one
 *       DELETE /memories/:key    — dismiss
 *
 *   - Persons (cross-channel identities)
 *       GET    /persons          — list with facets
 *       GET    /persons/:id      — detail
 *       POST   /persons/merge    — manual merge {primaryId, secondaryId}
 *       DELETE /persons/:id      — delete (cascades facets)
 *
 *   - Action artifacts (what Brain has done recently)
 *       GET    /artifacts        — list, filterable by channel + hours
 *
 *   - Reflection trigger (admin-grade)
 *       POST   /reflect-now      — run reflection job for current user
 *
 * All routes require the existing auth middleware. Operations are
 * scoped to (req.user.id, req.user.clientNumber).
 */
import { Router, Request, Response } from 'express';
import prisma from '../db/prisma';
import {
  recordExplicitMemory,
  dismissMemory,
  getApplicableMemories,
} from '../services/knowledge/userMemoryService';
import {
  findPersonsByName,
  getPersonWithFacets,
  mergePersons,
} from '../services/knowledge/personService';
import { listRecentArtifacts } from '../services/knowledge/brainActionArtifactService';
import { runReflectionForUser } from '../jobs/reflectionJob';

const router = Router();

router.use((req: Request, res: Response, next) => {
  if (!(req as any).user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  next();
});

// ─── Memories ────────────────────────────────────────────────────

router.get('/memories', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    // Applicable memories (explicit + confirmed-inferred + system) are
    // what Brain currently uses. Also surface pending inferred memories
    // so the user can confirm or dismiss them.
    const applicable = await getApplicableMemories(user.id);
    const pending = await prisma.$queryRawUnsafe<Array<any>>(
      `SELECT id, key, value, category, source, confidence, created_at AS "createdAt"
         FROM user_memories
        WHERE user_id = $1 AND source = 'inferred' AND confirmed_at IS NULL
        ORDER BY confidence DESC, created_at DESC
        LIMIT 50`,
      user.id,
    ).catch(() => [] as any[]);
    res.json({ applicable, pendingInferred: pending });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

router.post('/memories', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { key, value, category } = req.body ?? {};
    if (typeof key !== 'string' || !key.trim()) return res.status(400).json({ error: 'key required' });
    if (value === undefined || value === null) return res.status(400).json({ error: 'value required' });
    const saved = await recordExplicitMemory({
      clientNumber: user.clientNumber,
      userId: user.id,
      key: key.trim(),
      value,
      category,
    });
    res.json({ memory: saved });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

router.patch('/memories/:key', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const key = String(req.params.key ?? '');
    const { value, confirm } = req.body ?? {};
    if (confirm) {
      // Confirm a pending inferred memory — flips confirmedAt to NOW.
      const updated = await prisma.$queryRawUnsafe<Array<any>>(
        `UPDATE user_memories SET confirmed_at = NOW(), source = 'explicit', confidence = 1.0, updated_at = NOW()
          WHERE user_id = $1 AND key = $2 RETURNING *`,
        user.id, key,
      );
      return res.json({ memory: updated[0] ?? null });
    }
    // Edit value of an existing memory.
    if (value === undefined || value === null) return res.status(400).json({ error: 'value or confirm required' });
    const saved = await recordExplicitMemory({
      clientNumber: user.clientNumber,
      userId: user.id,
      key,
      value,
    });
    res.json({ memory: saved });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

router.delete('/memories/:key', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    await dismissMemory(user.id, String(req.params.key ?? ''));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

// ─── Persons ─────────────────────────────────────────────────────

router.get('/persons', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const search = String(req.query.q ?? '').trim();
    if (search) {
      const rows = await findPersonsByName(user.id, search, 50);
      return res.json({ persons: rows });
    }
    // No search — list most-recently-updated 50.
    const all = await prisma.$queryRawUnsafe<Array<any>>(
      `SELECT p.id, p.display_name AS "displayName", p.canonical_name AS "canonicalName",
              p.updated_at AS "updatedAt",
              (SELECT COUNT(*) FROM person_facets pf WHERE pf.person_id = p.id) AS "facetCount"
         FROM persons p
        WHERE p.user_id = $1
        ORDER BY p.updated_at DESC
        LIMIT 50`,
      user.id,
    );
    res.json({ persons: all });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

router.get('/persons/:id', async (req: Request, res: Response) => {
  try {
    const person = await getPersonWithFacets(String(req.params.id ?? ''));
    if (!person) return res.status(404).json({ error: 'not found' });
    const user = (req as any).user;
    if (person.userId !== user.id) return res.status(403).json({ error: 'forbidden' });
    res.json({ person });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

router.post('/persons/merge', async (req: Request, res: Response) => {
  try {
    const { primaryId, secondaryId } = req.body ?? {};
    if (!primaryId || !secondaryId) return res.status(400).json({ error: 'primaryId + secondaryId required' });
    const user = (req as any).user;
    // Confirm both belong to this user before merging.
    const [p, s] = await Promise.all([
      getPersonWithFacets(primaryId),
      getPersonWithFacets(secondaryId),
    ]);
    if (!p || !s) return res.status(404).json({ error: 'one or both not found' });
    if (p.userId !== user.id || s.userId !== user.id) return res.status(403).json({ error: 'forbidden' });
    await mergePersons(primaryId, secondaryId);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

router.delete('/persons/:id', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const person = await getPersonWithFacets(String(req.params.id ?? ''));
    if (!person) return res.status(404).json({ error: 'not found' });
    if (person.userId !== user.id) return res.status(403).json({ error: 'forbidden' });
    await (prisma as any).person.delete({ where: { id: String(req.params.id ?? '') } });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

// ─── Action artifacts ────────────────────────────────────────────

router.get('/artifacts', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const hours = Math.min(168, Math.max(1, Number(req.query.hours ?? 24)));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const channel = req.query.channel === 'whatsapp' || req.query.channel === 'web'
      ? (req.query.channel as 'web' | 'whatsapp')
      : undefined;
    const artifacts = await listRecentArtifacts({ userId: user.id, channel, hours, limit });
    res.json({ artifacts });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

// ─── Reflection trigger ──────────────────────────────────────────

router.post('/reflect-now', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const result = await runReflectionForUser(user.id, user.clientNumber);
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

export default router;
