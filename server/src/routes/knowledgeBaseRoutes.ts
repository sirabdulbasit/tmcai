// Phase 5: Knowledge base routes (admin + authenticated users)
import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  addKnowledgeItem, searchKnowledgeBase, listKnowledgeItems,
  updateKnowledgeItem, deleteKnowledgeItem,
} from '../services/knowledgeBaseService';
import { getAlerts, markAlertRead } from '../services/proactiveIntelligenceService';

const router = Router();
router.use(requireAuth);

// GET /api/v1/knowledge?category=decision&q=tax
router.get('/', async (req, res) => {
  const cn = req.user!.clientNumber;
  const { q, category } = req.query as Record<string, string>;
  if (q) {
    const results = await searchKnowledgeBase(cn, q, { category: category as any });
    return res.json({ results });
  }
  const items = await listKnowledgeItems(cn, category as any);
  res.json({ items });
});

// POST /api/v1/knowledge/search  (agent-callable, structured body)
router.post('/search', async (req, res) => {
  const cn = req.user!.clientNumber;
  const { query, category, topK } = req.body ?? {};
  if (!query) return res.status(400).json({ error: 'query required' });
  const results = await searchKnowledgeBase(cn, String(query), {
    category: category as any,
    topK: Number.isFinite(topK) ? Number(topK) : undefined,
  } as any);
  res.json({ results });
});

// POST /api/v1/knowledge
router.post('/', async (req, res) => {
  const cn = req.user!.clientNumber;
  const { category, title, content, tags, source, sourceId } = req.body;
  if (!category || !title || !content) {
    return res.status(400).json({ error: 'category, title, content required' });
  }
  const id = await addKnowledgeItem(cn, category, title, content, {
    tags, source, sourceId, createdBy: req.user!.id,
  });
  res.json({ id });
});

// PATCH /api/v1/knowledge/:id
router.patch('/:id', async (req, res) => {
  const cn = req.user!.clientNumber;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  await updateKnowledgeItem(cn, id, req.body).catch(e => res.status(404).json({ error: e.message }));
  res.json({ success: true });
});

// DELETE /api/v1/knowledge/:id  (admin only)
router.delete('/:id', requireAdmin, async (req, res) => {
  const cn = req.user!.clientNumber as string;
  const id = parseInt(req.params.id as string, 10);
  await deleteKnowledgeItem(cn, id);
  res.json({ success: true });
});

// ── Alerts ────────────────────────────────────────────────────
// GET /api/v1/knowledge/alerts?unread=true
router.get('/alerts', async (req, res) => {
  const cn = req.user!.clientNumber;
  const unreadOnly = req.query.unread === 'true';
  const alerts = await getAlerts(cn as string, unreadOnly);
  res.json({ alerts });
});

// PATCH /api/v1/knowledge/alerts/:id/read
router.patch('/alerts/:id/read', async (req, res) => {
  const cn = req.user!.clientNumber;
  const id = parseInt(req.params.id, 10);
  await markAlertRead(cn, id);
  res.json({ success: true });
});

export default router;
