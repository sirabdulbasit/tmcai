/**
 * smartCleanupService — Brain's autonomous contact maintenance.
 *
 * Per Basit 2026-05-25: "make it part of smart cleanup which brain
 * will do by itself. the smart cleanup will also include merging
 * duplications, brain will look at contacts intelligently and keep
 * cleaning by itself. include Reclaim ownership which is done by
 * brain itself."
 *
 * What it does (per user, per tenant):
 *
 *   1. Repoint cross-user-leaked rows  → fix user_id on rows the
 *      current owner has no evidence for, when another tenant user
 *      DOES have evidence (feed_events match by unwrapped sender_email
 *      or sender_phone). When the target owner already has a row with
 *      the same title, archive the leaked copy as a duplicate.
 *
 *   2. Archive no-evidence rows  → owner has no feed_events for the
 *      contact, no other user does either, and no user-action audit
 *      claims it. Means the contact came from a sync path whose
 *      source data is gone; safe to soft-archive.
 *
 *   3. Junk pattern archive  → isLikelyAutomated() heuristic for
 *      no-reply / mailer-daemon / newsletter prefixes (existing rule).
 *
 *   4. Suggest merges (NEVER apply)  → rows that share a strong
 *      identifier (same email, or same normalized phone) but live
 *      under distinct ids. Merge candidates surface to the UI for
 *      user confirmation — Brain never destructively merges contacts
 *      without explicit user action (trust ceiling).
 *
 * What Brain does NOT do:
 *   - Hard-delete (typed-phrase confirm; user-only).
 *   - Auto-merge (irreversible if wrong; user-only).
 *   - Auto-publish (scope=tenant; user-only per locked 2026-05-25 rule).
 *   - Auto-mute (scope=private; user-only).
 *
 * Reversibility: every archived row keeps full metadata; status flips
 * 'active'|'orphan' → 'archived' with archivedReason. Repointed rows
 * keep their content; only user_id changes. Restore via the existing
 * archive UI or SQL `UPDATE wiki_pages SET status=... WHERE id=...`.
 *
 * Per-user audit: every action stamps last_updated_by =
 * 'smart_cleanup' + a metadata audit object identifying which actor
 * (cron vs user-triggered) and which run-id.
 *
 * Idempotent: safe to run repeatedly (next run finds 0 actions if
 * nothing changed).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { isLikelyAutomated } from './senderQualityFilter';

const log = createLogger('smart-cleanup');

export interface SmartCleanupOptions {
  dryRun?: boolean;
  /** When true, this is a cron call (system-wide, all tenants).
   *  When false, this is a user-triggered call (single user). */
  cronMode?: boolean;
  /** Bonus grace: don't archive rows newer than this many days as
   *  no_evidence — Google Contacts imports may not have feed events
   *  yet but the user may still want them. Default 30. */
  noEvidenceGraceDays?: number;
}

export interface MergeCandidate {
  primaryId: string;
  secondaryIds: string[];
  basis: 'email' | 'phone';
  identifier: string;
  titles: string[];
}

export interface SmartCleanupResult {
  scanned: number;
  leakedRepointed: number;
  leakedArchivedDuplicate: number;
  noEvidenceArchived: number;
  junkArchived: number;
  mergesSuggested: MergeCandidate[];
  errors: number;
}

const EMPTY: SmartCleanupResult = {
  scanned: 0,
  leakedRepointed: 0,
  leakedArchivedDuplicate: 0,
  noEvidenceArchived: 0,
  junkArchived: 0,
  mergesSuggested: [],
  errors: 0,
};

/**
 * Run Smart Cleanup for one user in one tenant.
 *
 * The evidence rule (load-bearing):
 *   A user X has a claim on row R iff
 *     (a) ≥1 feed_event with user_id=X matches R.email OR R.phone
 *         (unwrap sender_email of RFC2822 "Name" <email> form), OR
 *     (b) metadata.user_stars[X] > 0, OR
 *     (c) metadata.publicSetBy = X, brainMutedBy = X, markedInactiveBy = X, OR
 *     (d) (metadata.userRenamed = true AND user_id = X), OR
 *     (e) metadata.imported_from = 'google_contacts' AND user_id = X, OR
 *     (f) metadata.source = 'manual' AND user_id = X.
 *
 * Best claim wins (highest feed-event count; tiebreaker = lowest user_id).
 */
