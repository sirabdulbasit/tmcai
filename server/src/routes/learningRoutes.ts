/**
 * Nexeo Self-Learning — Routes (Phase 1)
 *
 * Mount at /api/v1/learning. All routes require requireAuth. Memory
 * approval/rejection/archive routes additionally require admin role
 * for tenant-scope memories OR ownership match for user-scope.
 *
 * Tenant isolation is enforced TWICE — once at the auth middleware
 * (sets req.user.clientNumber) and once explicitly in each route
 * (passes that clientNumber to the service). Defense in depth.
 */
import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  recordFeedback,
  proposeMemory,
  approveMemory,
  rejectMemory,
  archiveMemory,
  listMemories,
  listInteractions,
  recordUserOutcome,
} from '../services/learning/learningService';
import { getAuditFeed } from '../services/learning/learningAuditService';
import createLogger from '../utils/logger';

const log = createLogger('learning-routes');
const router = Router();
router.use(requireAuth);

// ─── POST /feedback — record user feedback on a Brain interaction ──
router.post('/feedback', async (req: Request, res: Response) => {
  const { interactionId, feedbackType, feedbackComment, correctedOutput } = req.body ?? {};
  if (!feedbackType || typeof feedbackType !== 'string') {
    res.status(400).json({ error: 'feedbackType is required' });
    return;
  }
  const result = await recordFeedback({
    clientNumber: req.user!.clientNumber,
    userId: req.user!.id,
    interactionId,
    feedbackType,
    feedbackComment,
    correctedOutput,
  });
  res.json({ success: true, id: result.id });
});

// ─── GET /interactions — list THIS user's interactions ─────────────
router.get('/interactions', async (req: Request, res: Response) => {
  const surface = req.query.surface as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await listInteractions({
    clientNumber: req.user!.clientNumber,
    userId: req.user!.id,
    surface,
    limit,
  });
  res.json({ interactions: rows });
});

// ─── PATCH /interactions/:id/outcome — user marks their action on it ─
router.patch('/interactions/:id/outcome', async (req: Request, res: Response) => {
  const { outcome } = req.body ?? {};
  if (!outcome || typeof outcome !== 'string') {
    res.status(400).json({ error: 'outcome is required' });
    return;
  }
  const ok = await recordUserOutcome(req.params.id as string, req.user!.id, outcome);
  if (!ok) {
    res.status(404).json({ error: 'interaction not found or not owned by this user' });
    return;
  }
  res.json({ success: true });
});

// ─── GET /memories — list memories ─────────────────────────────────
// Default: this user's memories (active). Admin can add ?all=true to
// see all tenant memories (including other users' + tenant-scope).
router.get('/memories', async (req: Request, res: Response) => {
  const all = req.query.all === 'true';
  const status = (req.query.status as any) || 'active';
  const scope = req.query.scope as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  // Non-admins can ONLY see their own memories — silently override.
  const userIdFilter = (all && req.user!.isAdmin) ? undefined : req.user!.id;
  const rows = await listMemories({
    clientNumber: req.user!.clientNumber,
    userId: userIdFilter,
    status,
    scope,
    limit,
  });
  res.json({ memories: rows });
});

// ─── POST /memories — user-explicit memory creation ────────────────
// Brain proposes memories via internal service calls; this endpoint
// is for USER-explicit "remember this about me" actions from the UI.
router.post('/memories', async (req: Request, res: Response) => {
  const { memoryScope, memoryType, title, content, sensitivityLevel, scopeReferenceId } = req.body ?? {};
  if (!memoryScope || !memoryType || !title || !content) {
    res.status(400).json({ error: 'memoryScope, memoryType, title, content are required' });
    return;
  }
  // User-explicit memories can be active immediately if low/normal —
  // proposeMemory enforces the sensitive→pending_approval gate.
  const result = await proposeMemory({
    clientNumber: req.user!.clientNumber,
    userId: req.user!.id,
    memoryScope,
    memoryType,
    title,
    content,
    sensitivityLevel,
    scopeReferenceId,
    createdByBrain: false,
    sourceType: 'user_explicit',
  });
  res.status(201).json({ success: true, id: result.id, status: result.status });
});

// ─── PATCH /memories/:id/approve ───────────────────────────────────
// Approve a pending memory. Owner can approve their own user-scope
// memory; admin can approve any tenant-scope or other-user memory.
router.patch('/memories/:id/approve', async (req: Request, res: Response) => {
  const result = await approveMemory(
    req.params.id as string,
    req.user!.id,
    req.user!.clientNumber,
  );
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  log.info('memory approved', { memoryId: req.params.id, by: req.user!.id });
  res.json({ success: true });
});

// ─── PATCH /memories/:id/reject ────────────────────────────────────
router.patch('/memories/:id/reject', async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  const result = await rejectMemory(
    req.params.id as string,
    req.user!.id,
    req.user!.clientNumber,
    typeof reason === 'string' ? reason : undefined,
  );
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  log.info('memory rejected', { memoryId: req.params.id, by: req.user!.id });
  res.json({ success: true });
});

// ─── PATCH /memories/:id/archive ───────────────────────────────────
router.patch('/memories/:id/archive', async (req: Request, res: Response) => {
  const result = await archiveMemory(req.params.id as string, req.user!.clientNumber);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  log.info('memory archived', { memoryId: req.params.id, by: req.user!.id });
  res.json({ success: true });
});

