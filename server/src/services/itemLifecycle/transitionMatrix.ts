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
  | 'CANCELLED'
  // DEF-236 — see the note on ALL_STATUSES. A draft is an item whose slots are not yet
  // filled; it is the START of a life, not a phase of one, so it has no way IN.
  | 'DRAFT';

export const ALL_STATUSES: readonly ItemStatus[] = [
  // DEF-236 — DRAFT was a live status the lifecycle had never heard of.
  //
  // Owner, 2026-08-20, on a red deck row: "Couldn't delete the draft item, with no reason he
  // could act on", 3 occurrences and 2 of them AFTER a fix shipped. Brain told him "one of
  // the items was a draft, and my removal process has a bug" — and it was telling the truth:
  // `isValidStatus('DRAFT')` was false, so `lifecycleService` refused every transition with
  // "current status DRAFT is not in the v15 lifecycle — migrate first". His most-repeated
  // request died on it.
  //
  // NOT a legacy row to be migrated away, which is what "migrate first" invites. DRAFT is a
  // first-class product concept: `openItemDraftAskJob` runs DAILY over exactly these items to
  // fill their missing slots over WhatsApp, and `update_open_item` is documented as
  // "typically used to complete DRAFT items by filling priority/dueDate". The gate creates
  // them deliberately. Migrating the row would have hidden the class and broken that job,
  // and the next draft would have failed identically.
  'DRAFT',
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
 * The 33 transitions. Count is exact — any change requires documenting why.
 *
 * DEF-236 added 3: exits from `DRAFT`. DEF-251 added the 4th — `DRAFT → CLOSED`, evidence-
 * guarded, because completed work was unrecordable on a draft (S23, the payroll item).
 * Nothing enters DRAFT — the gate creates items there — so there is no way in to declare.
 *
 * DEF-129 added 8: seven ways INTO `CANCELLED` (every non-terminal state) and
 * one way back out of it. `CLOSED -> CANCELLED` is deliberately absent —
 * cancelling completed work would rewrite history rather than record a decision.
 */
export const TRANSITIONS: readonly TransitionSpec[] = [
  // From DRAFT (4) — DEF-236, completed by DEF-251.
  //
  // DEF-236 said "three, and only three" — become a real item, be abandoned, or be picked
  // up directly — and the enumeration missed the fourth thing that happens to real drafts:
  // THE WORK GETS DONE while the item still sits in DRAFT. Owner, S23 (2026-08-27 07:57):
  // "I replied to Arshad on this emai" → "I wasn't able to close the item about the
  // Pakistan payroll because it's still in draft." The payroll answer existed; the record
  // could not say so, because completion had no exit from DRAFT. The same wall blocked
  // DEF-250's reconciliation close on precisely the item class most likely to be resolved
  // by a thread reply — email-derived drafts with unfilled slots.
  //
  // CANCELLED (not CLOSED) remains the ABANDON path — the DEF-129 rule stands: closing
  // unfinished work fabricates completion into the data. DRAFT → CLOSED is the opposite
  // case and carries the opposite proof: the `resolution_reason` guard demands completion
  // evidence, exactly as TRIAGED → CLOSED does. An honest abandon has no resolution to
  // state; a real completion does — the guard is the line between them.
  { from: 'DRAFT', to: 'TRIAGED', guards: [], requiresApproval: false, description: 'Slots filled — the draft became a real item (openItemDraftAskJob or update_open_item)' },
  { from: 'DRAFT', to: 'CANCELLED', guards: [], requiresApproval: false, description: 'Owner removed a draft he never completed — reversible, and never recorded as done' },
  { from: 'DRAFT', to: 'IN_PROGRESS', guards: ['is_owner_or_agent'], requiresApproval: false, description: 'Owner started work on it without completing the slots first' },
  { from: 'DRAFT', to: 'CLOSED', guards: ['resolution_reason'], requiresApproval: false, description: 'DEF-251 — the work was completed while the item was still a draft (owner said so, or a thread reply fulfilled it); evidence required, never an abandon shortcut' },
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
 *
 * DEF-236 raised it to 32: the three exits from `DRAFT`, a status the matrix had
 * never listed while `openItemDraftAskJob` ran over it daily. This guard caught
 * that change on the first test run too, exactly as designed.
 *
 * DEF-251 raised it to 33: `DRAFT → CLOSED`, evidence-guarded — completed work
 * was unrecordable on a draft (S23, the payroll item: "I wasn't able to close
 * the item… because it's still in draft" after the owner had already answered
 * it). Caught by this guard on the first run, third time in a row it has done
 * its job.
 */
if (TRANSITIONS.length !== 33) {
  throw new Error(`transitionMatrix: expected 33 transitions, found ${TRANSITIONS.length}`);
}
