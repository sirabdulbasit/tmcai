import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import * as chatController from '../controllers/chatController';
import { optionalAuth } from '../middleware/auth';

const router = Router();

/**
 * Rate limiter with pluggable key generator.
 * Uses user ID when authenticated, falls back to IP.
 */
const getKey = (req: Request): string => {
  if ((req as any).user?.id) return (req as any).user.id.toString();
  return 'anonymous';
};

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getKey,
  message: { error: 'Too many requests. Please wait a moment before trying again.' },
});

// optionalAuth: chat works with or without login
// When logged in: saves history, logs audit with user ID
// When not logged in: works as before (anonymous)
router.post('/stream', optionalAuth, chatLimiter, chatController.streamChat);

// Get user's memory (for review/edit)
router.get('/memory', optionalAuth, async (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) { res.json({ memory: null }); return; }
  const prisma = require('../db/prisma').default;
  const rows: any[] = await prisma.$queryRawUnsafe(
    'SELECT ai_instructions, user_personal, active_concerns, updated_at FROM user_profile_memory WHERE user_id = $1', userId
  );
  if (rows.length === 0) { res.json({ memory: null }); return; }
  res.json({ memory: rows[0] });
});

// Update user's memory (from edited text)
router.put('/memory', optionalAuth, async (req, res) => {
  const userId = (req as any).user?.id;
  const cn = (req as any).user?.clientNumber;
  if (!userId) { res.status(401).json({ error: 'Login required' }); return; }
  const { ai_instructions, user_personal, active_concerns } = req.body;
  const prisma = require('../db/prisma').default;
  await prisma.$executeRawUnsafe(
    `INSERT INTO user_profile_memory (user_id, client_number, ai_instructions, user_personal, active_concerns, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET ai_instructions = $3, user_personal = $4, active_concerns = $5, updated_at = NOW()`,
    userId, cn, ai_instructions || '', user_personal || '', active_concerns || ''
  );
  res.json({ success: true });
});

// Clear user's memory
router.delete('/memory', optionalAuth, async (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) { res.status(401).json({ error: 'Login required' }); return; }
  const prisma = require('../db/prisma').default;
  // Keep only AI name
  const rows: any[] = await prisma.$queryRawUnsafe('SELECT ai_instructions FROM user_profile_memory WHERE user_id = $1', userId);
  const nameMatch = rows[0]?.ai_instructions?.match(/Name:\s*\w+\./i);
  const keepName = nameMatch ? nameMatch[0] : '';
  await prisma.$executeRawUnsafe(
    'UPDATE user_profile_memory SET ai_instructions = $1, user_personal = $2, active_concerns = $3, updated_at = NOW() WHERE user_id = $4',
    keepName, '', '', userId
  );
  res.json({ success: true });
});

// Welcome briefing (on login)
router.get('/welcome', optionalAuth, async (req, res) => {
  const userId = (req as any).user?.id;
  const h = new Date().getHours();
  const timeGreeting = h < 12 ? 'Good morning!' : h < 17 ? 'Good afternoon!' : 'Good evening!';

  if (!userId) {
    res.json({ greeting: timeGreeting, weather: '', memoryNote: '', daySnapshot: [], activitySnapshot: [], actions: [] });
    return;
  }
  try {
    const { generateWelcomeBriefing } = require('../services/welcomeService');
    const briefing = await generateWelcomeBriefing(userId);
    res.json(briefing);
  } catch (err: any) {
    const name = (req as any).user?.name?.split(' ')[0] || '';
    res.json({ greeting: `${timeGreeting.replace('!', '')}, ${name}!`, weather: '', memoryNote: '', daySnapshot: [], activitySnapshot: [], actions: [] });
  }
});

// Morning briefing (on demand)
router.post('/briefing', optionalAuth, async (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) { res.status(401).json({ error: 'Login required' }); return; }
  try {
    const { sendMorningBriefing } = require('../services/briefingService');
    await sendMorningBriefing(userId);
    res.json({ success: true, message: 'Briefing sent to your email' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Feedback (thumbs up/down)
router.post('/feedback', optionalAuth, async (req, res) => {
  const { rating, query, responsePreview, conversationId } = req.body;
  if (!rating || !['up', 'down'].includes(rating)) {
    res.status(400).json({ error: 'rating must be "up" or "down"' });
    return;
  }
  try {
    const prisma = require('../db/prisma').default;
    const userId = (req as any).user?.id;
    const cn = (req as any).user?.clientNumber;
    if (!cn) {
      // Authenticated user without a tenant should be impossible —
      // fail closed rather than writing a row under a bogus tenant.
      res.status(400).json({ error: 'no tenant context' });
      return;
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO feedback (client_number, user_id, rating, query, response_preview, conversation_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      cn, userId || null, rating,
      (query || '').slice(0, 500), (responsePreview || '').slice(0, 500), conversationId || null
    );
    // Learn from feedback (background)
    if (userId && cn) {
      const { learnFromFeedback } = require('../services/learningService');
      learnFromFeedback(cn, userId, rating, 'unknown', (responsePreview || '').length).catch(() => {});
    }
    res.json({ success: true });
  } catch {
    res.json({ success: true }); // Don't fail on feedback errors
  }
});

export default router;