// ─── GET /audit — admin-only chronological feed ────────────────────
router.get('/audit', requireAdmin, async (req: Request, res: Response) => {
  const targetUserId = req.query.userId ? Number(req.query.userId) : undefined;
  const sinceDays = req.query.sinceDays ? Number(req.query.sinceDays) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const events = await getAuditFeed({
    clientNumber: req.user!.clientNumber,
    userId: targetUserId,
    sinceDays,
    limit,
  });
  res.json({ events });
});

// ═════════════════════════════════════════════════════════════════════
// Phase 2 — Gap Detection → Product Proposals → Development Requests
// ═════════════════════════════════════════════════════════════════════
// All Phase 2 routes are admin-only — these decide what Brain works
// on next, so a regular user shouldn't be promoting gaps to dev
// requests on their own. The Detected Gaps Inbox + Proposal screens
// in the UI gate visibility on req.user.isAdmin.

router.get('/gaps', requireAdmin, async (req: Request, res: Response) => {
  const { listGaps } = await import('../services/learning/gapDetectionService');
  const rows = await listGaps({
    clientNumber: req.user!.clientNumber,
    status: req.query.status as string | undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  res.json({ gaps: rows });
});

router.post('/gaps/detect', requireAdmin, async (req: Request, res: Response) => {
  // Manual trigger — also runs nightly via cron (see server.ts).
  const { runGapDetection } = await import('../services/learning/gapDetectionService');
  const result = await runGapDetection(req.user!.clientNumber);
  res.json({ success: true, ...result });
});

router.patch('/gaps/:id/approve', requireAdmin, async (req: Request, res: Response) => {
  const { approveGap } = await import('../services/learning/gapDetectionService');
  const r = await approveGap(req.params.id as string, req.user!.id, req.user!.clientNumber);
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  res.json({ success: true });
});

router.patch('/gaps/:id/reject', requireAdmin, async (req: Request, res: Response) => {
  const { rejectGap } = await import('../services/learning/gapDetectionService');
  const r = await rejectGap(req.params.id as string, req.user!.id, req.user!.clientNumber);
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  res.json({ success: true });
});

// ─── Product proposals ─────────────────────────────────────────────

router.post('/proposals/from-gap/:gapId', requireAdmin, async (req: Request, res: Response) => {
  const { createFromGap } = await import('../services/learning/productProposalService');
  const r = await createFromGap({
    gapId: req.params.gapId as string,
    clientNumber: req.user!.clientNumber,
    authorUserId: req.user!.id,
  });
  if (r.error) { res.status(400).json({ error: r.error }); return; }
  res.status(201).json({ success: true, id: r.id });
});

router.get('/proposals', requireAdmin, async (req: Request, res: Response) => {
  const { listProposals } = await import('../services/learning/productProposalService');
  const rows = await listProposals({
    clientNumber: req.user!.clientNumber,
    status: req.query.status as string | undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  res.json({ proposals: rows });
});

router.patch('/proposals/:id/approve', requireAdmin, async (req: Request, res: Response) => {
  const { approveProposal } = await import('../services/learning/productProposalService');
  const r = await approveProposal(req.params.id as string, req.user!.id, req.user!.clientNumber);
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  res.json({ success: true });
});

router.patch('/proposals/:id/reject', requireAdmin, async (req: Request, res: Response) => {
  const { rejectProposal } = await import('../services/learning/productProposalService');
  const r = await rejectProposal(req.params.id as string, req.user!.id, req.user!.clientNumber);
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  res.json({ success: true });
});

// ─── Development requests ──────────────────────────────────────────

router.post('/development-requests/from-proposal/:proposalId', requireAdmin, async (req: Request, res: Response) => {
  const { createFromProposal } = await import('../services/learning/developmentRequestService');
  const r = await createFromProposal({
    proposalId: req.params.proposalId as string,
    clientNumber: req.user!.clientNumber,
    authorUserId: req.user!.id,
  });
  if (r.error) { res.status(400).json({ error: r.error }); return; }
  res.status(201).json({ success: true, id: r.id });
});

router.get('/development-requests', requireAdmin, async (req: Request, res: Response) => {
  const { listDevRequests } = await import('../services/learning/developmentRequestService');
  const rows = await listDevRequests({
    clientNumber: req.user!.clientNumber,
    status: req.query.status as string | undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  res.json({ devRequests: rows });
});

router.post('/development-requests/:id/generate-technical-spec', requireAdmin, async (req: Request, res: Response) => {
  const { generateTechnicalSpec } = await import('../services/learning/developmentRequestService');
  const r = await generateTechnicalSpec({
    devRequestId: req.params.id as string,
    clientNumber: req.user!.clientNumber,
  });
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  res.json({ success: true, spec: r.spec });
});

router.patch('/development-requests/:id/approve', requireAdmin, async (req: Request, res: Response) => {
  const { approveDevRequest } = await import('../services/learning/developmentRequestService');
  const r = await approveDevRequest(req.params.id as string, req.user!.id, req.user!.clientNumber);
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  res.json({ success: true });
});

router.patch('/development-requests/:id/reject', requireAdmin, async (req: Request, res: Response) => {
  const { rejectDevRequest } = await import('../services/learning/developmentRequestService');
  const r = await rejectDevRequest(req.params.id as string, req.user!.id, req.user!.clientNumber);
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  res.json({ success: true });
});

export default router;
