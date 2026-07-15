/**
 * Muted senders — per-user mute list. Senders here are dropped from
 * My Attention AND Brief on every triage cycle; they remain in
 * feed_events and the Wiki archive so search still finds them.
 *
 * Endpoints:
 *   GET    /user/muted-senders          → list { items: [...] }
 *   POST   /user/muted-senders          → add  { channel, identifier, displayName?, reason? }
 *   DELETE /user/muted-senders/:id      → remove (own user only)
 *
 * User-scoped throughout — every query gates on req.user.id.
 */
import { Router, Request, Response } from 'express';
import prisma from '../db/prisma';
import { requireAuth } from '../middleware/auth';

const router = Router();

const VALID_CHANNELS = new Set(['email', 'whatsapp', 'gchat', 'other']);

router.get('/', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    const items = await prisma.mutedSender.findMany({
      where: { userId: user.id, clientNumber: user.clientNumber },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ items });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const channel = String(req.body?.channel ?? '').toLowerCase();
  const identifier = String(req.body?.identifier ?? '').trim();
  const displayName = req.body?.displayName ? String(req.body.displayName).trim() : null;
  const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 500) : null;

  if (!VALID_CHANNELS.has(channel)) {
    return res.status(400).json({ error: `channel must be one of: ${[...VALID_CHANNELS].join(', ')}` });
  }
  if (!identifier) return res.status(400).json({ error: 'identifier required' });

  // Normalise the identifier per channel so look-ups are case-/format-
  // insensitive against feed_events.senderEmail and senderPhone.
  const normalised = channel === 'email'
    ? identifier.toLowerCase().replace(/<|>/g, '')
    : channel === 'whatsapp'
    ? identifier.replace(/[^\d+]/g, '')
    : identifier;

  try {
    const row = await prisma.mutedSender.upsert({
      where: { userId_channel_identifier: { userId: user.id, channel, identifier: normalised } } as any,
      create: {
        clientNumber: user.clientNumber, userId: user.id,
        channel, identifier: normalised, displayName, reason,
      } as any,
      update: { displayName, reason } as any,
    });
    res.json({ ok: true, item: row });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  try {
    const found = await prisma.mutedSender.findFirst({
      where: { id, userId: user.id, clientNumber: user.clientNumber },
    });
    if (!found) return res.status(404).json({ error: 'not found' });
    await prisma.mutedSender.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
