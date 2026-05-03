/**
 * MyOS Knowledge — People Intelligence.
 *
 * One of Brain's shared retrievers: given a work item (archetype + sender +
 * itemType) return the ranked list of internal people best placed to own
 * it, with human-readable reasons. Used by:
 *
 *   - Advisor/Secretary: triageSuggester turns suggestedAction='delegate'
 *     into "→ Delegate to Umair" by calling suggestOwner() and picking the
 *     top candidate.
 *   - Knowledge Center: /brain/ask endpoint calls the same function when
 *     the MD asks natural-language questions like "who should handle this
 *     UAE proposal?".
 *
 * Signals combined:
 *   (a) History match   — how many times the candidate has handled the
 *                         same dedup_hash (sender + archetype). High weight.
 *   (b) Archetype match — how many times they've handled the archetype in
 *                         general (even different sender). Medium weight.
 *   (c) Department fit  — whether their `department` tokens overlap with
 *                         the sender domain / archetype keywords.
 *   (d) Position fit    — whether their `job_description` / `about_me`
 *                         mentions archetype keywords.
 *   (e) Workload        — how many open items they currently own (inverse).
 *   (f) Recency         — when they last handled this archetype.
 *
 * Each signal contributes to a 0..1 score; reasons are emitted so the UI
 * can show the rationale without a blackbox ranking.
 */
import prisma from '../../db/prisma';
import { computeDedupHash, type ItemType, type Archetype } from '../triage/triageSuggester';

export interface OwnerSuggestion {
  userId: number;
  name: string;
  email: string;
  department?: string;
  jobDescription?: string;
  score: number;
  reasons: string[];
  signals: {
    historyMatch: number;
    archetypeMatch: number;
    departmentFit: number;
    positionFit: number;
    workloadFit: number;
    recency: number;
  };
}

export interface SuggestOwnerParams {
  clientNumber: string;
  itemType: ItemType;
  archetype: Archetype;
  senderDomain?: string;
  senderEmail?: string;
  /** Optional subject/preview text so we can keyword-match department/position */
  subject?: string;
  preview?: string;
  /** Exclude this userId from ranking (usually the MD doing the delegation) */
  excludeUserId?: number;
  /** How many candidates to return */
  limit?: number;
}

const ARCHETYPE_KEYWORDS: Record<Archetype, string[]> = {
  reply_needed: [],
  delegate: [],
  inform_only: [],
  schedule_meeting: ['calendar', 'scheduler', 'ops', 'coordinator'],
  review_risk: ['risk', 'legal', 'compliance', 'finance', 'audit', 'cfo'],
  acknowledge: [],
};

/** Tokenize a name / company / domain-ish string so it can be compared */
function tokens(s?: string): Set<string> {
  if (!s) return new Set();
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length >= 3),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit += 1;
  return hit / Math.max(a.size, b.size);
}

