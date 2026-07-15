/**
 * MyOS — Rule Miner.
 *
 * Scans decision_logs + delegation_logs aggregated by dedup_hash. Any
 * pattern that meets the evidence/agreement threshold gets upserted as a
 * shadow_rule row with mode=DRAFT or SHADOW. The existing promotion flow in
 * shadowRoutes (/rules/promotion-ready → MD clicks Activate) carries the
 * rule from SHADOW to ACTIVE.
 *
 * Thresholds:
 *   DRAFT   — evidence ≥ 3  AND agreement ≥ 0.70
 *   SHADOW  — evidence ≥ 10 AND agreement ≥ 0.95
 *
 * Evidence is computed over the last 30 days only — old patterns that the MD
 * no longer follows shouldn't crystallize into rules.
 *
 * The dedup_hash IS the trigger key. Triage suggester computes the hash on
 * every new feed_event; if there's an ACTIVE rule with that hash, Brain
 * executes the rule's action autonomously without surfacing the item in My
 * Attention. That row shows up in Section 1 (Brief) of Day Brief.
 */
import prisma from '../../db/prisma';

export interface MinerRunSummary {
  scanned: number;
  drafts: number;
  shadows: number;
  unchanged: number;
  errors: number;
  durationMs: number;
}

const WINDOW_DAYS = 30;

// Defaults if the user hasn't configured their own thresholds yet. Every
// user can override both via Settings → Brain Autonomy.
const DEFAULT_OCCURRENCES = 10;
const DEFAULT_AGREEMENT = 0.90;

/** Per-user thresholds: how much evidence Brain needs before starting to
 *  act on its own. DRAFT is a first-draft rule (Brain asks MD to confirm);
 *  SHADOW is auto-promoted (MD sees it in "Ready to handle on my own");
 *  ACTIVE is the end state where Brain acts autonomously. */
interface UserThresholds {
  draftOccurrences: number;
  draftAgreement: number;
  shadowOccurrences: number;
  shadowAgreement: number;
}

async function getUserThresholds(userId: number): Promise<UserThresholds> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPreferences: true },
  });
  const prefs = (u?.notificationPreferences as any) ?? {};
  const cfg = prefs.brain_autonomy ?? {};
  const shadowOcc = Number.isFinite(cfg.occurrences) && cfg.occurrences >= 2 ? Math.round(cfg.occurrences) : DEFAULT_OCCURRENCES;
  const shadowAgr = Number.isFinite(cfg.agreement) && cfg.agreement >= 0.5 ? cfg.agreement : DEFAULT_AGREEMENT;
  // Draft threshold sits below SHADOW: lowest of (half of shadow) and 3.
  const draftOcc = Math.max(3, Math.ceil(shadowOcc / 2));
  const draftAgr = Math.max(0.7, shadowAgr - 0.2);
  return { draftOccurrences: draftOcc, draftAgreement: draftAgr, shadowOccurrences: shadowOcc, shadowAgreement: shadowAgr };
}

interface PatternRow {
  client_number: string;
  user_id: number;
  dedup_hash: string;
  dominant_action: string;
  dominant_count: number;
  total_count: number;
  item_type: string;
  archetype: string | null;
  agreement: number;
}

/**
 * Walk every tenant's user-scoped pattern aggregates and upsert shadow_rules
 * for anything past the threshold.
 */
