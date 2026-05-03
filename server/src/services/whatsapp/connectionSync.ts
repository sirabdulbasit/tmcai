/**
 * MyOS — whatsapp_connections sync from user profile.
 *
 * The tenant WhatsApp inbound handler resolves identity by looking up
 * the sender's number in `whatsapp_connections`. Without a row there
 * the user's messages are silently dropped — even if they've entered
 * their contact number in Settings → Personalization.
 *
 * This service is the single source of truth for keeping
 * whatsapp_connections in sync with the user's profile contact number.
 * It runs:
 *   - On every PUT /profile that touches contactNumber (live sync).
 *   - Once on every server boot via backfillAll() (catches users who
 *     entered their number before this code shipped).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:connection-sync');

/** Normalise to E.164-ish: keep leading +, strip spaces/dashes/parens. */
function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/[\s\-()]/g, '');
  if (!trimmed) return null;
  // If it doesn't start with +, but starts with a country code (10+ digits), assume bare number.
  if (!trimmed.startsWith('+') && /^\d{10,15}$/.test(trimmed)) return '+' + trimmed;
  if (/^\+\d{10,15}$/.test(trimmed)) return trimmed;
  return null; // anything else — refuse rather than store garbage
}

/**
 * Upsert the active whatsapp_connections row for a user from their
 * profile contact number. Per-user we keep at most one 'active' row;
 * supplying a new number updates that row in place. Empty/null number
 * clears the binding.
 */
export async function syncWhatsAppConnectionFromProfile(
  userId: number,
  rawNumber: string | null | undefined,
): Promise<void> {
  const phone = normalisePhone(rawNumber);

  if (!phone) {
    // Profile cleared the number — deactivate any existing binding.
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_connections SET status = 'inactive', updated_at = NOW() WHERE user_id = $1 AND status = 'active'`,
      userId,
    ).catch(() => {});
    return;
  }

  // Upsert — one active row per user. If a row already exists for this
  // user, update it; otherwise insert.
  const existing = await prisma.$queryRawUnsafe<Array<{ id: number; phone_number: string }>>(
    `SELECT id, phone_number FROM whatsapp_connections WHERE user_id = $1 LIMIT 1`,
    userId,
  );

  if (existing.length) {
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_connections
       SET phone_number = $1, status = 'active', provider = COALESCE(provider, 'webjs'), updated_at = NOW()
       WHERE id = $2`,
      phone, existing[0].id,
    );
    if (existing[0].phone_number !== phone) {
      log.info('phone number rebinding', { userId, old: existing[0].phone_number, new: phone });
    }
    return;
  }

  await prisma.$executeRawUnsafe(
    `INSERT INTO whatsapp_connections (user_id, phone_number, status, provider, connected_at, updated_at)
     VALUES ($1, $2, 'active', 'webjs', NOW(), NOW())`,
    userId, phone,
  );
  log.info('whatsapp_connection created', { userId, phone });
}

/**
 * Boot-time backfill — for every user that has a contactNumber but no
 * (or stale) whatsapp_connections row, create/update the binding.
 * Idempotent.
 */
export async function backfillAllWhatsAppConnections(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { contactNumber: { not: null } } as any,
    select: { id: true, contactNumber: true },
  }).catch(() => [] as Array<{ id: number; contactNumber: string | null }>);

  let synced = 0;
  for (const u of users) {
    if (!u.contactNumber) continue;
    try {
      await syncWhatsAppConnectionFromProfile(u.id, u.contactNumber);
      synced += 1;
    } catch (e: any) {
      log.warn('backfill row failed', { userId: u.id, error: e.message });
    }
  }
  if (synced > 0) log.info('whatsapp_connections backfill complete', { synced });
}
