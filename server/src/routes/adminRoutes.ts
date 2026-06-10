import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth, requireAdmin } from '../middleware/auth';
import prisma from '../db/prisma';

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.id?.toString() || ipKeyGenerator(req),
  message: { error: 'Too many requests. Please try again in 1 minute.' },
});
router.use(adminLimiter);

// List users in current tenant (includes integration status)
router.get('/users', async (req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    where: { clientNumber: req.user!.clientNumber },
    select: {
      id: true, empcode: true, name: true, email: true,
      userType: true, department: true, isActive: true,
      lastLoginAt: true, createdAt: true, expiresAt: true,
      city: true, contactNumber: true, jobDescription: true,
      integrationProvider: true, integrationEmail: true,
      integrationScopes: true, integrationStatus: true,
    },
    orderBy: { name: 'asc' },
  });
  res.json({ users });
});

// ─── Update demo expiry (extend / clear) ──────────────────────────
// PATCH /admin/users/:id/expiry { expiresAt: '2026-12-31T23:59:59Z' | null }
// - null clears expiry (promotes a demo user to permanent)
// - future ISO timestamp extends or sets it
// - past timestamp is rejected (use Suspend if you want to deactivate now)
router.patch('/users/:id/expiry', async (req: Request, res: Response) => {
  const userId = parseInt(req.params.id as string);
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { clientNumber: true, id: true },
  });
  if (!target || target.clientNumber !== req.user!.clientNumber) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const { expiresAt } = req.body ?? {};
  let nextExpiry: Date | null = null;
  if (expiresAt !== null && expiresAt !== undefined && expiresAt !== '') {
    const d = new Date(expiresAt);
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ error: 'Invalid expiresAt — must be ISO-8601 datetime or null' });
      return;
    }
    if (d.getTime() < Date.now()) {
      res.status(400).json({ error: 'Expiry must be in the future. To deactivate now, use Suspend.' });
      return;
    }
    nextExpiry = d;
  }
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { expiresAt: nextExpiry },
    select: { id: true, expiresAt: true },
  });
  res.json({ success: true, expiresAt: updated.expiresAt });
});

// Update user details (admin can edit any user in their tenant)
router.patch('/users/:id', async (req: Request, res: Response) => {
  const userId = parseInt(req.params.id as string);
  const { name, department, userType, city, contactNumber, jobDescription } = req.body;

  // Verify user belongs to same tenant
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { clientNumber: true } });
  if (!target || target.clientNumber !== req.user!.clientNumber) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(name && { name }),
      ...(department !== undefined && { department: department || null }),
      ...(userType && { userType }),
      ...(city !== undefined && { city: city || null }),
      ...(contactNumber !== undefined && { contactNumber: contactNumber || null }),
      ...(jobDescription !== undefined && { jobDescription: jobDescription || null }),
    },
    select: { id: true, name: true, department: true, userType: true, city: true },
  });

  res.json({ user: updated });
});

// ─── Suspend / Reactivate ─────────────────────────────────────────
// Soft toggle of users.is_active. Reversible. When suspended:
//   - User can't log in (loginRoute checks is_active)
//   - Connector pollers skip them (every poller already filters
//     on isActive=true)
//   - Brain stops sending Day Brief / criticality / nudges
// Data is preserved untouched so reactivation restores full state.
router.post('/users/:id/suspend', async (req: Request, res: Response) => {
  const userId = parseInt(req.params.id as string);
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { clientNumber: true, id: true, isActive: true } });
  if (!target || target.clientNumber !== req.user!.clientNumber) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (target.id === req.user!.id) {
    res.status(400).json({ error: "You can't suspend your own account" });
    return;
  }
  await prisma.user.update({ where: { id: userId }, data: { isActive: false } });
  res.json({ success: true, isActive: false });
});

router.post('/users/:id/reactivate', async (req: Request, res: Response) => {
  const userId = parseInt(req.params.id as string);
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { clientNumber: true } });
  if (!target || target.clientNumber !== req.user!.clientNumber) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await prisma.user.update({ where: { id: userId }, data: { isActive: true, failedAttempts: 0, lockedUntil: null } });
  res.json({ success: true, isActive: true });
});

// ─── Delete (hard) ────────────────────────────────────────────────
// Permanent removal of the user + all owned data. Two safeguards:
//   1. Body must contain { confirm: "DELETE <email>" } so it can't
//      be triggered by accidentally clicking the wrong button.
//   2. SuperAdmin self-delete is blocked (would lock out the tenant).
// Cascading deletes are handled by Prisma onDelete: Cascade on every
// user-owned relation; we trust those FK rules to do the right
// thing rather than enumerating tables here (any new user-owned
// table must add `onDelete: Cascade` to its userId relation).
router.delete('/users/:id', async (req: Request, res: Response) => {
  const userId = parseInt(req.params.id as string);
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, clientNumber: true, userType: true },
  });
  if (!target || target.clientNumber !== req.user!.clientNumber) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (target.id === req.user!.id) {
    res.status(400).json({ error: "You can't delete your own account" });
    return;
  }
  if (target.userType === 'SA') {
    res.status(400).json({ error: 'SuperAdmin users cannot be deleted via this endpoint' });
    return;
  }
  const expectedConfirm = `DELETE ${target.email}`;
  if ((req.body?.confirm ?? '').trim() !== expectedConfirm) {
    res.status(400).json({
      error: `Confirmation phrase required. Type exactly: ${expectedConfirm}`,
    });
    return;
  }
  await prisma.user.delete({ where: { id: userId } });
  res.json({ success: true, deletedUserId: userId, deletedEmail: target.email });
});

export default router;