export async function runSmartCleanupForUser(
  clientNumber: string,
  userId: number,
  opts: SmartCleanupOptions = {},
): Promise<SmartCleanupResult> {
  const result: SmartCleanupResult = { ...EMPTY, mergesSuggested: [] };
  const dryRun = opts.dryRun === true;
  const graceDays = Math.max(0, opts.noEvidenceGraceDays ?? 30);
  const runId = `${clientNumber}_${userId}_${Date.now()}`;

  // 1. Snapshot every entity_person row currently visible (active +
  //    orphan + stale) and joinable by this user's tenant.
  const rows = await prisma.$queryRawUnsafe<Array<{
    id: string;
    title: string;
    user_id: number;
    status: string;
    metadata: any;
    created_at: Date;
  }>>(
    `SELECT id, title, user_id, status, metadata, created_at
       FROM wiki_pages
      WHERE client_number = $1
        AND page_type = 'entity_person'
        AND status NOT IN ('archived','inactive','deleted','contradicted')`,
    clientNumber,
  ).catch((err) => { log.warn('row snapshot failed', { clientNumber, err: err.message }); return [] as any[]; });

  result.scanned = rows.length;
  if (rows.length === 0) return result;

  // 2. Tenant users (we score claims per user).
  const tenantUsers = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    `SELECT id FROM users WHERE client_number = $1 AND is_active = TRUE`,
    clientNumber,
  );
  const tenantUserIds = tenantUsers.map((u) => u.id);

  // 3. Aggregate feed evidence ONCE for the whole tenant (instead of
  //    per-row, which would be 1000+ subqueries).
  //    Map: { 'email|phone_digits' → { userId → eventCount } }
  const evidenceMap = new Map<string, Map<number, number>>();
  const feedRows = await prisma.$queryRawUnsafe<Array<{
    user_id: number;
    email: string;
    phone_digits: string;
    events: number;
  }>>(
    `SELECT user_id,
            COALESCE(LOWER(substring(sender_email FROM '<([^>]+)>')), LOWER(sender_email)) AS email,
            regexp_replace(COALESCE(sender_phone,''), '[^0-9+]','','g')               AS phone_digits,
            COUNT(*)::int                                                              AS events
       FROM feed_events
      WHERE client_number = $1
      GROUP BY 1, 2, 3`,
    clientNumber,
  ).catch(() => [] as any[]);
  for (const f of feedRows) {
    const keyEmail = f.email ? `email:${f.email}` : null;
    const keyPhone = f.phone_digits ? `phone:${f.phone_digits}` : null;
    for (const k of [keyEmail, keyPhone].filter(Boolean) as string[]) {
      let inner = evidenceMap.get(k);
      if (!inner) { inner = new Map(); evidenceMap.set(k, inner); }
      inner.set(f.user_id, (inner.get(f.user_id) ?? 0) + f.events);
    }
  }

  // 4. Title index for duplicate-collision detection.
  //    Map: 'userId|title' → existing row id
  const titleIndex = new Map<string, string>();
  for (const r of rows) titleIndex.set(`${r.user_id}|${r.title}`, r.id);

  // 5. Process each row: decide action.
  const actions: Array<
    | { type: 'repoint'; rowId: string; newOwner: number }
    | { type: 'archive_duplicate'; rowId: string; realOwner: number }
    | { type: 'archive_no_evidence'; rowId: string }
    | { type: 'archive_junk'; rowId: string; email: string }
  > = [];

  for (const r of rows) {
    const md = r.metadata ?? {};
    const email = String(md.email ?? '').trim().toLowerCase();
    const phoneDigits = String(md.phone ?? '').replace(/[^\d+]/g, '');

    // Junk filter — only applies if the row's owner doesn't have user-
    // action evidence (the user explicitly engaged with this contact).
    if (email && isLikelyAutomated(email)) {
      const hasUserAction =
        (md.user_stars?.[String(r.user_id)] ?? 0) > 0
        || md.publicSetBy === r.user_id
        || md.userRenamed === true;
      if (!hasUserAction) {
        actions.push({ type: 'archive_junk', rowId: r.id, email });
        continue;
      }
    }

    // Compute claim score per user.
    const claims = new Map<number, number>();
    const addClaim = (uid: number, score: number) => {
      if (!Number.isFinite(uid) || score <= 0) return;
      claims.set(uid, (claims.get(uid) ?? 0) + score);
    };
    if (email) {
      const inner = evidenceMap.get(`email:${email}`);
      if (inner) for (const [uid, n] of inner) addClaim(uid, n);
    }
    if (phoneDigits) {
      const inner = evidenceMap.get(`phone:${phoneDigits}`);
      if (inner) for (const [uid, n] of inner) addClaim(uid, n);
    }
    // User-action audit (large constant — any user touch outweighs raw counts).
    const userStars = (md.user_stars ?? {}) as Record<string, unknown>;
    for (const uidStr of Object.keys(userStars)) {
      if ((userStars[uidStr] ?? 0) as number > 0) addClaim(Number(uidStr), 100);
    }
    if (Number.isFinite(Number(md.publicSetBy)))         addClaim(Number(md.publicSetBy),       100);
    if (Number.isFinite(Number(md.brainMutedBy)))        addClaim(Number(md.brainMutedBy),      100);
    if (Number.isFinite(Number(md.markedInactiveBy)))    addClaim(Number(md.markedInactiveBy),  100);
    if (md.userRenamed === true)                         addClaim(r.user_id,                    100);
    // Import-path claims (medium weight — claims by row's current user_id).
    if (md.imported_from === 'google_contacts')          addClaim(r.user_id,                     50);
    if (md.source === 'manual')                          addClaim(r.user_id,                     10);

    // Best owner.
    let bestOwner: number | null = null;
    let bestScore = 0;
    for (const [uid, score] of claims) {
      if (!tenantUserIds.includes(uid)) continue;
      if (score > bestScore || (score === bestScore && bestOwner !== null && uid < bestOwner)) {
        bestOwner = uid;
        bestScore = score;
      }
    }

    if (bestOwner === null) {
      // No claim at all. Grace for newly-created rows.
      const ageDays = (Date.now() - new Date(r.created_at).getTime()) / 86_400_000;
      if (ageDays >= graceDays) {
        actions.push({ type: 'archive_no_evidence', rowId: r.id });
      }
      continue;
    }

    if (bestOwner === r.user_id) continue;  // already correctly owned

    // New owner differs — does the target user already have a row with
    // this title? If yes → archive duplicate. Else → repoint.
    const collisionKey = `${bestOwner}|${r.title}`;
    if (titleIndex.has(collisionKey) && titleIndex.get(collisionKey) !== r.id) {
      actions.push({ type: 'archive_duplicate', rowId: r.id, realOwner: bestOwner });
    } else {
      actions.push({ type: 'repoint', rowId: r.id, newOwner: bestOwner });
      // Update titleIndex to reflect the repoint (so a second collision
      // in the same batch is detected).
      titleIndex.delete(`${r.user_id}|${r.title}`);
      titleIndex.set(collisionKey, r.id);
    }
  }

  // 6. Suggest merge candidates: same email or same phone, distinct ids.
  //    We DO NOT auto-merge — surface for user confirmation only.
  const byEmail = new Map<string, Array<{ id: string; title: string; userId: number }>>();
  const byPhone = new Map<string, Array<{ id: string; title: string; userId: number }>>();
  for (const r of rows) {
    // Skip rows we're about to archive in this same pass.
    if (actions.some((a) => a.rowId === r.id && a.type !== 'repoint')) continue;
    const md = r.metadata ?? {};
    const email = String(md.email ?? '').trim().toLowerCase();
    const phoneDigits = String(md.phone ?? '').replace(/[^\d+]/g, '');
    // Only suggest merges within the caller's visible scope (this user
    // owns it, OR scope=tenant, OR in discovered_by_users).
    const inScope =
      r.user_id === userId
      || md.scope === 'tenant'
      || (Array.isArray(md.discovered_by_users) && md.discovered_by_users.includes(userId));
    if (!inScope) continue;
    if (email) {
      const arr = byEmail.get(email) ?? [];
      arr.push({ id: r.id, title: r.title, userId: r.user_id });
      byEmail.set(email, arr);
    }
    if (phoneDigits) {
      const arr = byPhone.get(phoneDigits) ?? [];
      arr.push({ id: r.id, title: r.title, userId: r.user_id });
      byPhone.set(phoneDigits, arr);
    }
  }
  for (const [email, arr] of byEmail) {
    if (arr.length < 2) continue;
    result.mergesSuggested.push({
      primaryId: arr[0].id,
      secondaryIds: arr.slice(1).map((a) => a.id),
      basis: 'email', identifier: email,
      titles: arr.map((a) => a.title),
    });
  }
  for (const [phone, arr] of byPhone) {
    if (arr.length < 2) continue;
    // Skip if already suggested via email
    const ids = new Set(arr.map((a) => a.id));
    if (result.mergesSuggested.some((s) => s.secondaryIds.concat(s.primaryId).some((x) => ids.has(x)))) continue;
    result.mergesSuggested.push({
      primaryId: arr[0].id,
      secondaryIds: arr.slice(1).map((a) => a.id),
      basis: 'phone', identifier: phone,
      titles: arr.map((a) => a.title),
    });
  }

  // 7. DryRun → return plan, don't mutate.
  if (dryRun) {
    for (const a of actions) {
      if (a.type === 'repoint')             result.leakedRepointed += 1;
      else if (a.type === 'archive_duplicate')   result.leakedArchivedDuplicate += 1;
      else if (a.type === 'archive_no_evidence') result.noEvidenceArchived += 1;
      else if (a.type === 'archive_junk')        result.junkArchived += 1;
    }
    return result;
  }

  // 8. Apply.
  const actor = opts.cronMode ? 'smart_cleanup_cron' : 'smart_cleanup_user';
  for (const a of actions) {
    try {
      if (a.type === 'repoint') {
        await prisma.$executeRawUnsafe(
          `UPDATE wiki_pages
              SET user_id = $1,
                  last_updated_at = NOW(),
                  last_updated_by = $2,
                  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                    'lastRepointBy', $2,
                    'lastRepointAt', NOW()::text,
                    'lastRepointRunId', $3::text
                  )
            WHERE id = $4 AND client_number = $5 AND page_type = 'entity_person'`,
          a.newOwner, actor, runId, a.rowId, clientNumber,
        );
        result.leakedRepointed += 1;
      } else if (a.type === 'archive_duplicate') {
        await prisma.$executeRawUnsafe(
          `UPDATE wiki_pages
              SET status = 'archived',
                  last_updated_at = NOW(),
                  last_updated_by = $1,
                  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                    'archivedReason',   'leaked_duplicate_of_real_owner',
                    'archivedAt',        NOW()::text,
                    'archivedBy',        $1,
                    'archivedRunId',     $2::text,
                    'realOwnerUserId',   $3::int
                  )
            WHERE id = $4 AND client_number = $5 AND page_type = 'entity_person'`,
          actor, runId, a.realOwner, a.rowId, clientNumber,
        );
        result.leakedArchivedDuplicate += 1;
      } else if (a.type === 'archive_no_evidence') {
        await prisma.$executeRawUnsafe(
          `UPDATE wiki_pages
              SET status = 'archived',
                  last_updated_at = NOW(),
                  last_updated_by = $1,
                  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                    'archivedReason', 'no_evidence',
                    'archivedAt',      NOW()::text,
                    'archivedBy',      $1,
                    'archivedRunId',   $2::text
                  )
            WHERE id = $3 AND client_number = $4 AND page_type = 'entity_person'`,
          actor, runId, a.rowId, clientNumber,
        );
        result.noEvidenceArchived += 1;
      } else if (a.type === 'archive_junk') {
        await prisma.$executeRawUnsafe(
          `UPDATE wiki_pages
              SET status = 'archived',
                  last_updated_at = NOW(),
                  last_updated_by = $1,
                  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                    'archivedReason',  'junk_filter',
                    'archivedAt',       NOW()::text,
                    'archivedBy',       $1,
                    'archivedRunId',    $2::text,
                    'archivedEmail',    $3::text
                  )
            WHERE id = $4 AND client_number = $5 AND page_type = 'entity_person'`,
          actor, runId, a.email, a.rowId, clientNumber,
        );
        result.junkArchived += 1;
      }
    } catch (err: any) {
      log.warn('smart-cleanup action failed', { runId, rowId: a.rowId, type: a.type, err: err.message });
      result.errors += 1;
    }
  }

  log.info('smart-cleanup ran', {
    runId, clientNumber, userId,
    leakedRepointed: result.leakedRepointed,
    leakedArchivedDuplicate: result.leakedArchivedDuplicate,
    noEvidenceArchived: result.noEvidenceArchived,
    junkArchived: result.junkArchived,
    mergesSuggested: result.mergesSuggested.length,
    errors: result.errors,
  });
  return result;
}