export async function mineRulesForAllTenants(): Promise<MinerRunSummary> {
  const t0 = Date.now();
  const summary: MinerRunSummary = { scanned: 0, drafts: 0, shadows: 0, unchanged: 0, errors: 0, durationMs: 0 };

  // Combined pull from decision_logs + delegation_logs so both action types
  // contribute to the same hash. `item_type` and `archetype` come from the
  // most-recent row (best effort). Last 30 days only.
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows = await prisma.$queryRawUnsafe<PatternRow[]>(
    // Brain learns ONLY from USER-authored rows. Brain's own autonomous
    // delegations are excluded (session_type='override' is user teaching too)
    // so we don't get a self-reinforcing feedback loop where a rule votes
    // for itself. delegation_logs.delegated_by='brain' rows are skipped.
    `WITH combined AS (
       SELECT client_number, user_id, dedup_hash, user_decision AS action,
              item_type, NULL::varchar AS archetype, created_at
       FROM decision_logs
       WHERE created_at >= $1 AND dedup_hash IS NOT NULL AND user_id IS NOT NULL
       UNION ALL
       SELECT client_number, user_id, dedup_hash, 'delegate' AS action,
              item_type, task_archetype AS archetype, created_at
       FROM delegation_logs
       WHERE created_at >= $1 AND delegated_by = 'user'
     ),
     aggregated AS (
       SELECT client_number, user_id, dedup_hash, action,
              COUNT(*)::int AS action_count,
              (SELECT item_type FROM combined c2
                WHERE c2.client_number=c.client_number AND c2.user_id=c.user_id
                  AND c2.dedup_hash=c.dedup_hash ORDER BY created_at DESC LIMIT 1) AS item_type,
              (SELECT archetype FROM combined c2
                WHERE c2.client_number=c.client_number AND c2.user_id=c.user_id
                  AND c2.dedup_hash=c.dedup_hash AND archetype IS NOT NULL
                ORDER BY created_at DESC LIMIT 1) AS archetype
       FROM combined c
       GROUP BY client_number, user_id, dedup_hash, action
     ),
     totals AS (
       SELECT client_number, user_id, dedup_hash, SUM(action_count)::int AS total_count
       FROM aggregated GROUP BY client_number, user_id, dedup_hash
     )
     SELECT a.client_number, a.user_id, a.dedup_hash, a.action AS dominant_action,
            a.action_count AS dominant_count, t.total_count,
            COALESCE(a.item_type, 'email') AS item_type,
            a.archetype,
            (a.action_count::float / t.total_count) AS agreement
     FROM aggregated a
     JOIN totals t USING (client_number, user_id, dedup_hash)
     WHERE a.action_count = (
       SELECT MAX(action_count) FROM aggregated a2
       WHERE a2.client_number=a.client_number AND a2.user_id=a.user_id AND a2.dedup_hash=a.dedup_hash
     )
       AND t.total_count >= 3`,
    since,
  );

  summary.scanned = rows.length;

  // Cache thresholds per user so we don't query for every row
  const thresholdCache = new Map<number, UserThresholds>();
  const resolveThresholds = async (userId: number): Promise<UserThresholds> => {
    if (!thresholdCache.has(userId)) thresholdCache.set(userId, await getUserThresholds(userId));
    return thresholdCache.get(userId)!;
  };

  for (const p of rows) {
    try {
      const thresholds = await resolveThresholds(p.user_id);
      const qualifiesShadow = p.total_count >= thresholds.shadowOccurrences && p.agreement >= thresholds.shadowAgreement;
      const qualifiesDraft = p.total_count >= thresholds.draftOccurrences && p.agreement >= thresholds.draftAgreement;
      if (!qualifiesDraft) continue;

      const targetMode = qualifiesShadow ? 'SHADOW' : 'DRAFT';
      const ruleId = `rm_${p.client_number}_${p.user_id}_${p.dedup_hash.slice(0, 12)}`;
      const existing = await prisma.shadowRule.findUnique({ where: { id: ruleId } }).catch(() => null);

      // Derive sender_domain + canonical-delegatee from a representative
      // feed_event linked to any decision_log that shares this hash. This
      // makes the auto-generated rule name self-describing instead of the
      // useless "auto: email dismissed" repeated across rules.
      const ctx = await prisma.$queryRawUnsafe<Array<{ sender_domain: string | null; delegatee_name: string | null }>>(
        `SELECT
           (SELECT SUBSTRING(fe.sender_email FROM '.*@([^>]+)')
              FROM feed_events fe
              JOIN decision_logs dl ON dl.entity_id = fe.id
              WHERE dl.client_number=$1 AND dl.user_id=$2 AND dl.dedup_hash=$3
              LIMIT 1) AS sender_domain,
           (SELECT delegatee_name
              FROM delegation_logs
              WHERE client_number=$1 AND user_id=$2 AND dedup_hash=$3 AND delegatee_name IS NOT NULL
              ORDER BY created_at DESC LIMIT 1) AS delegatee_name`,
        p.client_number, p.user_id, p.dedup_hash,
      ).catch(() => [{ sender_domain: null, delegatee_name: null }]);
      const senderDomain = (ctx[0]?.sender_domain ?? '').replace(/[>\s]/g, '').toLowerCase().trim();
      const delegateeName = ctx[0]?.delegatee_name ?? null;

      const fromPart = senderDomain ? `from ${senderDomain}` : `(${p.archetype ?? 'untagged'})`;
      const name =
        p.dominant_action === 'dismissed' ? `auto: archive ${p.item_type}s ${fromPart}` :
        p.dominant_action === 'approved'  ? `auto: reply to ${p.item_type}s ${fromPart}` :
        p.dominant_action === 'delegated' ? `auto: delegate ${p.item_type}s ${fromPart}${delegateeName ? ` to ${delegateeName}` : ''}` :
        p.dominant_action === 'snoozed'   ? `auto: add ${p.item_type}s ${fromPart} to Open Items` :
        `auto: ${p.dominant_action} ${p.item_type}s ${fromPart}`;

      const triggerCondition = {
        kind: 'dedup_hash',
        hash: p.dedup_hash,
        itemType: p.item_type,
        archetype: p.archetype ?? null,
        senderDomain: senderDomain || null,
      };

      if (!existing) {
        await prisma.shadowRule.create({
          data: {
            id: ruleId,
            clientNumber: p.client_number,
            userId: p.user_id,
            name,
            description: `MD chose "${p.dominant_action}" ${p.dominant_count} of ${p.total_count} times (${Math.round(p.agreement * 100)}%)`,
            archetype: p.archetype,
            triggerCondition: triggerCondition as any,
            action: p.dominant_action,
            mode: targetMode,
            evidence: p.total_count,
            confirms: p.dominant_count,
            overrides: p.total_count - p.dominant_count,
            agreement: p.agreement,
          } as any,
        });
        if (targetMode === 'SHADOW') summary.shadows += 1;
        else summary.drafts += 1;
      } else {
        // Update counters; only promote mode (DRAFT → SHADOW), never demote
        // a rule the MD has already touched (ACTIVE / FROZEN).
        const newMode = existing.mode === 'ACTIVE' || existing.mode === 'FROZEN'
          ? existing.mode
          : (qualifiesShadow ? 'SHADOW' : existing.mode);
        const changed = existing.evidence !== p.total_count
          || existing.confirms !== p.dominant_count
          || existing.mode !== newMode
          || (existing.agreement ?? 0) !== p.agreement;
        if (!changed) { summary.unchanged += 1; continue; }
        // Respect user overrides: if MD set a manual action via PUT /rules/:id,
        // don't revert it here. Still refresh evidence + counters so the
        // pattern's learning stays visible.
        const meta = (existing.metadata as any) ?? {};
        const userLocked = meta?.userOverride === true;

        await prisma.shadowRule.update({
          where: { id: ruleId },
          data: {
            ...(userLocked ? {} : { name, action: p.dominant_action }),
            triggerCondition: triggerCondition as any,   // refresh so senderDomain is stored
            evidence: p.total_count,
            confirms: p.dominant_count,
            overrides: p.total_count - p.dominant_count,
            agreement: p.agreement,
            mode: newMode,
            description: userLocked
              ? `MD set action to "${existing.action}". Observed evidence: ${p.total_count} (dominant would be "${p.dominant_action}", ${Math.round(p.agreement * 100)}%).`
              : `MD chose "${p.dominant_action}" ${p.dominant_count} of ${p.total_count} times (${Math.round(p.agreement * 100)}%)`,
          } as any,
        });
        if (newMode === 'SHADOW' && existing.mode !== 'SHADOW') summary.shadows += 1;
      }
    } catch (err: any) {
      summary.errors += 1;
      console.warn(`[ruleMiner] upsert failed for ${p.dedup_hash}: ${err.message}`);
    }
  }

  summary.durationMs = Date.now() - t0;
  return summary;
}