export async function suggestOwner(params: SuggestOwnerParams): Promise<OwnerSuggestion[]> {
  const { clientNumber, itemType, archetype, senderDomain, senderEmail, subject, preview, excludeUserId } = params;
  const limit = params.limit ?? 5;

  // (0) Candidates: active users in the tenant, excluding the delegator.
  const users = await prisma.user.findMany({
    where: {
      clientNumber,
      isActive: true,
      id: excludeUserId ? { not: excludeUserId } : undefined,
    },
    select: {
      id: true, name: true, email: true, department: true, jobDescription: true,
      aboutMe: true, userType: true,
    },
  });
  if (users.length === 0) return [];

  // (1 + 2) History signals — per-user counts for this archetype.
  // Delegation history against this exact dedup_hash is the strongest signal.
  const perUserDedupHash = computeDedupHash({
    userId: -1, // we don't scope by delegator here; rolled into SQL below
    itemType,
    archetype,
    senderDomain,
  });

  // We want: for each candidate delegatee, how many delegation_logs exist
  // where (dedup_hash matches) OR (archetype matches, as a weaker signal).
  const delegationCounts = await prisma.$queryRawUnsafe<Array<{ user_id: number | null; exact: number; archetype_match: number; last_at: Date | null }>>(
    `SELECT delegatee_user_id AS user_id,
            SUM(CASE WHEN dedup_hash = $1 THEN 1 ELSE 0 END)::int AS exact,
            SUM(CASE WHEN item_type = $2 AND task_archetype = $3 THEN 1 ELSE 0 END)::int AS archetype_match,
            MAX(created_at) AS last_at
       FROM delegation_logs
      WHERE client_number = $4
        AND delegatee_user_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '180 days'
      GROUP BY delegatee_user_id`,
    perUserDedupHash, itemType, archetype, clientNumber,
  ).catch(() => []);
  const histByUser = new Map<number, { exact: number; archetypeMatch: number; lastAt: Date | null }>();
  for (const r of delegationCounts) {
    if (r.user_id === null) continue;
    histByUser.set(r.user_id, { exact: r.exact, archetypeMatch: r.archetype_match, lastAt: r.last_at });
  }

  // (e) Workload — open items currently owned or delegated-to each user.
  const workloadRows = await prisma.$queryRawUnsafe<Array<{ user_id: number; n: number }>>(
    `SELECT COALESCE(delegatee_id, owner_id) AS user_id, COUNT(*)::int AS n
       FROM open_items
      WHERE client_number = $1
        AND status IN ('NEW','TRIAGED','IN_PROGRESS','WAITING_INFO','DELEGATED')
      GROUP BY COALESCE(delegatee_id, owner_id)`,
    clientNumber,
  ).catch(() => []);
  const workloadByUser = new Map<number, number>(workloadRows.filter((r) => r.user_id != null).map((r) => [r.user_id, r.n]));
  const maxWorkload = Math.max(1, ...Array.from(workloadByUser.values()));

  // Department/position keyword sets derived from context
  const contextTokens = new Set<string>([
    ...tokens(senderDomain),
    ...tokens(senderEmail),
    ...tokens(subject),
    ...tokens(preview),
    ...(ARCHETYPE_KEYWORDS[archetype] ?? []),
  ]);

  const ranked: OwnerSuggestion[] = users.map((u) => {
    const hist = histByUser.get(u.id) ?? { exact: 0, archetypeMatch: 0, lastAt: null };
    const deptToks = tokens(u.department ?? '');
    const posToks = new Set<string>([...tokens(u.jobDescription ?? ''), ...tokens(u.aboutMe ?? '')]);

    // Bounded normalizations
    const historyMatch = Math.min(1, hist.exact / 5);       // 5+ exact prior matches → saturated
    const archetypeMatch = Math.min(1, hist.archetypeMatch / 10);
    const departmentFit = overlap(deptToks, contextTokens);
    const positionFit = overlap(posToks, contextTokens);
    const w = workloadByUser.get(u.id) ?? 0;
    const workloadFit = 1 - w / maxWorkload;                // lower workload → higher score
    const recency = hist.lastAt
      ? Math.max(0, 1 - (Date.now() - hist.lastAt.getTime()) / (180 * 24 * 3600 * 1000))
      : 0;

    // Weighted sum. History dominates — Brain trusts the MD's prior delegation
    // patterns over inferred department/position fit.
    const score =
      0.40 * historyMatch +
      0.20 * archetypeMatch +
      0.15 * departmentFit +
      0.10 * positionFit +
      0.10 * workloadFit +
      0.05 * recency;

    const reasons: string[] = [];
    if (hist.exact > 0) reasons.push(`${hist.exact} prior match${hist.exact > 1 ? 'es' : ''} on this sender + archetype`);
    if (hist.archetypeMatch > hist.exact) reasons.push(`${hist.archetypeMatch} prior ${archetype.replace('_', ' ')} items`);
    if (u.department && departmentFit > 0) reasons.push(`${u.department} department`);
    if (positionFit > 0 && u.jobDescription) reasons.push(`role matches: ${(u.jobDescription ?? '').slice(0, 60)}`);
    if (workloadFit > 0.8) reasons.push(`low current workload (${w} open)`);
    else if (workloadFit < 0.3) reasons.push(`heavy workload (${w} open)`);

    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      department: u.department ?? undefined,
      jobDescription: u.jobDescription ?? undefined,
      score,
      reasons,
      signals: { historyMatch, archetypeMatch, departmentFit, positionFit, workloadFit, recency },
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}
