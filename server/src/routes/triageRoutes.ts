import { Router, Request, Response } from 'express';
import { classifyArchetype, archetypeToItemType, ALL_ARCHETYPES } from '../services/triage/archetypeClassifier';

const router = Router();

/**
 * POST /api/v1/triage/archetype — stateless classifier endpoint.
 * Used by the Feed Curator agent as a callable tool (cheaper than asking the
 * LLM to classify); also callable by anyone who has a feed event payload.
 */
router.post('/archetype', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const body = req.body ?? {};
  const result = classifyArchetype({
    sourceType: body.sourceType,
    eventType: body.eventType,
    senderEmail: body.senderEmail ?? body.from,
    subject: body.subject,
    snippet: body.snippet,
    body: body.body,
    vip: body.vip ?? false,
  });
  res.json({
    ...result,
    suggestedItemType: archetypeToItemType(result.archetype),
    allArchetypes: ALL_ARCHETYPES,
  });
});

export default router;
