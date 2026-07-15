// ═════════════════════════════════════════════════════════════════════════════
// autonomyGate — deterministic enforcement of the user's automation level.
//
// D1 (2026-07-08): automationLevel existed in schema but nothing enforced
// it — "graduated autonomy" was cosmetic. Enforcement lives HERE, in the
// executor path, as a decision table: structural, never model discretion,
// never a prompt instruction the LLM could ignore.
//
// Scope: BRAIN-INITIATED actions only. A user-initiated chain — the user
// clicked approve, gave a voice/chat instruction, or configured a standing
// action rule — is the user acting through Brain, not Brain autonomy (per
// the agreed autonomy definition, 2026-06). Gating those would break
// explicit user intent.
// ═════════════════════════════════════════════════════════════════════════════

import type { AutomationLevel } from '../brainConfigService';

export type ActionInitiator = 'user' | 'brain';

/** What the executor must do with this action. 'execute' proceeds to the
 *  validate→execute→confirm pipeline; anything else parks the AgentAction
 *  row in that status and does NOT dispatch. */
export type AutonomyDecision = 'execute' | 'proposed' | 'draft' | 'pending_approval';

export function resolveAutonomyGate(initiator: ActionInitiator, level: AutomationLevel): AutonomyDecision {
  if (initiator === 'user') return 'execute';
  switch (level) {
    case 'full_auto':   return 'execute';          // act silently, notify after
    case 'supervised':  return 'pending_approval'; // preview-then-confirm
    case 'drafts_only': return 'draft';            // create draft, never send
    case 'observe_only': return 'proposed';        // propose only, no dispatch
    default:            return 'proposed';         // unknown level → fail closed
  }
}
