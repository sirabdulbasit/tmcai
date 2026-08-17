/**
 * Deterministic, reversible policy for open-item junk: malformed residue and
 * (DEF-186, C-3 increment 3) well-formed items with no engagement past the
 * user's stale window.
 *
 * This module deliberately does not use an LLM. A candidate is first
 * quarantined (proactive messages suppressed), then soft-closed only after a
 * grace period. Items with evidence of user engagement are never candidates.
 */

export const SELF_PRUNE_POLICY_VERSION = 1;
export const DEFAULT_ZOMBIE_QUARANTINE_DAYS = 7;

export type ZombieReason =
  | 'empty_title'
  | 'placeholder_title'
  | 'dangling_fragment'
  // C-3 increment 3 — a well-formed item nobody has touched for the user's
  // stale window. Same reversible lifecycle as the malformed reasons; the
  // difference is only how it is detected (age + no engagement, not title
  // shape), so the detection needs the caller to supply the window.
  | 'stale_no_engagement';

export interface ZombiePolicyItem {
  title: string;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  dueDate?: Date | string | null;
  delegateeId?: number | null;
  delegateeName?: string | null;
  delegateeEmail?: string | null;
  notes?: unknown;
  metadata?: unknown;
  createdAt?: Date | string | null;
}

export interface StalePruneOptions {
  /**
   * The user's no-engagement window in days.
   *
   * `undefined` — this caller did not resolve the user's setting and cannot
   * judge staleness: stale detection is off AND an existing stale quarantine
   * is HELD, never recovered, so a caller that cannot see the window cannot
   * release what another caller quarantined.
   * `<= 0` — the user disabled the stale sweep: no stale detection, and an
   * existing stale quarantine is released (recover).
   * `> 0` — an item created longer ago than this, with no engagement
   * evidence, is 'stale_no_engagement'.
   */
  staleAfterDays?: number | null;
}

export interface SelfPruneMetadata {
  version: number;
  state: 'quarantined' | 'recovered' | 'archived';
  reason: ZombieReason;
  suppressProactive: boolean;
  detectedAt: string;
  lastEvaluatedAt: string;
  recoveredAt?: string;
  archivedAt?: string;
}

export type ZombieLifecyclePlan =
  | { action: 'none' }
  | { action: 'hold'; reason: ZombieReason; selfPrune: SelfPruneMetadata }
  | { action: 'quarantine'; reason: ZombieReason; selfPrune: SelfPruneMetadata }
  | { action: 'recover'; previous: SelfPruneMetadata; selfPrune: SelfPruneMetadata }
  | { action: 'archive'; reason: ZombieReason; selfPrune: SelfPruneMetadata };

const PLACEHOLDER_TITLES = new Set([
  'untitled',
  'no title',
  'unknown task',
  'new task',
  'tbd',
  'todo',
  'n/a',
]);

// These words require an object after them in a useful task title. Keeping the
// list intentionally small is a safety choice: false negatives merely remain
// visible, while false positives could hide real work.
const DANGLING_END_RE = /\b(?:of|to|for|with|about|regarding|from|and|or|the|a|an)\s*[.:;,_-]*$/i;

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function hasNotes(notes: unknown): boolean {
  if (Array.isArray(notes)) return notes.length > 0;
  return typeof notes === 'string' && notes.trim().length > 0;
}

function hasEngagementEvidence(item: ZombiePolicyItem): boolean {
  const meta = asRecord(item.metadata);
  const draft = asRecord(meta.draft);
  return Boolean(
    hasNotes(item.notes)
    || item.delegateeId
    || item.delegateeName?.trim()
    || item.delegateeEmail?.trim()
    || item.dueDate
    || meta.userConfirmedAt
    || meta.userEditedAt
    || meta.manualEditAt
    || draft.userRepliedAt
    || draft.resolvedAt
  );
}

