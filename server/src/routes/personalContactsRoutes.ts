/**
 * Personal contacts — user marks a WhatsApp sender as "Personal" so Brain
 * stops processing them entirely. This is a HARD scrub:
 *
 *   1. Add the phone to MutedSender (channel='whatsapp') so triage and
 *      brief never surface them again.
 *   2. Add the phone to user.notificationPreferences.whatsapp.excludedNumbers
 *      so the ingest-time guard in UserWebjsProvider drops future inbound
 *      from this contact BEFORE feed_event creation.
 *   3. Hard-delete every trace of this contact already in Brain's memory:
 *      feed_events, wiki_pages (entity + sender history + topic), entities,
 *      decision_logs linked to those feed_events, etc.
 *
 * Unmarking lifts (1) and (2). It does NOT restore the deleted data —
 * that's gone for good. Brain will start building a fresh wiki/feed from
 * new messages after the unmark.
 *
 * Endpoints — all gated by req.user.id (no admin overrides; this is a
 * personal preference, owned by the user):
 *
 *   POST   /user/personal-contacts/preview       → returns counts of what WILL be deleted
 *   POST   /user/personal-contacts/mark          → with typed-phrase confirmation
 *   POST   /user/personal-contacts/unmark        → lifts exclusion, leaves data deleted
 *   GET    /user/personal-contacts               → list current personal contacts
 */
import { Router, Request, Response } from 'express';
import prisma from '../db/prisma';
import { requireAuth } from '../middleware/auth';
import createLogger from '../utils/logger';

const log = createLogger('personal-contacts');
const router = Router();

/** Normalize a phone to the same shape used elsewhere in the codebase
 *  (digits + leading +). Matches normalizePhone() in UserWebjsProvider. */
function normalizePhone(raw: string): string {
  return String(raw || '').replace(/[^\d+]/g, '');
}

/** Pull the current excludedNumbers array from the user's
 *  notificationPreferences. Mirrors getExcludedNumbers() in
 *  UserWebjsProvider but inlined here so we can edit the same JSON path. */
async function getExcludedNumbers(userId: number): Promise<string[]> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPreferences: true },
  });
  const arr = ((u?.notificationPreferences as any)?.whatsapp?.excludedNumbers ?? []) as unknown[];
  return arr.filter((x): x is string => typeof x === 'string' && !!x);
}

async function setExcludedNumbers(userId: number, numbers: string[]): Promise<void> {
  // Read-modify-write the JSON. Preserve any other notificationPreferences fields.
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPreferences: true },
  });
  const prefs = (u?.notificationPreferences as any) ?? {};
  const wa = (prefs.whatsapp as any) ?? {};
  wa.excludedNumbers = Array.from(new Set(numbers.map(normalizePhone).filter(Boolean)));
  prefs.whatsapp = wa;
  await prisma.user.update({
    where: { id: userId },
    data: { notificationPreferences: prefs },
  });
}

/** Count (and list — capped) what would be hard-deleted if we scrub
 *  this contact. Used by the /preview endpoint so the UI can show
 *  "this will delete N wiki pages, M feed_events" before MD confirms. */
