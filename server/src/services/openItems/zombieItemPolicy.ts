/**
 * Deterministic, reversible policy for malformed open-item residue.
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
  | 'dangling_fragment';

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
export function classifyZombieOpenItem(item: ZombiePolicyItem): ZombieReason | null {
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

  return null;
}

function existingSelfPrune(metadata: unknown): SelfPruneMetadata | null {
  const value = asRecord(asRecord(metadata).selfPrune);
  if (value.version !== SELF_PRUNE_POLICY_VERSION) return null;
  if (!['quarantined', 'recovered', 'archived'].includes(value.state)) return null;
  if (!['empty_title', 'placeholder_title', 'dangling_fragment'].includes(value.reason)) return null;
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
): ZombieLifecyclePlan {
  const reason = classifyZombieOpenItem(item);
  const existing = existingSelfPrune(item.metadata);
  const nowIso = now.toISOString();

  if (!reason) {
    if (existing?.state !== 'quarantined') return { action: 'none' };
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