/** Return a high-confidence reason, or null when the item must be preserved. */
export function classifyZombieOpenItem(
  item: ZombiePolicyItem,
  now = new Date(),
  opts?: StalePruneOptions,
): ZombieReason | null {
  const status = String(item.status ?? '').toUpperCase();
  if (!['DRAFT', 'NEW', 'TRIAGED', 'OPEN'].includes(status)) return null;
  if (String(item.priority ?? '').toLowerCase() === 'critical') return null;
  if (hasEngagementEvidence(item)) return null;

  const title = String(item.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title || !/[\p{L}\p{N}]/u.test(title)) return 'empty_title';
  if (PLACEHOLDER_TITLES.has(title.toLowerCase())) return 'placeholder_title';

  // A useful description can rescue a terse/incomplete title. This keeps the
  // policy focused on records that lack enough information to act on.
  const description = String(item.description ?? '').replace(/\s+/g, ' ').trim();
  const hasUsefulDescription = description.length >= 24
    && description.toLowerCase() !== title.toLowerCase();
  if (!hasUsefulDescription && title.split(' ').length >= 2 && DANGLING_END_RE.test(title)) {
    return 'dangling_fragment';
  }

  // Stale last: the malformed reasons are more specific and keep their
  // identity for items that are both malformed and old. A well-formed title
  // does not rescue an item nobody has engaged with for the whole window —
  // engagement evidence (checked above) is the rescue.
  const staleAfterDays = opts?.staleAfterDays;
  if (typeof staleAfterDays === 'number' && staleAfterDays > 0 && item.createdAt != null) {
    const created = new Date(item.createdAt as any);
    if (Number.isFinite(created.getTime())
      && now.getTime() - created.getTime() >= Math.round(staleAfterDays) * 86_400_000) {
      return 'stale_no_engagement';
    }
  }

  return null;
}

function existingSelfPrune(metadata: unknown): SelfPruneMetadata | null {
  const value = asRecord(asRecord(metadata).selfPrune);
  if (value.version !== SELF_PRUNE_POLICY_VERSION) return null;
  if (!['quarantined', 'recovered', 'archived'].includes(value.state)) return null;
  if (!['empty_title', 'placeholder_title', 'dangling_fragment', 'stale_no_engagement'].includes(value.reason)) return null;
  if (typeof value.detectedAt !== 'string') return null;
  return value as SelfPruneMetadata;
}

/**
 * Plan the next lifecycle step without writing anything.
 *
 * quarantine -> hold -> archive is recoverable at every point because archive
 * means status=CLOSED plus audit metadata, never a database delete.
 */
export function planZombieLifecycle(
  item: ZombiePolicyItem,
  now = new Date(),
  quarantineDays = DEFAULT_ZOMBIE_QUARANTINE_DAYS,
  opts?: StalePruneOptions,
): ZombieLifecyclePlan {
  const reason = classifyZombieOpenItem(item, now, opts);
  const existing = existingSelfPrune(item.metadata);
  const nowIso = now.toISOString();

  if (!reason) {
    if (existing?.state !== 'quarantined') return { action: 'none' };
    // A stale quarantine can only be released by a caller that resolved the
    // user's window. To every other caller a stale-quarantined item looks
    // healthy by construction (its title is fine) — recovering it here would
    // let a caller that never evaluated staleness undo a decision it cannot
    // re-make, so it holds instead.
    if (existing.reason === 'stale_no_engagement' && opts?.staleAfterDays === undefined) {
      return { action: 'none' };
    }
    return {
      action: 'recover',
      previous: existing,
      selfPrune: {
        ...existing,
        state: 'recovered',
        suppressProactive: false,
        recoveredAt: nowIso,
        lastEvaluatedAt: nowIso,
      },
    };
  }

  const sameQuarantine = existing?.state === 'quarantined' && existing.reason === reason;
  const detectedAt = sameQuarantine ? new Date(existing.detectedAt) : now;
  const validDetectedAt = Number.isFinite(detectedAt.getTime()) ? detectedAt : now;
  const graceMs = Math.max(1, Math.min(30, Math.round(quarantineDays))) * 86_400_000;
  const base: SelfPruneMetadata = {
    version: SELF_PRUNE_POLICY_VERSION,
    state: 'quarantined',
    reason,
    suppressProactive: true,
    detectedAt: validDetectedAt.toISOString(),
    lastEvaluatedAt: nowIso,
  };

  if (!sameQuarantine) return { action: 'quarantine', reason, selfPrune: base };
  if (now.getTime() - validDetectedAt.getTime() < graceMs) {
    return { action: 'hold', reason, selfPrune: { ...existing, ...base } };
  }

  return {
    action: 'archive',
    reason,
    selfPrune: {
      ...existing,
      ...base,
      state: 'archived',
      suppressProactive: true,
      archivedAt: nowIso,
    },
  };
}

