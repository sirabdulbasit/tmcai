/**
 * HaseebOS v15 §3.2 L2 — OpenItem lifecycle state machine.
 *
 * 9 statuses + 29 valid transitions. Anything else must be rejected at
 * lifecycleService.transitionStatus() and logged to item_status_history with
 * outcome='rejected'.
 *
 * Legend for guards:
 *   - delegatee_set: item.delegateeId OR delegateeEmail must be non-null
 *   - approval_id:   ctx.approvalId must be a valid approval row
 *   - resolution_reason: ctx.reason must be provided
 *   - is_owner_or_agent: actor must be the owner user or an agent
 *
 * Legend for approvals:
 *   - required: HIGH-risk transitions (e.g. closing without resolution) go
 *     through approval_requests before the transition is accepted.
 */

export type ItemStatus =
  | 'NEW'
  | 'TRIAGED'
  | 'IN_PROGRESS'
  | 'DELEGATED'
  | 'WAITING_INFO'
  | 'SNOOZED'
  | 'INFORMED'
  | 'CLOSED'
  // DEF-129 — CANCELLED: the work never happened and never will.
  //
  // Added because `remove_open_item` was writing this status DIRECTLY to
  // `open_items`, bypassing the matrix entirely, for the simple reason that the
  // matrix had no way to express it. CLOSED was the only terminal state, and
  // closing an item the owner asked to remove records work as completed that
  // was never done — the fabricated-completion class in the data rather than in
  // a sentence.
  //
  // It is REVERSIBLE by design (CANCELLED -> TRIAGED). Withdrawal is a decision,
  // and decisions get changed; a terminal cancel would make "actually, put that
  // back" impossible and push the owner toward re-creating the item, losing its
  // history.
  | 'CANCELLED';

export const ALL_STATUSES: readonly ItemStatus[] = [
  'NEW',
  'TRIAGED',
  'IN_PROGRESS',
  'DELEGATED',
  'WAITING_INFO',
  'SNOOZED',
  'INFORMED',
  'CLOSED',
  'CANCELLED',
] as const;

export type Guard =
  | 'delegatee_set'
  | 'approval_id'
  | 'resolution_reason'
  | 'is_owner_or_agent'
  | 'snooze_until_set';

export interface TransitionSpec {
  from: ItemStatus;
  to: ItemStatus;
  guards: Guard[];
  requiresApproval: boolean;
  description: string;
}

/**
 * The 29 transitions. Count is exact — any change requires documenting why.
 *
 * DEF-129 added 8: seven ways INTO `CANCELLED` (every non-terminal state) and
 * one way back out of it. `CLOSED -> CANCELLED` is deliberately absent —
 * cancelling completed work would rewrite history rather than record a decision.
 */
