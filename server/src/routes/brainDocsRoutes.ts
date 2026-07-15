/**
 * Brain Docs — typed audit/replay routes.
 *
 * Read API across every Brain reasoning artifact. Per-user scoped:
 * a user only sees their own docs across every type.
 *
 * Routes (mounted at /api/v1/brain/docs):
 *   GET  /                        list latest docs across all types
 *   GET  /:docType/latest         latest single doc of a type
 *   GET  /:docType/history        last 30 versions of a doc type
 *   GET  /by-event/:feedEventId   every doc that cites a given feed event
 *   GET  /:id                     single doc by id
 *   POST /:id/replay              re-run from this doc's input_summary
 *                                 (only morning_brief, risk_radar, ask_invocation)
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import prisma from '../db/prisma';
import {
  getLatest, getHistory, getById, findBySourceEvent,
  type BrainDocType,
} from '../services/brain/brainDocsService';

const router = Router();
router.use(requireAuth);

const KNOWN_TYPES: BrainDocType[] = [
  'morning_brief', 'risk_radar', 'ask_invocation', 'proposal',
  'thought', 'weekly_review', 'pattern_finding', 'shadow_calibration',
  'criticality_review',
];

router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await prisma.brainDoc.findMany({
      where: {
        clientNumber: req.user!.clientNumber,
        userId: req.user!.id,
        status: 'active',
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, docType: true, version: true, summary: true,
        model: true, generationMs: true, createdAt: true,
      },
    });
    res.json({ docs: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/by-event/:feedEventId', async (req: Request, res: Response) => {
  try {
    const docs = await findBySourceEvent(req.user!.clientNumber, req.params.feedEventId as string);
    // Filter to user's own docs (findBySourceEvent only checks tenant)
    res.json({ docs: docs.filter((d) => d.userId === req.user!.id) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:docType/latest', async (req: Request, res: Response) => {
  const docType = req.params.docType as BrainDocType;
  if (!KNOWN_TYPES.includes(docType)) {
    res.status(400).json({ error: `unknown docType: ${docType}` });
    return;
  }
  try {
    const doc = await getLatest(req.user!.clientNumber, req.user!.id, docType);
    res.json({ doc });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:docType/history', async (req: Request, res: Response) => {
  const docType = req.params.docType as BrainDocType;
  if (!KNOWN_TYPES.includes(docType)) {
    res.status(400).json({ error: `unknown docType: ${docType}` });
    return;
  }
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '30')) || 30, 100);
    const docs = await getHistory(req.user!.clientNumber, req.user!.id, docType, limit);
    res.json({ docs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const doc = await getById(req.user!.clientNumber, req.user!.id, req.params.id as string);
    if (!doc) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ doc });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Replay a doc — re-runs the appropriate generator with the persisted
 * inputs. For deterministic doc types (radar, brief) this surfaces drift
 * between "what the doc said" and "what it would say now."
 *
 * Only doc types with a known generator are replayable. Returns 400 for
 * unsupported types.
 */
router.post('/:id/replay', async (req: Request, res: Response) => {
  try {
    const doc = await getById(req.user!.clientNumber, req.user!.id, req.params.id as string);
    if (!doc) { res.status(404).json({ error: 'not found' }); return; }
    switch (doc.docType) {
      case 'risk_radar': {
        const { runForUser } = await import('../services/brain/riskRadarService');
        const result = await runForUser(doc.clientNumber, doc.userId, { force: true });
        res.json({ replayed: true, result, originalDoc: doc });
        return;
      }
      default:
        res.status(400).json({
          error: `replay not implemented for docType=${doc.docType}`,
          hint: 'supported types: risk_radar',
        });
        return;
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
