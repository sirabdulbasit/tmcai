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

  // Additive sync — NEVER mutate an existing row's phone_number.
  //
  // Historical bug (Basit 2026-07-06 diagnostic-first sweep): the old
  // SELECT ... LIMIT 1 without an ORDER BY picked a non-deterministic
  // row and then UPDATE'd its phone_number to the profile phone. When
  // the picked row happened to be an @lid alias (e.g. row id=4 with
  // phone +173555350261799 marked "Basit (LID alias 1799)"), the
  // alias was OVERWRITTEN with the real phone. Every server boot's
  // backfillAll() ran through this same code — silently resetting
  // learned aliases. The user then had to run manual SQL every time
  // Brain went silent on @lid messages. Third time this bug pattern
  // recurred — hence the memory rule feedback_diagnostic_first_
  // recurring_bugs.
  //
  // New semantic:
  //   1. If a row with THIS exact phone already exists → touch
  //      updated_at + ensure status=active. No phone mutation.
  //   2. Otherwise INSERT a new row for the profile phone.
  //   3. NEVER overwrite phone_number on any existing row.
  //
  // Multiple active rows per user is intentional — the phone-variants
  // lookup in WhatsAppInbound already matches any of them, and this
  // is exactly what makes @lid aliases work alongside real numbers.

  const existing = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    `SELECT id FROM whatsapp_connections WHERE user_id = $1 AND phone_number = $2 LIMIT 1`,
    userId, phone,
  );

  if (existing.length) {
    // Row already has this exact phone — refresh status + timestamp only.
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_connections
         SET status = 'active',
             provider = COALESCE(provider, 'webjs'),
             updated_at = NOW()
       WHERE id = $1`,
      existing[0].id,
    );
    return;
  }

  // Truly new binding — insert. Aliases (if any) stay untouched.
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