/**
 * Cron entry: iterate every (tenant, active user) and run cleanup.
 * Errors per user are swallowed — one user's failure doesn't block
 * the rest of the tenant.
 */
export async function runSmartCleanupAllUsers(): Promise<{
  tenants: number; users: number; aggregate: SmartCleanupResult;
}> {
  const agg: SmartCleanupResult = { ...EMPTY, mergesSuggested: [] };
  const tenants = await prisma.$queryRawUnsafe<Array<{ client_number: string }>>(
    `SELECT DISTINCT client_number FROM users WHERE is_active = TRUE`,
  );
  let userCount = 0;
  for (const t of tenants) {
    const users = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
      `SELECT id FROM users WHERE client_number = $1 AND is_active = TRUE`,
      t.client_number,
    );
    for (const u of users) {
      userCount += 1;
      const r = await runSmartCleanupForUser(t.client_number, u.id, { cronMode: true })
        .catch((err) => { log.warn('cron user failed', { tenant: t.client_number, user: u.id, err: err.message }); return null; });
      if (r) {
        agg.scanned += r.scanned;
        agg.leakedRepointed += r.leakedRepointed;
        agg.leakedArchivedDuplicate += r.leakedArchivedDuplicate;
        agg.noEvidenceArchived += r.noEvidenceArchived;
        agg.junkArchived += r.junkArchived;
        agg.errors += r.errors;
        // Don't aggregate mergesSuggested across users — per-user only.
      }
    }
  }
  return { tenants: tenants.length, users: userCount, aggregate: agg };
}
