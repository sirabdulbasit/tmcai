/**
 * HaseebOS v15 §3.2 L2 — OpenItem lifecycle state machine.
 *
 * 8 statuses + 21 valid transitions. Anything else must be rejected at
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
  | 'CLOSED';

export const ALL_STATUSES: readonly ItemStatus[] = [
  'NEW',
  'TRIAGED',
  'IN_PROGRESS',
  'DELEGATED',
  'WAITING_INFO',
  'SNOOZED',
  'INFORMED',
  'CLOSED',
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
 * The 21 transitions. Count is exact — any change requires documenting why.
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

  // From INFORMED (1)
  { from: 'INFORMED', to: 'CLOSED', guards: [], requiresApproval: false, description: 'Archived / swept from inbox' },

  // Terminal: CLOSED has no outgoing transitions.
];

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
 * updating the count comment, boot fails loudly.
 */
if (TRANSITIONS.length !== 21) {
  throw new Error(`transitionMatrix: expected 21 transitions, found ${TRANSITIONS.length}`);
}
