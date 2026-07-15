import { Router, Request, Response } from 'express';
import prisma from '../db/prisma';

/**
 * Drafts — Brain-composed replies/actions held for MD review.
 *
 * Phase 1 stub: backed by existing agent_actions rows with status='draft' and
 * requiresApproval=true, scoped per user. On approve → transition to
 * status='approved' and enqueue execution via the handler registry. On reject
 * → transition to 'rejected' with reason, log to decision_logs for learning.
 *
 * Real draft generation is handled by action_executor when its confidence is
 * below the user's per-channel threshold.
 */
const router = Router();

router.post('/:id/approve', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber || !user?.id) return res.status(401).json({ error: 'unauthenticated' });
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const row = await prisma.agentAction.findFirst({
      where: { id, clientNumber: user.clientNumber, userId: user.id } as any,
    });
    if (!row) return res.status(404).json({ error: 'draft not found' });
    await prisma.agentAction.update({
      where: { id },
      data: { status: 'approved', approvedBy: user.id, approvedAt: new Date() },
    });
    // Fire-and-forget enqueue for the executor to pick up
    // (executor agent listens for status=approved via polling or pubsub)
    res.json({ ok: true, id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/reject', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber || !user?.id) return res.status(401).json({ error: 'unauthenticated' });
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const reason = String(req.body?.reason ?? '');
  try {
    await prisma.agentAction.updateMany({
      where: { id, clientNumber: user.clientNumber, userId: user.id } as any,
      data: { status: 'rejected', error: reason } as any,
    });
    // Record rejection as a signal for the rule miner to learn from
    await prisma.$executeRawUnsafe(
      `INSERT INTO decision_logs (client_number, user_id, session_type, item_type, user_decision, action_taken, override_reason, is_match, outcome, created_at)
       VALUES ($1, $2, 'intraday', 'draft_reject', 'overrode', 'reject_draft', $3, false, 'negative', NOW())`,
      user.clientNumber, user.id, reason,
    ).catch(() => {});
    res.json({ ok: true, id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