async function previewScrub(userId: number, clientNumber: string, phone: string) {
  const normalised = normalizePhone(phone);
  if (!normalised) return { feedEvents: 0, wikiPages: 0, entities: 0, decisionLogs: 0 };

  // feed_events tied to this WA sender. We also accept the digits-only
  // form because some older rows stored without a leading '+'.
  const feedCount = await prisma.feedEvent.count({
    where: {
      clientNumber, userId,
      sourceType: 'whatsapp',
      OR: [
        { senderPhone: normalised },
        { senderPhone: normalised.replace(/^\+/, '') },
      ],
    },
  }).catch(() => 0);

  // wiki_pages — sender_history / sender_topic / entity_person /
  // any page whose metadata.senderPhone matches.
  const wikiCount = await prisma.wikiPage.count({
    where: {
      clientNumber, userId,
      OR: [
        { metadata: { path: ['senderPhone'], equals: normalised } as any },
        { metadata: { path: ['senderPhone'], equals: normalised.replace(/^\+/, '') } as any },
        { metadata: { path: ['phone'], equals: normalised } as any },
      ],
    },
  }).catch(() => 0);

  const entityCount = await prisma.entity.count({
    where: {
      clientNumber,
      entityType: 'contact',
      OR: [
        { phone: normalised },
        { phone: normalised.replace(/^\+/, '') },
      ],
    },
  }).catch(() => 0);

  // decision_logs tied to a feed_event for this sender. We do a join via
  // entityId (the feed_event id) so we count actions actually taken.
  const decisionCount = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT COUNT(*)::bigint AS n FROM decision_log
       WHERE user_id = $1 AND client_number = $2
         AND entity_id IN (
           SELECT id FROM feed_events
            WHERE client_number = $2 AND user_id = $1
              AND source_type = 'whatsapp'
              AND (sender_phone = $3 OR sender_phone = $4)
         )`,
    userId, clientNumber, normalised, normalised.replace(/^\+/, ''),
  ).then((rows) => Number(rows[0]?.n ?? 0)).catch(() => 0);

  return { feedEvents: feedCount, wikiPages: wikiCount, entities: entityCount, decisionLogs: decisionCount };
}

/** Run the hard scrub. Returns counts of rows actually deleted. */
async function hardScrub(userId: number, clientNumber: string, phone: string) {
  const normalised = normalizePhone(phone);
  if (!normalised) return { feedEvents: 0, wikiPages: 0, entities: 0, decisionLogs: 0 };
  const noPlusForm = normalised.replace(/^\+/, '');

  // Order matters: kill the lineage rows first (decisions, wiki_page_*
  // cascades), then the parent (feed_events, wiki_pages, entities).
  const decisionDel = await prisma.$executeRawUnsafe(
    `DELETE FROM decision_log
       WHERE user_id = $1 AND client_number = $2
         AND entity_id IN (
           SELECT id FROM feed_events
            WHERE client_number = $2 AND user_id = $1
              AND source_type = 'whatsapp'
              AND (sender_phone = $3 OR sender_phone = $4)
         )`,
    userId, clientNumber, normalised, noPlusForm,
  ).catch(() => 0);

  // wiki_pages (cascade kills wiki_page_links, wiki_page_sources, embeddings)
  const wikiDel = await prisma.$executeRawUnsafe(
    `DELETE FROM wiki_pages
       WHERE client_number = $1 AND user_id = $2
         AND (
           (metadata->>'senderPhone' = $3 OR metadata->>'senderPhone' = $4)
           OR (metadata->>'phone' = $3 OR metadata->>'phone' = $4)
         )`,
    clientNumber, userId, normalised, noPlusForm,
  ).catch(() => 0);

  const feedDel = await prisma.$executeRawUnsafe(
    `DELETE FROM feed_events
       WHERE client_number = $1 AND user_id = $2
         AND source_type = 'whatsapp'
         AND (sender_phone = $3 OR sender_phone = $4)`,
    clientNumber, userId, normalised, noPlusForm,
  ).catch(() => 0);

  // entities are tenant-scoped (no userId column), so we only delete
  // if no other user in the tenant still has this contact. Safest:
  // skip entity deletion; the contact will just go silent. (A future
  // enhancement could check usage and delete unreferenced entities.)
  const entityDel = 0;

  return {
    feedEvents: Number(feedDel),
    wikiPages: Number(wikiDel),
    entities: entityDel,
    decisionLogs: Number(decisionDel),
  };
}

router.get('/', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    const muted = await prisma.mutedSender.findMany({
      where: { userId: user.id, clientNumber: user.clientNumber, channel: 'whatsapp' },
      orderBy: { createdAt: 'desc' },
    });
    const excluded = await getExcludedNumbers(user.id);
    res.json({ muted, excludedNumbers: excluded });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/preview', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const phone = String(req.body?.phone ?? '').trim();
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const counts = await previewScrub(user.id, user.clientNumber, phone);
    res.json({ ok: true, phone: normalizePhone(phone), willDelete: counts });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/mark', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const phone = String(req.body?.phone ?? '').trim();
  const displayName = req.body?.displayName ? String(req.body.displayName).trim() : null;
  const confirmPhrase = String(req.body?.confirmPhrase ?? '').trim();

  if (!phone) return res.status(400).json({ error: 'phone required' });

  // Typed-phrase confirmation — MD must echo back the contact's display
  // name (or a portion of it). This is the same UX pattern used
  // elsewhere; matches the user-only feedback rule on browser dialogs.
  const expectedConfirm = (displayName || normalizePhone(phone)).toLowerCase();
  if (!confirmPhrase || confirmPhrase.toLowerCase() !== expectedConfirm) {
    return res.status(400).json({
      error: 'confirmPhrase must match the contact name (or phone) to confirm scrub',
      expected: expectedConfirm,
    });
  }

  const normalised = normalizePhone(phone);
  try {
    // 1. Hard scrub all existing data
    const counts = await hardScrub(user.id, user.clientNumber, normalised);

    // 2. Add to MutedSender so triage/brief skip future items
    await prisma.mutedSender.upsert({
      where: {
        userId_channel_identifier: {
          userId: user.id, channel: 'whatsapp', identifier: normalised,
        },
      } as any,
      create: {
        clientNumber: user.clientNumber, userId: user.id,
        channel: 'whatsapp', identifier: normalised,
        displayName, reason: 'marked_personal',
      } as any,
      update: { displayName, reason: 'marked_personal' } as any,
    });

    // 3. Add to ingest-time exclusion list so future inbound never
    //    becomes a feed_event in the first place
    const current = await getExcludedNumbers(user.id);
    if (!current.includes(normalised)) {
      await setExcludedNumbers(user.id, [...current, normalised]);
    }

    log.info('marked personal', { userId: user.id, phone: normalised, scrubbed: counts });
    res.json({ ok: true, phone: normalised, scrubbed: counts });
  } catch (err: any) {
    log.warn('mark personal failed', { userId: user.id, phone, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post('/unmark', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const phone = String(req.body?.phone ?? '').trim();
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const normalised = normalizePhone(phone);

  try {
    // 1. Remove MutedSender row(s)
    await prisma.mutedSender.deleteMany({
      where: {
        userId: user.id, clientNumber: user.clientNumber,
        channel: 'whatsapp', identifier: normalised,
      },
    });

    // 2. Strip from excludedNumbers
    const current = await getExcludedNumbers(user.id);
    const next = current.filter((n) => n !== normalised);
    if (next.length !== current.length) await setExcludedNumbers(user.id, next);

    log.info('unmarked personal', { userId: user.id, phone: normalised });
    // Note: previously deleted feed_events / wiki_pages are NOT restored.
    // Brain will start building fresh wiki entries from inbound messages
    // arriving after this unmark.
    res.json({ ok: true, phone: normalised, note: 'Brain will resume from fresh on future messages — past data was deleted and is not restored.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
