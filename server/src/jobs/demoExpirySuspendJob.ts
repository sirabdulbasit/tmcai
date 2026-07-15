/**
 * demoExpirySuspendJob — every hour, sweep users whose
 * expires_at has passed and flip them to is_active=false.
 *
 * Per Basit 2026-06-10: "how can i give any user to anyone as
 * demo with expiry date".
 *
 * Why suspend (not delete):
 *   - Reversible — admin can extend the date and reactivate
 *     without losing the demo's accumulated data
 *   - Honest audit trail — the row stays, the lastLoginAt /
 *     contactNumber / connectors are preserved if the customer
 *     decides to convert demo → paid
 *   - Admin can still hard-delete via the Delete button when
 *     they're sure cleanup is wanted
 *
 * The suspension itself triggers all the same gates as a manual
 * Suspend: brainContactsUser refuses outbound, WhatsApp inbound
 * lookup drops their messages, Day Brief dispatch skips them.
 * No code change needed in those paths — the is_active=false
 * flip is the universal switch.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('demo-expiry-suspend');

export async function runDemoExpirySweep(): Promise<{ suspended: number }> {
  const now = new Date();
  // Index `idx_users_expires_at_active` matches this WHERE clause —
  // partial index over (expires_at) where expires_at IS NOT NULL AND
  // is_active = TRUE. Sweep stays cheap even at 10k+ users.
  const expired = await prisma.user.findMany({
    where: {
      expiresAt: { not: null, lte: now },
      isActive: true,
    },
    select: { id: true, email: true, expiresAt: true, clientNumber: true },
  });
  if (!expired.length) return { suspended: 0 };

  await prisma.user.updateMany({
    where: { id: { in: expired.map((u) => u.id) } },
    data: { isActive: false },
  });

  for (const u of expired) {
    log.info('demo user auto-suspended at expiry', {
      userId: u.id,
      email: u.email,
      tenant: u.clientNumber,
      expiredAt: u.expiresAt,
    });
  }
  return { suspended: expired.length };
}