export const TRANSITIONS: readonly TransitionSpec[] = [
  // From NEW (4)
  { from: 'NEW', to: 'TRIAGED', guards: [], requiresApproval: false, description: 'Curator/Triage classified the item' },
  { from: 'NEW', to: 'IN_PROGRESS', guards: ['is_owner_or_agent'], requiresApproval: false, description: 'Owner picked it up directly without triage' },
  { from: 'NEW', to: 'INFORMED', guards: ['is_owner_or_agent'], requiresApproval: false, description: 'Noise / informational only' },
  { from: 'NEW', to: 'CLOSED', guards: ['resolution_reason'], requiresApproval: true, description: 'Immediate close — requires approval' },

  // From TRIAGED (5)
  { from: 'TRIAGED', to: 'IN_PROGRESS', guards: ['is_owner_or_agent'], requiresApproval: false, description: 'Started work' },
  { from: 'TRIAGED', to: 'DELEGATED', guards: ['delegatee_set'], requiresApproval: false, description: 'Delegated to another user' },
  { from: 'TRIAGED', to: 'SNOOZED', guards: ['snooze_until_set'], requiresApproval: false, description: 'Deferred until a future time' },
  { from: 'TRIAGED', to: 'INFORMED', guards: [], requiresApproval: false, description: 'Decided inform-only after triage' },
  { from: 'TRIAGED', to: 'CLOSED', guards: ['resolution_reason'], requiresApproval: false, description: 'Resolved during triage' },

  // From IN_PROGRESS (4)
  { from: 'IN_PROGRESS', to: 'WAITING_INFO', guards: [], requiresApproval: false, description: 'Blocked on external input' },
  { from: 'IN_PROGRESS', to: 'DELEGATED', guards: ['delegatee_set'], requiresApproval: false, description: 'Handed off after starting' },
  { from: 'IN_PROGRESS', to: 'SNOOZED', guards: ['snooze_until_set'], requiresApproval: false, description: 'Paused with a timer' },
  { from: 'IN_PROGRESS', to: 'CLOSED', guards: ['resolution_reason'], requiresApproval: false, description: 'Work complete' },

  // From DELEGATED (3)
  { from: 'DELEGATED', to: 'IN_PROGRESS', guards: ['is_owner_or_agent'], requiresApproval: false, description: 'Owner pulled it back' },
  { from: 'DELEGATED', to: 'WAITING_INFO', guards: [], requiresApproval: false, description: 'Delegatee needs something from owner' },
  { from: 'DELEGATED', to: 'CLOSED', guards: ['resolution_reason'], requiresApproval: false, description: 'Delegatee completed the work' },

  // From WAITING_INFO (2)
  { from: 'WAITING_INFO', to: 'IN_PROGRESS', guards: [], requiresApproval: false, description: 'Information arrived' },
  { from: 'WAITING_INFO', to: 'CLOSED', guards: ['resolution_reason', 'approval_id'], requiresApproval: true, description: 'Close while still blocked — needs approval' },

  // From SNOOZED (2)
  { from: 'SNOOZED', to: 'TRIAGED', guards: [], requiresApproval: false, description: 'Timer fired — re-triage' },
  { from: 'SNOOZED', to: 'CLOSED', guards: ['resolution_reason'], requiresApproval: false, description: 'Snooze fired and decided to close' },

  // From INFORMED (2)
  { from: 'INFORMED', to: 'CLOSED', guards: [], requiresApproval: false, description: 'Archived / swept from inbox' },

  // Into CANCELLED (7) — DEF-129. Reachable from every non-terminal state,
  // because the owner can withdraw a request at any point in its life. Each
  // requires a reason: a cancelled item with no explanation is indistinguishable
  // from one that was lost.
  { from: 'NEW', to: 'CANCELLED', guards: ['resolution_reason'], requiresApproval: false, description: 'Withdrawn before triage — work never started' },
  { from: 'TRIAGED', to: 'CANCELLED', guards: ['resolution_reason'], requiresApproval: false, description: 'Withdrawn after triage — work never started' },
  { from: 'IN_PROGRESS', to: 'CANCELLED', guards: ['resolution_reason'], requiresApproval: false, description: 'Abandoned mid-flight — work will not complete' },
  { from: 'DELEGATED', to: 'CANCELLED', guards: ['resolution_reason'], requiresApproval: false, description: 'Withdrawn while delegated — the delegatee is off the hook' },
  { from: 'WAITING_INFO', to: 'CANCELLED', guards: ['resolution_reason'], requiresApproval: false, description: 'Withdrawn while blocked — the answer is no longer needed' },
  { from: 'SNOOZED', to: 'CANCELLED', guards: ['resolution_reason'], requiresApproval: false, description: 'Withdrawn while deferred' },
  { from: 'INFORMED', to: 'CANCELLED', guards: ['resolution_reason'], requiresApproval: false, description: 'Informational item withdrawn' },

  // Out of CANCELLED (1) — DEF-129. The restore path. It lands on TRIAGED
  // rather than the status it left, because the world moved on while the item
  // was cancelled and its old priority is no longer trustworthy.
  { from: 'CANCELLED', to: 'TRIAGED', guards: ['is_owner_or_agent'], requiresApproval: false, description: 'Restored after cancellation — re-triage before acting' },

  // Terminal: CLOSED has no outgoing transitions. CANCELLED has exactly one.
];

/**
 * DEF-129 — the ONE definition of "no longer on the user's plate".
 *
 * Adding `CANCELLED` created a second terminal state, and every "active items"
 * query in the codebase excluded only `CLOSED` and its legacy spellings. Left
 * alone, a cancelled item would still appear in the owner's list and still be
 * chased by the risk radar, the criticality engine and the delegation tracker —
 * withdrawn work that keeps nagging.
 *
 * The legacy lowercase and `DONE`/`ARCHIVED` spellings are included because old
 * rows still carry them; `DONE` is being normalised by migration, the others
 * remain in historical data.
 */
export const INACTIVE_STATUS_VALUES: readonly string[] = [
  'CLOSED', 'closed',
  'CANCELLED', 'cancelled',
  'DONE', 'done',
  'ARCHIVED', 'archived',
] as const;

/** The same list as a SQL literal list, for the raw-SQL call sites. */
export const INACTIVE_STATUS_SQL: string = INACTIVE_STATUS_VALUES.map((s) => `'${s}'`).join(',');

export function findTransition(from: ItemStatus, to: ItemStatus): TransitionSpec | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function isValidStatus(s: unknown): s is ItemStatus {
  return typeof s === 'string' && (ALL_STATUSES as readonly string[]).includes(s);
}

export function allFromTransitions(from: ItemStatus): TransitionSpec[] {
  return TRANSITIONS.filter((t) => t.from === from);
}

/**
 * Sanity check at module load. If any contributor edits the array without
 * updating the count, boot fails loudly.
 *
 * Raised 21 -> 29 by DEF-129, deliberately and with the arithmetic stated: seven
 * transitions INTO `CANCELLED` (one from each non-terminal state) plus one back
 * out of it (`CANCELLED -> TRIAGED`). This guard did its job — it caught the
 * change on the first test run — so it is being updated with reasoning rather
 * than loosened.
 */
if (TRANSITIONS.length !== 29) {
  throw new Error(`transitionMatrix: expected 29 transitions, found ${TRANSITIONS.length}`);
}
